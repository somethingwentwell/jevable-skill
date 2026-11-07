import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { JournalError } from "../storage/postgres.js";
import { withDomainWrite } from "../storage/domain-owner.js";
import { PostgresProjectStore } from "../projects/postgres-store.js";
import { DEFAULT_COMPILER_LIMITS } from "../limits.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { inspectRelease, releaseSnapshotSchema, releaseCreateCommandSchema } from "./snapshot.js";
const storedRelease = z.strictObject({ format: z.literal('jevable.pg-release/v1'), snapshot: releaseSnapshotSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
const versionIndex = z.strictObject({ format: z.literal('jevable.pg-release-version/v1'), projectId: z.uuid(),
    version: releaseSnapshotSchema.shape.version, firstReleaseId: z.uuid() });
const indexKey = (release) => `${release.snapshot.project.id}/${release.snapshot.version}`;
/** Immutable releases; local review creation and external provenance import are distinct operations. */
export class PostgresReleaseStore {
    journal;
    maxRecordBytes;
    projects;
    constructor(journal, maxRecordBytes = 4_000_000) {
        this.journal = journal;
        this.maxRecordBytes = maxRecordBytes;
        if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1024 || maxRecordBytes > 16_000_000)
            throw new WorkflowRuntimeError('invalid-command');
        this.projects = new PostgresProjectStore(journal, DEFAULT_COMPILER_LIMITS.source, maxRecordBytes);
    }
    decode(row) {
        try {
            const record = storedRelease.parse(row.value), release = inspectRelease(record.snapshot);
            if (row.version !== '1' || release.snapshot.id !== row.key || release.sha256 !== record.sha256
                || Buffer.byteLength(JSON.stringify(record)) > this.maxRecordBytes)
                throw new Error();
            return release;
        }
        catch {
            throw new WorkflowRuntimeError('corrupt');
        }
    }
    async read(id) {
        if (!z.uuid().safeParse(id).success)
            throw new WorkflowRuntimeError('invalid-command');
        const row = await this.journal.get('releases', id);
        if (!row || row.deleted)
            throw new WorkflowRuntimeError('not-found');
        return this.decode(row);
    }
    async index(release) {
        const row = await this.journal.get('release-versions', indexKey(release));
        if (!row)
            return undefined;
        const parsed = versionIndex.safeParse(row.value);
        if (row.deleted || row.version !== '1' || !parsed.success || parsed.data.projectId !== release.snapshot.project.id
            || parsed.data.version !== release.snapshot.version)
            throw new WorkflowRuntimeError('corrupt');
        let first;
        try {
            first = await this.read(parsed.data.firstReleaseId);
        }
        catch (error) {
            if (error instanceof WorkflowRuntimeError && error.code === 'not-found')
                throw new WorkflowRuntimeError('corrupt');
            throw error;
        }
        if (indexKey(first) !== indexKey(release))
            throw new WorkflowRuntimeError('corrupt');
        return parsed.data;
    }
    async get(id) {
        const release = await this.read(id);
        if (!await this.index(release))
            throw new WorkflowRuntimeError('corrupt');
        return release;
    }
    async list(after, limit = 100) {
        const page = await this.journal.page('releases', after, limit);
        const releases = [];
        for (const row of page.records) {
            const release = this.decode(row);
            if (!await this.index(release))
                throw new WorkflowRuntimeError('corrupt');
            releases.push(release);
        }
        return { releases, nextCursor: page.nextCursor };
    }
    mutate(work) {
        return withDomainWrite(this.journal, async () => {
            try {
                return await work();
            }
            catch (error) {
                if (error instanceof JournalError && error.code === 'conflict')
                    throw new WorkflowRuntimeError('conflict');
                throw error;
            }
        });
    }
    admit(value) {
        const release = inspectRelease(value);
        if (Buffer.byteLength(JSON.stringify({ format: 'jevable.pg-release/v1', ...release })) > this.maxRecordBytes)
            throw new WorkflowRuntimeError('limit');
        return release;
    }
    async save(release, reuse, local) {
        const existing = await this.journal.get('releases', release.snapshot.id);
        if (existing) {
            if (existing.deleted)
                throw new WorkflowRuntimeError('conflict');
            const saved = await this.get(release.snapshot.id);
            if (!reuse || saved.sha256 !== release.sha256)
                throw new WorkflowRuntimeError('conflict');
            return saved;
        }
        if (await this.journal.count('releases') >= 10_000)
            throw new WorkflowRuntimeError('limit');
        const index = await this.index(release);
        if (local && index)
            throw new WorkflowRuntimeError('conflict');
        const changes = [{ operation: 'put', collection: 'releases', key: release.snapshot.id,
                expectedVersion: '0', value: z.json().parse({ format: 'jevable.pg-release/v1', ...release }) }];
        if (!index)
            changes.push({ operation: 'put', collection: 'release-versions', key: indexKey(release), expectedVersion: '0',
                value: { format: 'jevable.pg-release-version/v1', projectId: release.snapshot.project.id,
                    version: release.snapshot.version, firstReleaseId: release.snapshot.id } });
        await this.journal.commit({ id: randomUUID(), changes, events: [{ collection: 'releases', key: release.snapshot.id,
                    kind: local ? 'release-created' : 'release-imported', data: { releaseId: release.snapshot.id, sha256: release.sha256,
                        projectId: release.snapshot.project.id, projectGeneration: release.snapshot.project.generation,
                        revision: release.snapshot.workflow.revision, version: release.snapshot.version,
                        creator: release.snapshot.createdBy, provenance: local ? 'local-review' : 'external-claim' } }] });
        return release;
    }
    create(value) {
        const parsed = releaseCreateCommandSchema.safeParse(value);
        if (!parsed.success)
            throw new WorkflowRuntimeError('invalid-command');
        const command = parsed.data;
        return this.mutate(async () => {
            const project = await this.projects.get(command.projectId);
            if (project.archived)
                throw new WorkflowRuntimeError('archived');
            if (project.generation !== command.expectedGeneration || project.acceptedRevision !== command.revision)
                throw new WorkflowRuntimeError('conflict');
            const release = this.admit({ format: 'jevable.ai/release', schemaVersion: 1, id: command.id ?? randomUUID(),
                version: command.version, createdAt: new Date().toISOString(), createdBy: command.actor,
                project: { id: project.id, generation: project.generation },
                workflow: project.revisions.find(item => item.revision === command.revision), runtime: command.runtime,
                ...(command.notes === undefined ? {} : { notes: command.notes }) });
            return this.save(release, false, true);
        });
    }
    /** Import an executable snapshot, not an approval. Origin project/creator fields remain external claims. */
    put(value, reuse = false) {
        if (typeof reuse !== 'boolean')
            throw new WorkflowRuntimeError('invalid-command');
        const release = this.admit(value);
        return this.mutate(() => this.save(release, reuse, false));
    }
}
