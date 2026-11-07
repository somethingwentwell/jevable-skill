import { inspectRelease } from "./snapshot.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
/** Immutable snapshots. Imported creator/project fields are provenance claims, not local approvals. */
export class ReleaseStore {
    db;
    maxBytes;
    constructor(db, maxBytes) {
        this.db = db;
        this.maxBytes = maxBytes;
    }
    get(id) {
        const row = this.db.prepare('SELECT record FROM releases WHERE id=?').get(id);
        if (!row)
            throw new WorkflowRuntimeError('not-found');
        try {
            if (Buffer.byteLength(row.record) > this.maxBytes)
                throw new Error();
            const record = JSON.parse(row.record), release = inspectRelease(record.snapshot);
            if (release.snapshot.id !== id || release.sha256 !== record.sha256)
                throw new Error();
            return release;
        }
        catch {
            throw new WorkflowRuntimeError('corrupt');
        }
    }
    list() { return this.db.prepare('SELECT id FROM releases ORDER BY rowid').all().map(({ id }) => this.get(id)); }
    put(value, reuse = false) {
        const release = inspectRelease(value), encoded = JSON.stringify(release);
        if (Buffer.byteLength(encoded) > this.maxBytes)
            throw new WorkflowRuntimeError('limit');
        this.db.exec('BEGIN IMMEDIATE');
        try {
            if (this.db.prepare('SELECT id FROM releases WHERE id=?').get(release.snapshot.id)) {
                const existing = this.get(release.snapshot.id);
                if (!reuse || existing.sha256 !== release.sha256)
                    throw new WorkflowRuntimeError('conflict');
                this.db.exec('COMMIT');
                return existing;
            }
            const count = this.db.prepare('SELECT count(*) AS count FROM releases').get();
            if (count.count >= 10_000)
                throw new WorkflowRuntimeError('limit');
            this.db.prepare('INSERT INTO releases(id,record) VALUES(?,?)').run(release.snapshot.id, encoded);
            this.db.exec('COMMIT');
            return release;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
}
