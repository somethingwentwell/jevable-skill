import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { JournalError } from "../storage/postgres.js";
import { admitWorkflowData } from "../workflow/index.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { connectionRecordSchema, connectionSchema, reference, ProviderError } from "./config.js";
import { credentialSchema, credentialRecordSchema, clearedCredentialSchema, modelEvidenceSchema } from "./records.js";
import { withDomainWrite } from "../storage/domain-owner.js";
import { modelEvidenceVersion, validateModelEvidenceTransition } from "./evidence-transition.js";
const actorSchema = z.string().min(1).max(256).refine(value => Boolean(value.trim()));
const auditSchema = z.strictObject({ subject: reference, generation: z.number().int().positive(), actor: actorSchema, at: z.iso.datetime() });
/** Domain-validated PostgreSQL credentials, provider configuration and immutable model evidence. */
export class PostgresProviderStore {
    journal;
    maxRecordBytes;
    constructor(journal, maxRecordBytes = 4_000_000) {
        this.journal = journal;
        this.maxRecordBytes = maxRecordBytes;
        if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1024 || maxRecordBytes > 16_000_000)
            throw new ProviderError('invalid-config');
    }
    get signal() { return this.journal.signal; }
    parse(schema, value, corrupt = false) {
        try {
            const admitted = admitWorkflowData(value, { maxBytes: this.maxRecordBytes, maxDepth: 64, maxValues: 100_000 });
            return schema.parse(admitted);
        }
        catch {
            throw new ProviderError(corrupt ? 'corrupt-evidence' : 'invalid-config');
        }
    }
    ref(value) { if (!reference.safeParse(value).success)
        throw new ProviderError('invalid-config'); }
    generation(value, actor) {
        if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(value + 1) || !actorSchema.safeParse(actor).success)
            throw new ProviderError('invalid-config');
    }
    mutate(work) {
        return withDomainWrite(this.journal, async () => {
            try {
                return await work();
            }
            catch (error) {
                if (error instanceof JournalError && error.code === 'conflict')
                    throw new ProviderError('conflict');
                throw error;
            }
        });
    }
    async row(kind, key) {
        const row = await this.journal.get(kind, key);
        if (row?.deleted)
            throw new ProviderError('corrupt-evidence');
        return row;
    }
    connectionRecord(row) {
        const record = this.parse(connectionRecordSchema, row.value, true);
        if (record.connection.id !== row.key || String(record.generation) !== row.version)
            throw new ProviderError('corrupt-evidence');
        return record;
    }
    async connection(id) {
        this.ref(id);
        const row = await this.row('provider-connections', id);
        return row ? this.connectionRecord(row) : undefined;
    }
    async listConnections() {
        return (await this.journal.records('provider-connections', 100)).map(row => this.connectionRecord(row));
    }
    putConnection(value, expectedGeneration, actor) {
        const connection = this.parse(connectionSchema, value);
        this.generation(expectedGeneration, actor);
        return this.mutate(async () => {
            const current = await this.connection(connection.id);
            if ((current?.generation ?? 0) !== expectedGeneration)
                throw new ProviderError('conflict');
            if (!current && await this.journal.count('provider-connections') >= 100)
                throw new WorkflowRuntimeError('limit');
            const record = { generation: expectedGeneration + 1, updatedAt: new Date().toISOString(), connection };
            await this.journal.commit({ id: randomUUID(), changes: [{ operation: 'put', collection: 'provider-connections', key: connection.id,
                        expectedVersion: String(expectedGeneration), value: z.json().parse(JSON.parse(JSON.stringify(record))) }], events: [{ collection: 'provider-connections', key: connection.id,
                        kind: 'connection-set', data: { subject: connection.id, generation: record.generation, actor, at: record.updatedAt } }] });
            return record;
        });
    }
    async credentialRecord(ref) {
        this.ref(ref);
        const row = await this.row('provider-credentials', ref);
        if (!row)
            return undefined;
        const record = this.parse(credentialRecordSchema, row.value, true);
        if (record.ref !== ref || String(record.generation) !== row.version)
            throw new ProviderError('corrupt-evidence');
        return record;
    }
    async credential(ref) { return (await this.credentialSnapshot(ref))?.value; }
    async credentialSnapshot(ref) {
        const record = await this.credentialRecord(ref);
        return record && 'value' in record ? { value: record.value, generation: record.generation } : undefined;
    }
    async credentialStatus(ref) {
        const record = await this.credentialRecord(ref);
        return record ? { ref, configured: 'value' in record, generation: record.generation, updatedAt: record.updatedAt } : { ref, configured: false, generation: 0 };
    }
    setCredential(ref, value, expectedGeneration, actor) {
        this.generation(expectedGeneration, actor);
        const admitted = this.parse(credentialSchema, { ref, value, generation: expectedGeneration + 1, updatedAt: new Date().toISOString() });
        return this.mutate(async () => {
            const current = await this.credentialRecord(ref);
            if ((current?.generation ?? 0) !== expectedGeneration)
                throw new ProviderError('conflict');
            if (!current && await this.journal.count('provider-credentials') >= 1000)
                throw new WorkflowRuntimeError('limit');
            const record = { ...admitted, updatedAt: new Date().toISOString() };
            await this.journal.commit({ id: randomUUID(), changes: [{ operation: 'put', collection: 'provider-credentials', key: ref,
                        expectedVersion: String(expectedGeneration), value: record }], events: [{ collection: 'provider-credentials', key: ref,
                        kind: 'credential-set', data: { subject: ref, generation: record.generation, actor, at: record.updatedAt } }] });
            return { ref, configured: true, generation: record.generation, updatedAt: record.updatedAt };
        });
    }
    /** Retain a secret-free generation atomically with the metadata-only audit event. */
    clearCredential(ref, expectedGeneration, actor) {
        this.generation(expectedGeneration, actor);
        if (expectedGeneration < 1)
            throw new ProviderError('invalid-config');
        const record = this.parse(clearedCredentialSchema, { ref, generation: expectedGeneration + 1,
            updatedAt: new Date().toISOString(), cleared: true });
        return this.mutate(async () => {
            const current = await this.credentialRecord(ref);
            if (!current || !('value' in current) || current.generation !== expectedGeneration)
                throw new ProviderError('conflict');
            await this.journal.commit({ id: randomUUID(), changes: [{ operation: 'put', collection: 'provider-credentials', key: ref,
                        expectedVersion: String(expectedGeneration), value: record }], events: [{ collection: 'provider-credentials', key: ref,
                        kind: 'credential-cleared', data: { subject: ref, generation: record.generation, actor, at: record.updatedAt } }] });
            return { ref, configured: false, generation: record.generation, updatedAt: record.updatedAt };
        });
    }
    id(value) {
        if (!z.uuid().safeParse(value).success)
            throw new ProviderError('invalid-config');
        return value.toLowerCase();
    }
    async evidence(id) {
        const key = this.id(id), row = await this.row('model-calls', key);
        if (!row)
            return undefined;
        const record = this.parse(modelEvidenceSchema, row.value, true);
        if (record.attemptId !== key || row.version !== String(modelEvidenceVersion(record)))
            throw new ProviderError('corrupt-evidence');
        return record;
    }
    saveEvidence(value) {
        const parsed = this.parse(modelEvidenceSchema, value), admitted = { ...parsed, attemptId: this.id(parsed.attemptId) };
        return this.mutate(async () => {
            const previous = await this.evidence(admitted.attemptId);
            validateModelEvidenceTransition(previous, admitted);
            await this.journal.commit({ id: randomUUID(), changes: [{ operation: 'put', collection: 'model-calls', key: admitted.attemptId,
                        expectedVersion: previous ? String(modelEvidenceVersion(previous)) : '0', value: z.json().parse(admitted) }], events: [{ collection: 'model-calls', key: admitted.attemptId,
                        kind: !previous ? 'model-requested' : admitted.result.status === 'pending' ? 'model-retry-progress' : 'model-settled',
                        data: { attemptId: admitted.attemptId, status: admitted.result.status,
                            ...(admitted.schemaVersion === 2 ? { try: admitted.tries.length, version: modelEvidenceVersion(admitted) } : {}) } }] });
        });
    }
    async auditEvents(after = '0', limit = 100) {
        const page = await this.journal.events(after, limit, ['provider-connections', 'provider-credentials']);
        return { cursor: page.cursor, events: page.events.map(event => {
                const data = this.parse(auditSchema, event.data, true);
                if (data.subject !== event.key || !(event.collection === 'provider-connections' ? ['connection-set'] : ['credential-set', 'credential-cleared']).includes(event.kind))
                    throw new ProviderError('corrupt-evidence');
                return { sequence: event.sequence, kind: event.kind, ...data };
            }) };
    }
}
