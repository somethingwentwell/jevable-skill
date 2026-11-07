import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { inspectNotificationRecord } from "./schema.js";
import { validateNotificationIntent, validateNotificationSettlement } from "./transitions.js";
import { parseNotificationPage } from "./history.js";
/** Called only inside the owning runtime's explicit schema-initialization transaction. No independent connection/owner. */
export function initializeNotificationTables(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS approval_deliveries (
    id TEXT PRIMARY KEY, event_sha256 TEXT NOT NULL, endpoint_id TEXT NOT NULL, record TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS approval_delivery_subject ON approval_deliveries(event_sha256, endpoint_id);
  CREATE TABLE IF NOT EXISTS approval_delivery_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id TEXT NOT NULL REFERENCES approval_deliveries(id),
    kind TEXT NOT NULL, record TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS approval_delivery_history ON approval_delivery_events(delivery_id, sequence);`);
}
const policySchema = z.strictObject({ maxDeliveries: z.number().int().min(1).max(100000), maxEvents: z.number().int().min(2).max(200000) });
/** The caller must exclusively own this database and use one dispatcher. This store never acquires, closes or repairs an owner. */
export class SQLiteNotificationStore {
    db;
    policy;
    constructor(db, policy) {
        this.db = db;
        const parsed = policySchema.safeParse(policy);
        if (!parsed.success)
            throw new WorkflowRuntimeError('invalid-command');
        this.policy = parsed.data;
        this.validate();
    }
    decode(encoded) {
        if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 65536)
            throw new WorkflowRuntimeError('corrupt');
        let value;
        try {
            value = JSON.parse(encoded);
        }
        catch {
            throw new WorkflowRuntimeError('corrupt');
        }
        return inspectNotificationRecord(value);
    }
    decodeRow(row) {
        const record = this.decode(row.record);
        if (row.id !== record.request.requestId || row.event_sha256 !== record.request.eventSha256
            || row.endpoint_id !== record.request.endpointId)
            throw new WorkflowRuntimeError('corrupt');
        return record;
    }
    get(id) {
        if (!z.uuid().safeParse(id).success)
            throw new WorkflowRuntimeError('invalid-command');
        const row = this.db.prepare('SELECT id,event_sha256,endpoint_id,record FROM approval_deliveries WHERE id=?').get(id);
        return row ? this.decodeRow(row) : undefined;
    }
    page(value) {
        const { after, limit, filter } = parseNotificationPage(value);
        if (filter !== undefined)
            throw new WorkflowRuntimeError('invalid-command');
        if (after !== undefined && !this.get(after))
            throw new WorkflowRuntimeError('not-found');
        // Immutable UUID keyset uses the existing primary-key index; no full-history materialization or offset scan.
        const rows = (after === undefined
            ? this.db.prepare('SELECT id,event_sha256,endpoint_id,record FROM approval_deliveries ORDER BY id LIMIT ?').all(limit + 1)
            : this.db.prepare('SELECT id,event_sha256,endpoint_id,record FROM approval_deliveries WHERE id>? ORDER BY id LIMIT ?').all(after, limit + 1));
        const records = rows.slice(0, limit).map(row => this.decodeRow(row));
        return { records, nextCursor: rows.length > limit ? records.at(-1).request.requestId : null };
    }
    count(table) {
        return this.db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
    }
    atomic(work) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = work();
            this.db.exec('COMMIT');
            return result;
        }
        catch (error) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch { /* A lost/committed acknowledgement must preserve the original uncertainty. */ }
            throw error;
        }
    }
    createIntent(value) {
        const record = inspectNotificationRecord(value);
        return this.atomic(() => {
            if (this.get(record.request.requestId))
                return false;
            const row = this.db.prepare(`SELECT id,event_sha256,endpoint_id,record FROM approval_deliveries
        WHERE event_sha256=? AND endpoint_id=? ORDER BY rowid DESC LIMIT 1`)
                .get(record.request.eventSha256, record.request.endpointId);
            validateNotificationIntent(record, row ? this.decodeRow(row) : undefined);
            // Reserve both intent and settlement capacity before permitting any dispatch.
            if (this.count('approval_deliveries') >= this.policy.maxDeliveries
                || (this.count('approval_deliveries') + 1) * 2 > this.policy.maxEvents)
                throw new WorkflowRuntimeError('limit');
            const encoded = JSON.stringify(record);
            this.db.prepare('INSERT INTO approval_deliveries(id,event_sha256,endpoint_id,record) VALUES(?,?,?,?)')
                .run(record.request.requestId, record.request.eventSha256, record.request.endpointId, encoded);
            this.db.prepare("INSERT INTO approval_delivery_events(delivery_id,kind,record) VALUES(?,'intent',?)").run(record.request.requestId, encoded);
            return true;
        });
    }
    settle(value) {
        const record = inspectNotificationRecord(value);
        this.atomic(() => {
            const previous = this.get(record.request.requestId);
            if (!previous)
                throw new WorkflowRuntimeError('not-found');
            const checked = validateNotificationSettlement(previous, record);
            if (!checked.changed)
                return;
            if (this.count('approval_delivery_events') >= this.policy.maxEvents)
                throw new WorkflowRuntimeError('limit');
            const encoded = JSON.stringify(checked.record);
            this.db.prepare('UPDATE approval_deliveries SET record=? WHERE id=?').run(encoded, record.request.requestId);
            this.db.prepare("INSERT INTO approval_delivery_events(delivery_id,kind,record) VALUES(?,'settled',?)").run(record.request.requestId, encoded);
        });
    }
    /** Verify each stored snapshot against its two-entry maximum journal and predecessor chain on owner activation. */
    validate(checkHistory) {
        if (this.count('approval_deliveries') > this.policy.maxDeliveries
            || this.count('approval_deliveries') * 2 > this.policy.maxEvents || this.count('approval_delivery_events') > this.policy.maxEvents)
            throw new WorkflowRuntimeError('limit');
        const ids = this.db.prepare('SELECT id FROM approval_deliveries ORDER BY rowid').all();
        const latest = new Map();
        let verifiedEvents = 0;
        for (const { id } of ids) {
            if (!z.uuid().safeParse(id).success)
                throw new WorkflowRuntimeError('corrupt');
            const current = this.get(id);
            const rows = this.db.prepare('SELECT kind,record FROM approval_delivery_events WHERE delivery_id=? ORDER BY sequence LIMIT 3')
                .all(id);
            if (!rows.length || rows.length > 2 || rows[0].kind !== 'intent')
                throw new WorkflowRuntimeError('corrupt');
            const subject = JSON.stringify([current.request.eventSha256, current.request.endpointId]), first = this.decode(rows[0].record);
            try {
                validateNotificationIntent(first, latest.get(subject));
            }
            catch {
                throw new WorkflowRuntimeError('corrupt');
            }
            if (first.request.requestId !== id)
                throw new WorkflowRuntimeError('corrupt');
            let expected = first;
            if (rows.length === 2) {
                if (rows[1].kind !== 'settled')
                    throw new WorkflowRuntimeError('corrupt');
                try {
                    expected = validateNotificationSettlement(first, this.decode(rows[1].record)).record;
                }
                catch {
                    throw new WorkflowRuntimeError('corrupt');
                }
            }
            if (!isDeepStrictEqual(expected, current))
                throw new WorkflowRuntimeError('corrupt');
            checkHistory?.(current);
            latest.set(subject, current);
            verifiedEvents += rows.length;
        }
        if (verifiedEvents !== this.count('approval_delivery_events'))
            throw new WorkflowRuntimeError('corrupt');
    }
}
