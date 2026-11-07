import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { JournalError } from "../storage/postgres.js";
import { withDomainWrite } from "../storage/domain-owner.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { inspectNotificationRecord, notificationSha256 } from "./schema.js";
import { validateNotificationIntent, validateNotificationSettlement } from "./transitions.js";
import { parseNotificationPage } from "./history.js";
const policySchema = z.strictObject({ maxDeliveries: z.number().int().min(1).max(100000), maxEvents: z.number().int().min(2).max(200000) });
const headSchema = z.strictObject({ requestId: z.uuid(), generation: z.number().int().positive().max(100000) });
const subject = (record) => notificationSha256([record.request.eventSha256, record.request.endpointId]);
const corrupt = () => new WorkflowRuntimeError('corrupt');
/** One journal owner; all adapters share the domain queue. Never performs external effects inside that queue. */
export class PostgresNotificationStore {
    journal;
    checks;
    policy;
    constructor(journal, policy, 
    // Internal callbacks run under the domain gate. They must not acquire it again or perform external effects.
    checks = {}) {
        this.journal = journal;
        this.checks = checks;
        const parsed = policySchema.safeParse(policy);
        if (!parsed.success)
            throw new WorkflowRuntimeError('invalid-command');
        this.policy = parsed.data;
    }
    owned(work) {
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
    async read(id) {
        const row = await this.journal.get('approval-deliveries', id);
        if (!row)
            return undefined;
        if (row.deleted)
            throw corrupt();
        const record = inspectNotificationRecord(row.value);
        if (record.request.requestId !== row.key || row.version !== (record.outcome.status === 'pending' ? '1' : '2'))
            throw corrupt();
        return record;
    }
    async head(key) {
        const row = await this.journal.get('approval-delivery-subjects', key);
        if (!row)
            return undefined;
        const parsed = headSchema.safeParse(row.value);
        if (row.deleted || !parsed.success || String(parsed.data.generation) !== row.version)
            throw corrupt();
        return parsed.data;
    }
    get(id) {
        if (!z.uuid().safeParse(id).success)
            throw new WorkflowRuntimeError('invalid-command');
        return this.owned(async () => {
            const record = await this.read(id);
            if (record)
                await this.checks.history?.(record);
            return record;
        });
    }
    page(value) {
        const { after, limit, filter } = parseNotificationPage(value);
        if (filter !== undefined)
            throw new WorkflowRuntimeError('invalid-command');
        return this.owned(async () => {
            if (after !== undefined && !await this.read(after))
                throw new WorkflowRuntimeError('not-found');
            const page = await this.journal.page('approval-deliveries', after, limit);
            const records = [];
            for (const row of page.records) {
                const record = inspectNotificationRecord(row.value);
                if (row.deleted || record.request.requestId !== row.key || row.version !== (record.outcome.status === 'pending' ? '1' : '2'))
                    throw corrupt();
                await this.checks.history?.(record);
                records.push(record);
            }
            return { records, nextCursor: page.nextCursor };
        });
    }
    createIntent(value) {
        const record = inspectNotificationRecord(value);
        return this.owned(async () => {
            if (await this.read(record.request.requestId))
                return false;
            const key = subject(record), head = await this.head(key);
            const previous = head ? await this.read(head.requestId) : undefined;
            if (head && (!previous || subject(previous) !== key))
                throw corrupt();
            validateNotificationIntent(record, previous);
            const count = await this.journal.count('approval-deliveries');
            // Reserve two notification audit entries per delivery. Global journal limits can still refuse a settlement.
            if (count >= this.policy.maxDeliveries || (count + 1) * 2 > this.policy.maxEvents)
                throw new WorkflowRuntimeError('limit');
            await this.checks.admission?.(record);
            await this.journal.commit({ id: randomUUID(), changes: [
                    { operation: 'put', collection: 'approval-deliveries', key: record.request.requestId, expectedVersion: '0', value: z.json().parse(record) },
                    { operation: 'put', collection: 'approval-delivery-subjects', key, expectedVersion: String(head?.generation ?? 0),
                        value: { requestId: record.request.requestId, generation: (head?.generation ?? 0) + 1 } },
                ], events: [{ collection: 'approval-deliveries', key: record.request.requestId, kind: 'intent', data: z.json().parse(record) }] });
            return true;
        });
    }
    settle(value) {
        const record = inspectNotificationRecord(value);
        return this.owned(async () => {
            const previous = await this.read(record.request.requestId);
            if (!previous)
                throw new WorkflowRuntimeError('not-found');
            const checked = validateNotificationSettlement(previous, record);
            if (!checked.changed)
                return;
            await this.checks.history?.(record);
            await this.journal.commit({ id: randomUUID(), changes: [{ operation: 'put', collection: 'approval-deliveries',
                        key: record.request.requestId, expectedVersion: '1', value: z.json().parse(record) }],
                events: [{ collection: 'approval-deliveries', key: record.request.requestId, kind: 'settled', data: z.json().parse(record) }] });
        });
    }
    /** Bounded startup replay of evidence, never dispatch. Validate snapshots and predecessor heads against the full audit. */
    validate() {
        return this.owned(async () => {
            const count = await this.journal.count('approval-deliveries');
            if (count > this.policy.maxDeliveries || count * 2 > this.policy.maxEvents)
                throw new WorkflowRuntimeError('limit');
            const latest = new Map();
            const seen = new Map();
            let cursor = '0', total = 0;
            while (true) {
                const page = await this.journal.events(cursor, 100, ['approval-deliveries']);
                if (!page.events.length)
                    break;
                for (const event of page.events) {
                    if (++total > this.policy.maxEvents)
                        throw new WorkflowRuntimeError('limit');
                    const record = inspectNotificationRecord(event.data), key = subject(record), id = record.request.requestId;
                    if (event.key !== id)
                        throw corrupt();
                    const current = await this.read(id);
                    if (!current)
                        throw corrupt();
                    const prior = seen.get(id);
                    if (event.kind === 'intent') {
                        if (prior || seen.size >= this.policy.maxDeliveries)
                            throw corrupt();
                        const head = latest.get(key), previous = head ? await this.read(head.requestId) : undefined;
                        try {
                            validateNotificationIntent(record, previous);
                        }
                        catch {
                            throw corrupt();
                        }
                        // A pending intent must either still be the snapshot or differ only by a valid terminal settlement.
                        if (current.outcome.status === 'pending') {
                            if (!isDeepStrictEqual(record, current))
                                throw corrupt();
                        }
                        else {
                            try {
                                validateNotificationSettlement(record, current);
                            }
                            catch {
                                throw corrupt();
                            }
                        }
                        latest.set(key, { requestId: id, generation: (head?.generation ?? 0) + 1 });
                        seen.set(id, { subject: key, settled: false });
                    }
                    else if (event.kind === 'settled') {
                        if (!prior || prior.settled || prior.subject !== key || record.outcome.status !== 'settled'
                            || !isDeepStrictEqual(record, current))
                            throw corrupt();
                        prior.settled = true;
                    }
                    else
                        throw corrupt();
                }
                cursor = page.cursor;
            }
            if (seen.size !== count || await this.journal.count('approval-delivery-subjects') !== latest.size)
                throw corrupt();
            for (const [id, evidence] of seen) {
                const record = (await this.read(id));
                if ((record.outcome.status === 'settled') !== evidence.settled)
                    throw corrupt();
                await this.checks.history?.(record);
            }
            for (const [key, expected] of latest)
                if (!isDeepStrictEqual(await this.head(key), expected))
                    throw corrupt();
        });
    }
}
