import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { z } from 'zod';
import { JournalError } from "../storage/postgres.js";
import { withDomainWrite } from "../storage/domain-owner.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { automaticAdmissionLimits, inspectAutomaticAdmission, parseAutomaticAdmissionPage, validateAutomaticAdmissionCreation, validateAutomaticAdmissionSettlement, verifyAutomaticAdmissionDelivery } from "./automatic-admission.js";
const collection = 'approval-automatic-admissions';
const corrupt = () => new WorkflowRuntimeError('corrupt');
/** One PostgreSQL journal owner and domain queue; no external effects, recovered queue or replay. */
export class PostgresAutomaticAdmissionStore {
    journal;
    checks;
    limits;
    constructor(journal, limits, 
    // Called while the domain gate is held. Must use raw verified reads, never reacquire the gate or send.
    checks) {
        this.journal = journal;
        this.checks = checks;
        const parsed = automaticAdmissionLimits.safeParse(limits);
        if (!parsed.success || typeof checks?.history !== 'function' || typeof checks?.delivery !== 'function')
            throw new WorkflowRuntimeError('invalid-command');
        this.limits = parsed.data;
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
        const row = await this.journal.get(collection, id);
        if (!row)
            return undefined;
        const record = inspectAutomaticAdmission(row.value);
        if (row.collection !== collection || row.deleted || row.key !== record.request.requestId || row.version !== '1' && row.version !== '2'
            || row.version === '2' && record.outcome.status === 'reserved')
            throw corrupt();
        return record;
    }
    async checked(record) {
        await this.checks.history(record);
        if (record.outcome.status === 'delivery-recorded')
            verifyAutomaticAdmissionDelivery(record, await this.checks.delivery(record.request.requestId));
        return record;
    }
    get(id) {
        if (!z.uuid().safeParse(id).success)
            throw new WorkflowRuntimeError('invalid-command');
        return this.owned(async () => { const record = await this.read(id); return record ? this.checked(record) : undefined; });
    }
    page(value = {}) {
        const { after, limit } = parseAutomaticAdmissionPage(value);
        return this.owned(async () => {
            if (after !== undefined) {
                const cursor = await this.read(after);
                if (!cursor)
                    throw new WorkflowRuntimeError('not-found');
                await this.checked(cursor);
            }
            const page = await this.journal.page(collection, after, limit);
            const records = [];
            for (const row of page.records) {
                const record = await this.read(row.key);
                if (!record || !same(record, inspectAutomaticAdmission(row.value)))
                    throw corrupt();
                records.push(await this.checked(record));
            }
            return { records, nextCursor: page.nextCursor };
        });
    }
    create(value) {
        const input = inspectAutomaticAdmission(value);
        return this.owned(async () => {
            const { record, changed } = validateAutomaticAdmissionCreation(input, await this.read(input.request.requestId));
            await this.checked(record);
            if (!changed)
                return false;
            const count = await this.journal.count(collection);
            if (count >= this.limits.maxAdmissions || (count + 1) * 2 > this.limits.maxEvents)
                throw new WorkflowRuntimeError('limit');
            await this.journal.commit({ id: randomUUID(), changes: [{ operation: 'put', collection, key: record.request.requestId,
                        expectedVersion: '0', value: z.json().parse(record) }],
                events: [{ collection, key: record.request.requestId, kind: 'created', data: z.json().parse(record) }] });
            return true;
        });
    }
    settle(value) {
        const input = inspectAutomaticAdmission(value);
        return this.owned(async () => {
            const previous = await this.read(input.request.requestId);
            if (!previous)
                throw new WorkflowRuntimeError('not-found');
            const { record, changed } = validateAutomaticAdmissionSettlement(previous, input);
            await this.checked(record);
            if (!changed)
                return;
            await this.journal.commit({ id: randomUUID(), changes: [{ operation: 'put', collection, key: record.request.requestId,
                        expectedVersion: '1', value: z.json().parse(record) }],
                events: [{ collection, key: record.request.requestId, kind: 'settled', data: z.json().parse(record) }] });
        });
    }
    /** Verify both directions, including versions and every creation/settlement event. Never settles or dispatches reserved rows. */
    validate() {
        return this.owned(async () => {
            const count = await this.journal.count(collection);
            if (count > this.limits.maxAdmissions || count * 2 > this.limits.maxEvents)
                throw new WorkflowRuntimeError('limit');
            const seen = new Map();
            let cursor = '0', total = 0;
            while (true) {
                const page = await this.journal.events(cursor, 100, [collection]);
                if (!page.events.length)
                    break;
                for (const event of page.events) {
                    if (++total > this.limits.maxEvents)
                        throw new WorkflowRuntimeError('limit');
                    const record = inspectAutomaticAdmission(event.data), id = record.request.requestId;
                    if (event.key !== id)
                        throw corrupt();
                    const previous = seen.get(id);
                    try {
                        if (event.kind === 'created') {
                            if (previous || seen.size >= this.limits.maxAdmissions)
                                throw corrupt();
                            validateAutomaticAdmissionCreation(record);
                        }
                        else if (event.kind === 'settled') {
                            if (!previous || !validateAutomaticAdmissionSettlement(previous.record, record).changed)
                                throw corrupt();
                        }
                        else
                            throw corrupt();
                    }
                    catch {
                        throw corrupt();
                    }
                    seen.set(id, { record, version: event.kind === 'created' ? '1' : '2' });
                }
                if (BigInt(page.cursor) <= BigInt(cursor))
                    throw corrupt();
                cursor = page.cursor;
            }
            if (seen.size !== count)
                throw corrupt();
            for (const [id, expected] of seen) {
                const row = await this.journal.get(collection, id), current = await this.read(id);
                if (!current || !same(current, expected.record) || row?.version !== expected.version)
                    throw corrupt();
                await this.checked(current);
            }
        });
    }
}
