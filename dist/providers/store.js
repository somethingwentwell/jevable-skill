import { connectionRecordSchema, connectionSchema, ProviderError, reference } from "./config.js";
import { credentialSchema, credentialRecordSchema, clearedCredentialSchema, modelEvidenceSchema } from "./records.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { validateModelEvidenceTransition } from "./evidence-transition.js";
/** Private tables on the runtime-owned SQLite connection; no second database or competing lock. */
export class ProviderStore {
    database;
    maxRecordBytes;
    constructor(database, maxRecordBytes) {
        this.database = database;
        this.maxRecordBytes = maxRecordBytes;
    }
    decode(value) {
        if (Buffer.byteLength(value) > this.maxRecordBytes)
            throw new WorkflowRuntimeError('limit');
        try {
            return JSON.parse(value);
        }
        catch {
            throw new ProviderError('corrupt-evidence');
        }
    }
    connection(id) {
        const row = this.database.prepare('SELECT record FROM provider_connections WHERE id=?').get(id);
        if (!row)
            return undefined;
        try {
            return connectionRecordSchema.parse(this.decode(row.record));
        }
        catch {
            throw new ProviderError('corrupt-evidence');
        }
    }
    listConnections() {
        return this.database.prepare('SELECT id FROM provider_connections ORDER BY id').all()
            .map(({ id }) => this.connection(id));
    }
    audit(kind, subject, generation, actor) {
        if (!actor.trim() || actor.length > 256)
            throw new ProviderError('invalid-config');
        this.database.prepare('INSERT INTO provider_audit(kind,subject,generation,actor,at) VALUES(?,?,?,?,?)')
            .run(kind, subject, generation, actor, new Date().toISOString());
    }
    transaction(operation) {
        this.database.exec('BEGIN IMMEDIATE');
        try {
            const result = operation();
            this.database.exec('COMMIT');
            return result;
        }
        catch (error) {
            this.database.exec('ROLLBACK');
            throw error;
        }
    }
    putConnection(value, expectedGeneration, actor) {
        const parsed = connectionSchema.safeParse(value);
        if (!parsed.success || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)
            throw new ProviderError('invalid-config');
        const connection = parsed.data;
        return this.transaction(() => {
            const current = this.connection(connection.id);
            if ((current?.generation ?? 0) !== expectedGeneration)
                throw new ProviderError('conflict');
            const count = this.database.prepare('SELECT count(*) AS count FROM provider_connections').get();
            if (!current && count.count >= 100)
                throw new WorkflowRuntimeError('limit');
            const record = { generation: expectedGeneration + 1, updatedAt: new Date().toISOString(), connection };
            this.database.prepare('INSERT INTO provider_connections(id,record) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record')
                .run(connection.id, JSON.stringify(record));
            this.audit('connection-set', connection.id, record.generation, actor);
            return record;
        });
    }
    credential(ref) {
        return this.credentialSnapshot(ref)?.value;
    }
    /** One database read pins both the secret and its generation for an admitted side effect. */
    credentialSnapshot(ref) {
        if (!reference.safeParse(ref).success)
            throw new ProviderError('invalid-config');
        const row = this.database.prepare('SELECT record FROM provider_credentials WHERE ref=?').get(ref);
        if (!row)
            return undefined;
        try {
            const record = credentialRecordSchema.parse(this.decode(row.record));
            if (record.ref !== ref)
                throw new ProviderError('corrupt-evidence');
            return 'value' in record ? { value: record.value, generation: record.generation } : undefined;
        }
        catch {
            throw new ProviderError('corrupt-evidence');
        }
    }
    credentialStatus(ref) {
        if (!reference.safeParse(ref).success)
            throw new ProviderError('invalid-config');
        const row = this.database.prepare('SELECT record FROM provider_credentials WHERE ref=?').get(ref);
        if (!row)
            return { ref, configured: false, generation: 0 };
        try {
            const record = credentialRecordSchema.parse(this.decode(row.record));
            if (record.ref !== ref)
                throw new ProviderError('corrupt-evidence');
            return { ref, configured: 'value' in record, generation: record.generation, updatedAt: record.updatedAt };
        }
        catch {
            throw new ProviderError('corrupt-evidence');
        }
    }
    setCredential(ref, value, expectedGeneration, actor) {
        const parsed = credentialSchema.safeParse({ ref, value, generation: expectedGeneration + 1, updatedAt: new Date().toISOString() });
        if (!parsed.success || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)
            throw new ProviderError('invalid-config');
        return this.transaction(() => {
            if (this.credentialStatus(ref).generation !== expectedGeneration)
                throw new ProviderError('conflict');
            const count = this.database.prepare('SELECT count(*) AS count FROM provider_credentials').get();
            if (expectedGeneration === 0 && count.count >= 1000)
                throw new WorkflowRuntimeError('limit');
            this.database.prepare('INSERT INTO provider_credentials(ref,record) VALUES(?,?) ON CONFLICT(ref) DO UPDATE SET record=excluded.record')
                .run(ref, JSON.stringify(parsed.data));
            this.audit('credential-set', ref, parsed.data.generation, actor);
            return this.credentialStatus(ref);
        });
    }
    /** Clear only an exact active generation; retained metadata is not secure physical erasure. */
    clearCredential(ref, expectedGeneration, actor) {
        if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1 || !Number.isSafeInteger(expectedGeneration + 1))
            throw new ProviderError('invalid-config');
        const parsed = clearedCredentialSchema.safeParse({ ref, generation: expectedGeneration + 1, updatedAt: new Date().toISOString(), cleared: true });
        if (!parsed.success)
            throw new ProviderError('invalid-config');
        return this.transaction(() => {
            const current = this.credentialStatus(ref);
            if (!current.configured || current.generation !== expectedGeneration)
                throw new ProviderError('conflict');
            this.database.prepare('UPDATE provider_credentials SET record=? WHERE ref=?').run(JSON.stringify(parsed.data), ref);
            this.audit('credential-cleared', ref, parsed.data.generation, actor);
            return this.credentialStatus(ref);
        });
    }
    evidence(id) {
        const row = this.database.prepare('SELECT record FROM model_calls WHERE attempt_id=?').get(id);
        if (!row)
            return undefined;
        if (Buffer.byteLength(row.record) > this.maxRecordBytes)
            throw new WorkflowRuntimeError('limit');
        try {
            return modelEvidenceSchema.parse(this.decode(row.record));
        }
        catch {
            throw new ProviderError('corrupt-evidence');
        }
    }
    /** Exact request and retry policy are immutable; only the next admitted evidence transition can commit. */
    saveEvidence(record) {
        const admitted = modelEvidenceSchema.parse(record);
        const encoded = JSON.stringify(admitted);
        if (Buffer.byteLength(encoded) > this.maxRecordBytes)
            throw new WorkflowRuntimeError('limit');
        this.transaction(() => {
            const previous = this.evidence(record.attemptId);
            validateModelEvidenceTransition(previous, admitted);
            if (!previous) {
                this.database.prepare('INSERT INTO model_calls(attempt_id,record) VALUES(?,?)').run(record.attemptId, encoded);
            }
            else {
                this.database.prepare('UPDATE model_calls SET record=? WHERE attempt_id=?').run(encoded, record.attemptId);
            }
        });
    }
    auditEvents() {
        return this.database.prepare('SELECT sequence,kind,subject,generation,actor,at FROM provider_audit ORDER BY sequence').all();
    }
}
