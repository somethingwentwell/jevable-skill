import { z } from 'zod';
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { vendorImportCommandSchema } from "./vendor-import.js";
import { activityProject } from "../runtime/activity.js";
import { ProjectLedger, deleteCommandSchema, deletionSchema } from "./ledger.js";
export { projectCommandSchema, approvalChanges } from "./ledger.js";
/** SQLite persistence around the backend-independent project review ledger. */
export class ProjectStore {
    db;
    ledger;
    constructor(db, limits, maxRecordBytes) {
        this.db = db;
        this.ledger = new ProjectLedger(limits, maxRecordBytes);
    }
    read(id) {
        if (!z.uuid().safeParse(id).success)
            throw new WorkflowRuntimeError('invalid-command');
        const row = this.db.prepare('SELECT generation,record FROM projects WHERE id=?').get(id);
        if (!row)
            throw new WorkflowRuntimeError('not-found');
        return this.ledger.decode(row.record, id, row.generation);
    }
    get(id, generation) { return this.ledger.replay(this.read(id), generation); }
    diff(id, from, to) { return this.ledger.diff(this.read(id), from, to); }
    export(id, expectedGeneration, reviewedRevision, history = false, tests) {
        return this.ledger.export(this.read(id), expectedGeneration, reviewedRevision, history, tests);
    }
    inspectImport(json) { return this.ledger.inspectImport(json); }
    vendorImport(id, inspect = false) {
        if (!z.uuid().safeParse(id).success)
            throw new WorkflowRuntimeError('invalid-command');
        return this.ledger.vendorImport(this.read(id.toLowerCase()), inspect);
    }
    createVendorImport(value) {
        const parsed = vendorImportCommandSchema.safeParse(value);
        if (!parsed.success)
            throw new WorkflowRuntimeError('invalid-command');
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const exists = this.db.prepare('SELECT id FROM projects WHERE lower(id)=?').get(parsed.data.id);
            if (!exists && this.db.prepare('SELECT id FROM project_deletions WHERE lower(id)=?').get(parsed.data.id))
                throw new WorkflowRuntimeError('conflict');
            const result = this.ledger.createVendorImport(parsed.data, exists ? this.read(exists.id) : undefined);
            if (!result.replayed) {
                this.createSlot(result.record.id);
                this.save(result.record);
            }
            this.db.exec('COMMIT');
            return result.project;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    createSlot(id) {
        if (this.db.prepare('SELECT count(*) AS count FROM projects').get().count >= 1000)
            throw new WorkflowRuntimeError('limit');
        if (this.db.prepare('SELECT id FROM projects WHERE id=? UNION ALL SELECT id FROM project_deletions WHERE id=?').get(id, id))
            throw new WorkflowRuntimeError('conflict');
    }
    save(record) {
        this.db.prepare('INSERT INTO projects(id,generation,record) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,record=excluded.record')
            .run(record.id, record.changes.length, JSON.stringify(record));
    }
    import(json, reviewedSha256, actor, newId, importTests) {
        const { record, project } = this.ledger.prepareImport(json, reviewedSha256, actor, newId, Boolean(importTests));
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.createSlot(record.id);
            this.save(record);
            importTests?.(project);
            this.db.exec('COMMIT');
            return project;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    list() {
        return this.db.prepare('SELECT id FROM projects ORDER BY rowid').all().map(({ id }) => {
            const { revisions: _r, proposals: _p, changes: _c, ...summary } = this.get(id);
            return summary;
        });
    }
    /** Private metadata projection for the runtime's optimistic coherent activity read. */
    activity() {
        return this.db.prepare('SELECT id FROM projects ORDER BY id').all().map(({ id }) => {
            const record = this.read(id);
            return activityProject(this.ledger.replay(record), Boolean(record.vendorImport));
        });
    }
    deletions() {
        return this.db.prepare('SELECT id,record FROM project_deletions ORDER BY rowid').all().map(row => {
            try {
                if (Buffer.byteLength(row.record) > 4096)
                    throw new Error();
                const receipt = deletionSchema.parse(JSON.parse(row.record));
                if (receipt.id !== row.id || this.db.prepare('SELECT id FROM projects WHERE id=?').get(row.id))
                    throw new Error();
                return receipt;
            }
            catch {
                throw new WorkflowRuntimeError('corrupt');
            }
        });
    }
    /** No cascade: every linked run, including completed runs, retains its project evidence. */
    deleteArchived(value) {
        const parsed = deleteCommandSchema.safeParse(value);
        if (!parsed.success)
            throw new WorkflowRuntimeError('invalid-command');
        const command = parsed.data;
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const project = this.get(command.id);
            if (project.generation !== command.expectedGeneration || !project.archived)
                throw new WorkflowRuntimeError('conflict');
            const linked = this.db.prepare("SELECT id FROM runs WHERE json_extract(record, '$.project.id')=? LIMIT 1").get(command.id);
            if (linked)
                throw new WorkflowRuntimeError('referenced');
            const count = this.db.prepare('SELECT count(*) AS count FROM project_deletions').get();
            if (count.count >= 10_000)
                throw new WorkflowRuntimeError('limit');
            const now = new Date().toISOString();
            const receipt = { schemaVersion: 1, id: project.id, generation: project.generation,
                revision: project.acceptedRevision, actor: command.actor, at: now < project.updatedAt ? project.updatedAt : now, status: 'deleted' };
            this.db.prepare('INSERT INTO project_deletions(id,record) VALUES(?,?)').run(project.id, JSON.stringify(receipt));
            const result = this.db.prepare('DELETE FROM projects WHERE id=? AND generation=?').run(project.id, project.generation);
            if (result.changes !== 1)
                throw new WorkflowRuntimeError('conflict');
            this.db.exec('COMMIT');
            return receipt;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    execute(value) {
        const command = this.ledger.command(value);
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const before = command.operation === 'create' ? undefined : this.read(command.id);
            const { record, project } = this.ledger.apply(command, before);
            if (command.operation === 'create' || command.operation === 'duplicate')
                this.createSlot(record.id);
            this.save(record);
            this.db.exec('COMMIT');
            return project;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
}
