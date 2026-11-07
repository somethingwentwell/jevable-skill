import Client from 'pg/lib/client.js';
import { checkServerIdentity } from 'node:tls';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { admitWorkflowData } from "../workflow/index.js";
import { parsePostgresConfiguration } from "./postgres-config.js";
export { parsePostgresConfiguration } from "./postgres-config.js";
import { JournalError } from "./errors.js";
import { QueueOccupancy } from "./queue-occupancy.js";
import { TransactionStatistics } from "./transaction-statistics.js";
import { beginTransactionObservation, endTransactionObservation } from "./transaction-observation.js";
import { parseJournalConditions, checkJournalConditionTime, journalConditionHash } from "./conditions.js";
export { JournalError } from "./errors.js";
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/u);
const serial = z.string().regex(/^(0|[1-9][0-9]{0,18})$/u).refine(value => BigInt(value) <= 9223372036854775806n);
const positiveSerial = serial.refine(value => value !== '0');
const uuid = z.uuid().transform(value => value.toLowerCase());
const collection = z.enum(['runs', 'projects', 'project-deletions', 'releases', 'release-versions', 'test-cases', 'test-generations',
    'provider-connections', 'provider-credentials', 'model-calls', 'approval-deliveries', 'approval-delivery-subjects', 'access-grants',
    'test-erasures', 'test-erasure-subjects', 'approval-automatic-admissions']);
// PostgreSQL identifiers must survive UTF-8 encoding without replacement/aliasing.
const key = z.string().min(1).max(512).refine(value => !value.includes('\0') && value.isWellFormed());
const change = z.discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('put'), collection, key, expectedVersion: serial, value: z.json() }),
    z.strictObject({ operation: z.literal('delete'), collection, key, expectedVersion: serial }),
]);
// One atomic project transfer may contain the project plus the format's maximum 1,000 test drafts.
const MAX_BATCH_RECORDS = 1001;
const batchSchema = z.strictObject({ id: uuid, changes: z.array(change).min(1).max(MAX_BATCH_RECORDS),
    events: z.array(z.strictObject({ collection, key, kind: name, data: z.json() })).min(1).max(MAX_BATCH_RECORDS) });
const receiptSchema = z.strictObject({ id: uuid, requestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    ownerId: uuid, epoch: positiveSerial, recordedAt: z.string().min(1).max(64),
    changes: z.array(z.strictObject({ collection, key, version: positiveSerial, deleted: z.boolean() })).min(1).max(MAX_BATCH_RECORDS),
    eventSequences: z.array(positiveSerial).min(1).max(MAX_BATCH_RECORDS) });
const eventMetadata = z.object({ sequence: positiveSerial, batch_id: uuid, collection, key, kind: name,
    epoch: positiveSerial, at: z.string().min(1).max(64), bytes: z.number().int().nonnegative() });
const hash = (text) => createHash('sha256').update(text).digest('hex');
const lockKey = (text) => createHash('sha256').update(text).digest().readBigInt64BE().toString();
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`).join(',')}}`;
    return JSON.stringify(value);
}
/** Low-level namespace journal; typed adapters and runtime hosts own domain validation and execution. */
export class PostgresJournal {
    client;
    options;
    ownerId = randomUUID();
    epoch = '0';
    state = 'opening';
    tail = Promise.resolve();
    occupancy = new QueueOccupancy();
    transactions;
    transactionObserver;
    transactionObservationSuppression = new AsyncLocalStorage();
    closing;
    ending;
    abort = new AbortController();
    constructor(client, options) {
        this.client = client;
        this.options = options;
        client.on('error', () => this.lose());
        client.on('end', () => { if (this.state !== 'closing' && this.state !== 'closed')
            this.lose(); });
    }
    get signal() { return this.abort.signal; }
    status() { return { state: this.state, namespace: this.options.namespace, ownerId: this.ownerId, epoch: this.epoch }; }
    /** Memory-only transaction occupancy. Availability is decided by the owning runtime, not these counts. */
    queueOccupancy() { return this.occupancy.snapshot(); }
    /** Explicit diagnostics only: enabling/snapshotting never performs SQL or replays earlier transactions. */
    enableTransactionMetrics() {
        if (this.state !== 'open')
            throw new JournalError(this.state === 'lost' ? 'ownership-lost' : 'closed');
        this.transactions ??= new TransactionStatistics();
    }
    transactionMetrics() { return this.transactions?.snapshot() ?? { available: false }; }
    /** Explicit host diagnostics only. Configure while idle; never reconstruct prior transactions. */
    setTransactionObserver(observer) {
        if (this.state !== 'open')
            throw new JournalError(this.state === 'lost' ? 'ownership-lost' : 'closed');
        if (observer !== undefined && typeof observer !== 'function')
            throw new JournalError('invalid-command');
        const occupancy = this.occupancy.snapshot();
        if (occupancy.active || occupancy.waiting)
            throw new JournalError('busy');
        this.transactionObserver = observer;
    }
    /** Request-local suppression for diagnostic exporter credential reads; real SQL/statistics remain unchanged. */
    withTransactionObservationsSuppressed(work) {
        return this.transactionObservationSuppression.run(true, work);
    }
    /** Explicit endpoint/credentials, no connection string, ambient PG configuration, pooling or automatic reconnect. */
    static async open(value) {
        const options = parsePostgresConfiguration(value);
        const ca = options.tls.mode === 'verify-full' ? options.tls.ca : undefined;
        const client = new Client({ host: options.host, port: options.port, database: options.database,
            user: options.user, password: options.password, application_name: 'jevable-pg-journal/v1', client_encoding: 'UTF8',
            options: '-c search_path=pg_catalog', sslnegotiation: 'postgres',
            ssl: options.tls.mode === 'loopback-test' ? false : { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(ca ? { ca } : {}),
                // pg upgrades an existing socket without a TLS host for IP literals. Bind identity
                // verification to the reviewed host, not Node's otherwise implicit localhost.
                checkServerIdentity: (_hostname, certificate) => checkServerIdentity(options.host, certificate) },
            connectionTimeoutMillis: 5000, statement_timeout: options.statementTimeoutMs,
            query_timeout: options.statementTimeoutMs + 1000, idle_in_transaction_session_timeout: options.statementTimeoutMs + 2000,
            keepAlive: true, keepAliveInitialDelayMillis: 5000 });
        const { password: _password, ...policy } = options;
        const journal = new PostgresJournal(client, policy);
        try {
            await client.connect();
            const version = await client.query('SHOW server_version_num');
            if (Math.floor(Number(version.rows[0]?.server_version_num) / 10000) !== 17)
                throw new JournalError('version-mismatch');
            const locked = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS held', [lockKey(`jevable-journal/v1/${options.namespace}`)]);
            if (locked.rows[0]?.held !== true)
                throw new JournalError('busy');
            await client.query('BEGIN');
            try {
                if (options.initialize) {
                    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey('jevable-journal/schema/v1')]);
                    await client.query(`CREATE SCHEMA IF NOT EXISTS jevable_journal;
            CREATE TABLE IF NOT EXISTS jevable_journal.meta (namespace TEXT PRIMARY KEY, format TEXT NOT NULL, version INTEGER NOT NULL,
              epoch BIGINT NOT NULL, owner_id UUID NOT NULL);
            CREATE TABLE IF NOT EXISTS jevable_journal.records (namespace TEXT NOT NULL REFERENCES jevable_journal.meta(namespace),
              collection TEXT NOT NULL, key TEXT NOT NULL, version BIGINT NOT NULL CHECK(version>0), deleted BOOLEAN NOT NULL,
              value TEXT, PRIMARY KEY(namespace,collection,key), CHECK(deleted=(value IS NULL)));
            CREATE TABLE IF NOT EXISTS jevable_journal.batches (namespace TEXT NOT NULL REFERENCES jevable_journal.meta(namespace),
              id UUID NOT NULL, request_sha256 TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(namespace,id));
            CREATE TABLE IF NOT EXISTS jevable_journal.events (sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
              namespace TEXT NOT NULL, batch_id UUID NOT NULL, collection TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL,
              data TEXT NOT NULL, epoch BIGINT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
              FOREIGN KEY(namespace,batch_id) REFERENCES jevable_journal.batches(namespace,id));
            CREATE INDEX IF NOT EXISTS events_namespace_sequence ON jevable_journal.events(namespace,sequence);
            CREATE INDEX IF NOT EXISTS events_record_sequence ON jevable_journal.events(namespace,collection,key,sequence);`);
                    await client.query("INSERT INTO jevable_journal.meta(namespace,format,version,epoch,owner_id) VALUES($1,'jevable.pg-journal/v1',1,0,$2) ON CONFLICT DO NOTHING", [options.namespace, journal.ownerId]);
                }
                else {
                    const table = await client.query("SELECT to_regclass('jevable_journal.meta') AS present");
                    if (!table.rows[0]?.present)
                        throw new JournalError('uninitialized');
                }
                const meta = await client.query('SELECT format,version,epoch FROM jevable_journal.meta WHERE namespace=$1 FOR UPDATE', [options.namespace]);
                if (!meta.rows[0])
                    throw new JournalError('uninitialized');
                if (meta.rows[0].format !== 'jevable.pg-journal/v1' || meta.rows[0].version !== 1)
                    throw new JournalError('version-mismatch');
                if (!serial.safeParse(meta.rows[0].epoch).success)
                    throw new JournalError('corrupt');
                const acquired = await client.query('UPDATE jevable_journal.meta SET epoch=epoch+1,owner_id=$2 WHERE namespace=$1 RETURNING epoch', [options.namespace, journal.ownerId]);
                journal.epoch = acquired.rows[0].epoch;
                if (!serial.safeParse(journal.epoch).success)
                    throw new JournalError('limit');
                await client.query('COMMIT');
            }
            catch (error) {
                await client.query('ROLLBACK').catch(() => { });
                throw error;
            }
            if (journal.state === 'lost')
                throw new JournalError('unavailable');
            journal.state = 'open';
            return journal;
        }
        catch (error) {
            await journal.close();
            throw error instanceof JournalError ? error : new JournalError('unavailable');
        }
    }
    lose() {
        if (this.state === 'closed' || this.state === 'lost')
            return;
        this.state = 'lost';
        this.abort.abort(new JournalError('ownership-lost'));
        this.ending ??= this.client.end().catch(() => { });
    }
    parseJson(value, limit = this.options.maxRecordBytes) {
        try {
            if (typeof value !== 'string' || Buffer.byteLength(value) > limit)
                throw new Error();
            return admitWorkflowData(JSON.parse(value), { maxBytes: limit, maxDepth: 64, maxValues: 100_000 });
        }
        catch {
            throw new JournalError('corrupt');
        }
    }
    admit(value, limit) {
        try {
            return admitWorkflowData(value, { maxBytes: limit, maxDepth: 64, maxValues: 100_000 });
        }
        catch {
            throw new JournalError('invalid-command');
        }
    }
    enqueue(work, kind = 'read') {
        if (this.state !== 'open')
            return Promise.reject(new JournalError(this.state === 'lost' ? 'ownership-lost' : 'closed'));
        const observation = this.occupancy.admit();
        const observer = this.transactionObservationSuppression.getStore() ? undefined : this.transactionObserver;
        const result = this.tail.then(async () => {
            observation.begin();
            const transactions = this.transactions;
            let started, outcome = 'failed-before-commit';
            let transactionObservation;
            try {
                if (this.state === 'lost' || this.state === 'closed')
                    throw new JournalError('ownership-lost');
                if (transactions) {
                    try {
                        started = performance.now();
                    }
                    catch {
                        transactions.invalidate();
                    }
                }
                transactionObservation = beginTransactionObservation(observer, kind);
                let committing = false;
                try {
                    await this.client.query('BEGIN');
                    const guard = await this.client.query('SELECT owner_id,epoch FROM jevable_journal.meta WHERE namespace=$1 FOR UPDATE', [this.options.namespace]);
                    if (guard.rows[0]?.owner_id !== this.ownerId || guard.rows[0]?.epoch !== this.epoch) {
                        throw new JournalError('ownership-lost');
                    }
                    const result = await work();
                    committing = true;
                    await this.client.query('COMMIT');
                    if (this.status().state === 'lost')
                        throw new JournalError('commit-uncertain');
                    outcome = 'acknowledged';
                    return result;
                }
                catch (error) {
                    if (!committing)
                        await this.client.query('ROLLBACK').catch(() => this.lose());
                    if (committing || !(error instanceof JournalError) || error.code === 'ownership-lost' || error.code === 'corrupt')
                        this.lose();
                    if (committing) {
                        outcome = 'commit-uncertain';
                        throw new JournalError('commit-uncertain');
                    }
                    throw error instanceof JournalError ? error : new JournalError('unavailable');
                }
            }
            finally {
                observation.end();
                if (transactions && started !== undefined) {
                    try {
                        transactions.record(kind, outcome, (performance.now() - started) / 1000);
                    }
                    catch {
                        transactions.invalidate();
                    }
                }
                endTransactionObservation(transactionObservation, outcome);
            }
        });
        this.tail = result.then(() => { }, () => { });
        return result;
    }
    identity(kind, id) {
        if (!collection.safeParse(kind).success || !key.safeParse(id).success)
            throw new JournalError('invalid-command');
    }
    get(kind, id) {
        this.identity(kind, id);
        return this.enqueue(() => this.readRecord(kind, id));
    }
    /** Identity existence only; never decodes the retained payload. */
    exists(kind, id) {
        this.identity(kind, id);
        return this.enqueue(async () => (await this.client.query('SELECT 1 FROM jevable_journal.records WHERE namespace=$1 AND collection=$2 AND key=$3', [this.options.namespace, kind, id])).rows.length !== 0);
    }
    /** Internal case UUID guard; includes tombstones and normalized removal bindings without reading private payloads. */
    testCaseIdentity(id) {
        const parsed = uuid.safeParse(id);
        if (!parsed.success)
            throw new JournalError('invalid-command');
        return this.enqueue(async () => {
            const row = (await this.client.query(`SELECT
        EXISTS(SELECT 1 FROM jevable_journal.records WHERE namespace=$1 AND
          ((collection='test-cases' AND lower(key)=$2) OR (collection='test-erasure-subjects' AND key=$2))) AS retained,
        EXISTS(SELECT 1 FROM jevable_journal.records WHERE namespace=$1 AND collection='test-cases'
          AND lower(key)=$2 AND NOT deleted) AS live`, [this.options.namespace, parsed.data])).rows[0];
            if (typeof row?.retained !== 'boolean' || typeof row.live !== 'boolean' || row.live && !row.retained)
                throw new JournalError('corrupt');
            return { retained: row.retained, live: row.live };
        });
    }
    /** Internal exact caller selector. Filter in SQL before loading private run bytes, in one owner transaction. */
    callerRun(value) {
        const sha = z.string().regex(/^(?!0{64}$)[a-f0-9]{64}$/u);
        const parsed = z.strictObject({ id: uuid, grantId: uuid, release: z.strictObject({ id: uuid, sha256: sha, revision: sha }) }).safeParse(value);
        if (!parsed.success)
            throw new JournalError('invalid-command');
        const pin = parsed.data;
        return this.enqueue(async () => {
            const selected = await this.client.query(`SELECT key FROM jevable_journal.records
        WHERE namespace=$1 AND collection='runs' AND key=$2 AND NOT deleted
        AND CASE WHEN value IS JSON OBJECT THEN
          value::jsonb->>'format'='jevable.pg-run/v1'
          AND value::jsonb#>>'{record,caller,grantId}'=$3
          AND value::jsonb#>>'{record,release,id}'=$4
          AND value::jsonb#>>'{record,release,sha256}'=$5
          AND value::jsonb#>>'{record,revision}'=$6
        ELSE false END`, [this.options.namespace, pin.id, pin.grantId, pin.release.id, pin.release.sha256, pin.release.revision]);
            return selected.rows.length ? this.readRecord('runs', pin.id) : undefined;
        });
    }
    async readRecord(kind, id) {
        const result = await this.client.query('SELECT version,deleted,CASE WHEN octet_length(value)<=$4 THEN value END AS value,octet_length(value) AS bytes FROM jevable_journal.records WHERE namespace=$1 AND collection=$2 AND key=$3', [this.options.namespace, kind, id, this.options.maxRecordBytes]);
        const row = result.rows[0];
        if (!row)
            return undefined;
        if (!positiveSerial.safeParse(row.version).success || typeof row.deleted !== 'boolean'
            || (row.deleted ? row.value !== null || row.bytes !== null : !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > this.options.maxRecordBytes))
            throw new JournalError('corrupt');
        return { collection: kind, key: id, version: row.version, deleted: row.deleted,
            value: row.deleted ? null : this.parseJson(row.value) };
    }
    /** Count live records without loading private payloads, for domain capacity guards under the shared owner gate. */
    count(kind) {
        if (!collection.safeParse(kind).success)
            throw new JournalError('invalid-command');
        return this.enqueue(async () => {
            const row = (await this.client.query('SELECT count(*) AS count FROM jevable_journal.records WHERE namespace=$1 AND collection=$2 AND NOT deleted', [this.options.namespace, kind])).rows[0];
            if (!serial.safeParse(row?.count).success)
                throw new JournalError('corrupt');
            const count = Number(row.count);
            if (!Number.isSafeInteger(count) || count > this.options.maxRecords)
                throw new JournalError('limit');
            return count;
        });
    }
    /** One bounded, complete collection snapshot; never silently truncate it. */
    records(kind, limit = 1000) {
        if (!collection.safeParse(kind).success || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
            throw new JournalError('invalid-command');
        return this.enqueue(async () => {
            const rows = (await this.client.query('SELECT key,version,octet_length(value) AS bytes FROM jevable_journal.records WHERE namespace=$1 AND collection=$2 AND NOT deleted ORDER BY key COLLATE "C" LIMIT $3', [this.options.namespace, kind, limit + 1])).rows;
            if (rows.length > limit)
                throw new JournalError('limit');
            return this.readRows(kind, rows);
        });
    }
    /** Keyset page of live records. Each page is a transaction, not a cross-page snapshot. */
    page(kind, after, limit = 100) {
        if (!collection.safeParse(kind).success || (after !== undefined && !key.safeParse(after).success)
            || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
            throw new JournalError('invalid-command');
        return this.enqueue(async () => {
            const rows = (await this.client.query('SELECT key,version,octet_length(value) AS bytes FROM jevable_journal.records WHERE namespace=$1 AND collection=$2 AND NOT deleted AND ($3::text IS NULL OR key COLLATE "C">$3::text COLLATE "C") ORDER BY key COLLATE "C" LIMIT $4', [this.options.namespace, kind, after ?? null, limit + 1])).rows;
            const selected = rows.slice(0, limit), records = await this.readRows(kind, selected);
            return { records, nextCursor: rows.length > limit ? records.at(-1).key : null };
        });
    }
    async readRows(kind, rows) {
        let bytes = 0;
        for (const row of rows) {
            if (!key.safeParse(row.key).success || !positiveSerial.safeParse(row.version).success || !Number.isSafeInteger(row.bytes) || row.bytes < 0)
                throw new JournalError('corrupt');
            bytes += row.bytes;
            if (row.bytes > this.options.maxRecordBytes || bytes > this.options.maxBatchBytes)
                throw new JournalError('limit');
        }
        const records = [];
        for (const row of rows) {
            const record = await this.readRecord(kind, row.key);
            if (!record || record.deleted || record.version !== row.version)
                throw new JournalError('corrupt');
            records.push(record);
        }
        return records;
    }
    receipt(id) {
        const parsed = uuid.safeParse(id);
        if (!parsed.success)
            throw new JournalError('invalid-command');
        return this.enqueue(() => this.readReceipt(parsed.data));
    }
    async readReceipt(id) {
        const row = (await this.client.query('SELECT CASE WHEN octet_length(receipt)<=$3 THEN receipt END AS receipt,request_sha256 FROM jevable_journal.batches WHERE namespace=$1 AND id=$2', [this.options.namespace, id, this.options.maxBatchBytes])).rows[0];
        if (!row)
            return undefined;
        const parsed = receiptSchema.safeParse(this.parseJson(row.receipt, this.options.maxBatchBytes));
        if (!parsed.success || parsed.data.id !== id || parsed.data.requestSha256 !== row.request_sha256)
            throw new JournalError('corrupt');
        return parsed.data;
    }
    /** A stable batch UUID identifies one atomic mutation set plus its evidence, not an external-effect retry. */
    commit(value, guard) {
        // Guards are live admission requirements, not mutation identity. They apply even to retained receipt reads.
        const conditions = guard === undefined ? undefined : parseJournalConditions(guard);
        const parsed = batchSchema.safeParse(this.admit(value, this.options.maxBatchBytes));
        if (!parsed.success)
            throw new JournalError('invalid-command');
        const batch = parsed.data, encoded = canonical(batch), digest = hash(encoded);
        const keys = batch.changes.map(change => JSON.stringify([change.collection, change.key]));
        if (new Set(keys).size !== keys.length || batch.events.some(event => !keys.includes(JSON.stringify([event.collection, event.key]))))
            throw new JournalError('invalid-command');
        for (const change of batch.changes)
            if (change.operation === 'put' && Buffer.byteLength(canonical(change.value)) > this.options.maxRecordBytes)
                throw new JournalError('limit');
        for (const event of batch.events)
            if (Buffer.byteLength(canonical(event.data)) > this.options.maxRecordBytes)
                throw new JournalError('limit');
        return this.enqueue(async () => {
            if (conditions) {
                // This transaction holds the namespace owner row lock: no same-namespace grant/target write can interleave.
                for (const condition of conditions.records) {
                    const current = await this.readRecord(condition.collection, condition.key);
                    if (!current || current.deleted || current.version !== condition.version || journalConditionHash(current.value) !== condition.sha256)
                        throw new JournalError('conflict');
                }
                checkJournalConditionTime(conditions);
            }
            const previous = await this.readReceipt(batch.id);
            if (previous) {
                if (previous.requestSha256 !== digest)
                    throw new JournalError('conflict');
                if (conditions)
                    checkJournalConditionTime(conditions);
                return previous;
            }
            const counts = (await this.client.query(`SELECT
        (SELECT count(*)::int FROM jevable_journal.records WHERE namespace=$1) AS records,
        (SELECT count(*)::int FROM jevable_journal.events WHERE namespace=$1) AS events,
        (SELECT count(*)::int FROM jevable_journal.batches WHERE namespace=$1) AS batches`, [this.options.namespace])).rows[0];
            if (counts.batches >= this.options.maxBatches || counts.events + batch.events.length > this.options.maxEvents)
                throw new JournalError('limit');
            if (conditions)
                checkJournalConditionTime(conditions);
            let newRecords = 0;
            const changes = [];
            for (const change of batch.changes) {
                const row = (await this.client.query('SELECT version,deleted FROM jevable_journal.records WHERE namespace=$1 AND collection=$2 AND key=$3', [this.options.namespace, change.collection, change.key])).rows[0];
                if ((row?.version ?? '0') !== change.expectedVersion || (change.operation === 'delete' && (!row || row.deleted)))
                    throw new JournalError('conflict');
                if (!row)
                    newRecords++;
                const version = (BigInt(change.expectedVersion) + 1n).toString();
                if (!serial.safeParse(version).success)
                    throw new JournalError('limit');
                // Recheck after the last asynchronous validation preceding the first mutation.
                if (conditions && changes.length === 0)
                    checkJournalConditionTime(conditions);
                await this.client.query(`INSERT INTO jevable_journal.records(namespace,collection,key,version,deleted,value) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(namespace,collection,key) DO UPDATE SET version=EXCLUDED.version,deleted=EXCLUDED.deleted,value=EXCLUDED.value`, 
                // Canonicalization belongs to batch retry identity, not domain payloads: nested JSON key order
                // participates in existing checkpoint/test hashes and must survive storage unchanged.
                [this.options.namespace, change.collection, change.key, version, change.operation === 'delete', change.operation === 'put' ? JSON.stringify(change.value) : null]);
                changes.push({ collection: change.collection, key: change.key, version, deleted: change.operation === 'delete' });
            }
            if (counts.records + newRecords > this.options.maxRecords)
                throw new JournalError('limit');
            await this.client.query('INSERT INTO jevable_journal.batches(namespace,id,request_sha256,receipt) VALUES($1,$2,$3,$4)', [this.options.namespace, batch.id, digest, '{}']);
            const sequences = [];
            for (const event of batch.events) {
                const result = await this.client.query('INSERT INTO jevable_journal.events(namespace,batch_id,collection,key,kind,data,epoch) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING sequence', [this.options.namespace, batch.id, event.collection, event.key, event.kind, JSON.stringify(event.data), this.epoch]);
                sequences.push(result.rows[0].sequence);
            }
            const at = (await this.client.query('SELECT clock_timestamp()::text AS at')).rows[0].at;
            const receipt = { id: batch.id, requestSha256: digest, ownerId: this.ownerId, epoch: this.epoch,
                recordedAt: at, changes, eventSequences: sequences };
            if (!receiptSchema.safeParse(receipt).success)
                throw new JournalError('corrupt');
            await this.client.query('UPDATE jevable_journal.batches SET receipt=$3 WHERE namespace=$1 AND id=$2', [this.options.namespace, batch.id, JSON.stringify(receipt)]);
            return receipt;
        }, 'write');
    }
    events(after = '0', limit = 100, kinds, recordKey) {
        if (!serial.safeParse(after).success || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
            throw new JournalError('invalid-command');
        const selected = kinds === undefined ? null : z.array(collection).min(1).max(9).safeParse(kinds);
        if (selected && !selected.success)
            throw new JournalError('invalid-command');
        if (recordKey !== undefined && (!key.safeParse(recordKey).success || !selected || selected.data?.length !== 1))
            throw new JournalError('invalid-command');
        return this.enqueue(async () => {
            const rows = (await this.client.query(`SELECT sequence,batch_id,collection,key,kind,epoch,at::text,octet_length(data) AS bytes
        FROM jevable_journal.events WHERE namespace=$1 AND sequence>$2 AND ($4::text[] IS NULL OR collection=ANY($4)) AND ($5::text IS NULL OR key=$5) ORDER BY sequence LIMIT $3`, [this.options.namespace, after, limit, selected?.data ?? null, recordKey ?? null])).rows;
            let bytes = 0;
            for (const row of rows) {
                if (!eventMetadata.safeParse(row).success)
                    throw new JournalError('corrupt');
                bytes += row.bytes;
                if (row.bytes > this.options.maxRecordBytes || bytes > this.options.maxBatchBytes)
                    throw new JournalError('limit');
            }
            const events = [];
            for (const row of rows) {
                const result = await this.client.query('SELECT CASE WHEN octet_length(data)<=$3 THEN data END AS data FROM jevable_journal.events WHERE namespace=$1 AND sequence=$2', [this.options.namespace, row.sequence, this.options.maxRecordBytes]);
                events.push({ sequence: row.sequence, batchId: row.batch_id, collection: row.collection,
                    key: row.key, kind: row.kind, epoch: row.epoch, at: row.at, data: this.parseJson(result.rows[0]?.data) });
            }
            return { events, cursor: events.at(-1)?.sequence ?? after };
        });
    }
    health() { return this.enqueue(async () => ({ ...this.status(), database: 'reachable' })); }
    /** Drain already admitted transactions, then release ownership by ending this exact connection. */
    close() {
        if (this.closing)
            return this.closing;
        if (this.state !== 'lost')
            this.state = 'closing';
        this.abort.abort(new JournalError('closed'));
        this.closing = (async () => {
            await this.tail;
            this.ending ??= this.client.end().catch(() => { });
            await this.ending;
            this.state = 'closed';
        })();
        return this.closing;
    }
}
