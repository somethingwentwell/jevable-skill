import { z } from 'zod';
import { JournalError } from "../storage/postgres.js";
import { withDomainWrite } from "../storage/domain-owner.js";
import { DEFAULT_COMPILER_LIMITS } from "../limits.js";
import { admitWorkflowData } from "../workflow/index.js";
import { localRunSchema } from "./run-types.js";
import { PostgresRunReader } from "./postgres-reader.js";
import { runEventKind, validateRunTransition } from "./run-transition.js";
import { WorkflowRuntimeError } from "./errors.js";
import { createPostgresRunEvidence } from "./postgres-evidence.js";
import { PostgresProviderStore } from "../providers/postgres-store.js";
import { modelEvidenceTargets, ModelEvidenceProjection } from "./model-evidence.js";
import { triggerMetadata } from "./trigger.js";
import { ACTIVITY_LIMITS, activityRun, createActivityReport } from "./activity.js";
import { parseJournalConditions } from "../storage/conditions.js";
import { PostgresGrantStore } from "../access/postgres-grants.js";
import { verifyReviewerBatchIdentity } from "../access/reviewer.js";
import { verifyCallerCancellationBatchIdentity } from "../access/caller-cancellation.js";
import { verifyCallerControlBatchIdentity } from "../access/caller-control.js";
import { isDeepStrictEqual } from 'node:util';
const serial = z.string().regex(/^(0|[1-9][0-9]{0,18})$/u).refine(value => BigInt(value) < 9223372036854775806n);
const writeSchema = z.strictObject({ requestId: z.uuid(), expectedVersion: serial, record: localRunSchema, kind: runEventKind, data: z.json() });
const releasePin = z.strictObject({ id: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/u), revision: z.string().regex(/^[a-f0-9]{64}$/u) });
function summary(record, version) {
    return { id: record.id, version, revision: record.revision, status: record.state.status, createdAt: record.createdAt, updatedAt: record.updatedAt,
        ...triggerMetadata(record),
        ...(record.project ? { project: record.project } : {}), ...(record.release ? { release: record.release } : {}), ...(record.test ? { test: record.test } : {}) };
}
/** Experimental execution storage. It commits/validates checkpoints; it never starts or resumes a workflow. */
export class PostgresRunStore {
    journal;
    limits;
    maxRecordBytes;
    maxRuns;
    retainedMetrics;
    reader;
    approvalCapture;
    /** Internal source bridge. No read/reopen scan, replay or independent owner. */
    observeCommittedApprovals(capture) {
        this.journal.signal.throwIfAborted();
        if (this.approvalCapture)
            throw new WorkflowRuntimeError('conflict');
        this.approvalCapture = capture;
    }
    constructor(journal, limits = DEFAULT_COMPILER_LIMITS, maxRecordBytes = 4_000_000, maxRuns = 10000, retainedMetrics) {
        this.journal = journal;
        this.limits = limits;
        this.maxRecordBytes = maxRecordBytes;
        this.maxRuns = maxRuns;
        this.retainedMetrics = retainedMetrics;
        if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1024 || maxRecordBytes > 16_000_000
            || !Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 100000)
            throw new WorkflowRuntimeError('invalid-command');
        this.reader = new PostgresRunReader(journal, limits, maxRecordBytes);
    }
    get signal() { return this.journal.signal; }
    /** One domain gate across every source page; verified reads never dispatch a model or workflow. */
    activity(readProjects) {
        return this.owned(async () => {
            const projects = await readProjects(), runs = [], seen = new Set();
            let after;
            do {
                const page = await this.journal.page('runs', after, 100);
                for (const row of page.records) {
                    if (seen.has(row.key))
                        throw new WorkflowRuntimeError('corrupt');
                    seen.add(row.key);
                    if (runs.length >= Math.min(this.maxRuns, ACTIVITY_LIMITS.runs))
                        throw new WorkflowRuntimeError('limit');
                    runs.push(activityRun((await this.reader.read(row.key)).record));
                }
                if (page.nextCursor && after && page.nextCursor <= after)
                    throw new WorkflowRuntimeError('corrupt');
                after = page.nextCursor ?? undefined;
            } while (after);
            this.journal.signal.throwIfAborted();
            return createActivityReport('postgres', projects, runs);
        });
    }
    owned(work) {
        return withDomainWrite(this.journal, async () => {
            try {
                return await work();
            }
            catch (error) {
                if (this.journal.signal.aborted || (error instanceof WorkflowRuntimeError || error instanceof JournalError) && error.code === 'corrupt')
                    this.retainedMetrics?.invalidate();
                if (error instanceof JournalError && error.code === 'conflict')
                    throw new WorkflowRuntimeError('conflict');
                throw error;
            }
        });
    }
    parse(schema, value, corrupt = false) {
        try {
            return schema.parse(admitWorkflowData(value, { maxBytes: this.maxRecordBytes, maxDepth: 64, maxValues: 100000 }));
        }
        catch {
            throw new WorkflowRuntimeError(corrupt ? 'corrupt' : 'invalid-command');
        }
    }
    get(id) {
        return this.owned(async () => {
            const { record, version, events } = await this.reader.read(id);
            this.retainedMetrics?.restore(record, events);
            return { record, version };
        });
    }
    /** Internal caller read/start-retry. No foreign payload is loaded, and expiry is checked after every awaited replay. */
    caller(token, id, permission, allowNew = false) {
        if (!z.uuid().safeParse(id).success || typeof allowNew !== 'boolean' || !['start', 'read', 'control', 'cancel'].includes(permission)
            || allowNew && permission !== 'start')
            throw new WorkflowRuntimeError('invalid-command');
        const key = id.toLowerCase();
        return this.owned(async () => {
            const grants = new PostgresGrantStore(this.journal), principal = await grants.callerForReadInDomain(token, permission);
            if (principal.scope.kind !== 'caller')
                throw new WorkflowRuntimeError('not-found');
            const selected = await this.journal.callerRun({ id: key, grantId: principal.grantId, release: principal.scope.release });
            let result;
            if (selected) {
                const read = await this.reader.read(key);
                if (read.version !== selected.version || read.record.caller?.grantId !== principal.grantId
                    || !isDeepStrictEqual(read.record.caller.scope, principal.scope))
                    throw new WorkflowRuntimeError('corrupt');
                this.retainedMetrics?.restore(read.record, read.events);
                result = { record: read.record, version: read.version };
            }
            else if (!allowNew || await this.journal.exists('runs', key))
                throw new WorkflowRuntimeError('not-found');
            const final = await grants.callerForReadInDomain(token, permission);
            if (final.grantId !== principal.grantId || !isDeepStrictEqual(final.scope, principal.scope))
                throw new WorkflowRuntimeError('not-found');
            return result;
        });
    }
    /** Only the authenticated grant supplies this retained run/revision, before any private read. */
    reviewer(token, action) {
        return this.owned(async () => {
            const grants = new PostgresGrantStore(this.journal), principal = await grants.reviewerForReadInDomain(token, action);
            if (principal.scope.kind !== 'reviewer')
                throw new WorkflowRuntimeError('not-found');
            const result = await this.reader.read(principal.scope.runId);
            if (result.record.revision !== principal.scope.revision)
                throw new WorkflowRuntimeError('not-found');
            const final = await grants.reviewerForReadInDomain(token, action);
            if (final.grantId !== principal.grantId || !isDeepStrictEqual(final.scope, principal.scope))
                throw new WorkflowRuntimeError('not-found');
            return { ...result, principal: final };
        });
    }
    events(id) { return this.owned(async () => (await this.reader.read(id)).events); }
    /** Hold the domain gate across checkpoint, journal, historical references and model verification. */
    evidence(id, includePrivate = false, usageIdentities = false) {
        if (typeof includePrivate !== 'boolean' || typeof usageIdentities !== 'boolean')
            throw new WorkflowRuntimeError('invalid-command');
        return this.owned(async () => {
            const { record, version, events, graph } = await this.reader.read(id);
            const providers = new PostgresProviderStore(this.journal, this.maxRecordBytes), models = new ModelEvidenceProjection(64_000_000, usageIdentities);
            for (const target of modelEvidenceTargets(graph, events))
                models.add(target, await providers.evidence(target.attempt.id));
            return createPostgresRunEvidence(record, events, version, includePrivate, models.calls, usageIdentities);
        });
    }
    list(after, limit = 100) {
        return this.owned(async () => {
            const page = await this.journal.page('runs', after, limit), runs = [];
            for (const row of page.records) {
                const { record, version, events } = await this.reader.read(row.key);
                this.retainedMetrics?.restore(record, events);
                runs.push(summary(record, version));
            }
            return { runs, nextCursor: page.nextCursor };
        });
    }
    /** Scoped pages never return an unrelated run identity as their continuation cursor. */
    listRelease(value, after, limit = 100) {
        const pin = this.parse(releasePin, value);
        if ((after !== undefined && !z.uuid().safeParse(after).success) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
            throw new WorkflowRuntimeError('invalid-command');
        const cursor = after?.toLowerCase();
        const matches = (record) => record.release?.id === pin.id && record.release.sha256 === pin.sha256 && record.revision === pin.revision;
        return this.owned(async () => {
            if (cursor && !matches((await this.reader.read(cursor)).record))
                throw new WorkflowRuntimeError('not-found');
            let scan = cursor, examined = 0;
            const runs = [];
            do {
                const page = await this.journal.page('runs', scan, 100);
                examined += page.records.length;
                if (examined > this.maxRuns)
                    throw new WorkflowRuntimeError('limit');
                for (const row of page.records) {
                    const { record, version } = await this.reader.read(row.key);
                    if (!matches(record))
                        continue;
                    if (runs.length === limit)
                        return { runs, nextCursor: runs.at(-1).id };
                    runs.push(summary(record, version));
                }
                if (!page.nextCursor)
                    return { runs, nextCursor: null };
                scan = page.nextCursor;
            } while (true);
        });
    }
    /** Accepts a finite JSON tree, not aliased evaluator objects. Retain the exact command/UUID; retries only retrieve receipts. */
    save(value, guard) {
        return this.saveAdmitted(value, guard, false);
    }
    /** New caller creation only. Exact historical recovery belongs to the authenticated caller read/retry path. */
    saveCallerCreation(value, guard) {
        if (guard === undefined)
            throw new WorkflowRuntimeError('invalid-command');
        return this.saveAdmitted(value, guard, true);
    }
    saveAdmitted(value, guard, callerCreation) {
        const conditions = guard === undefined ? undefined : parseJournalConditions(guard);
        const command = this.parse(writeSchema, value), record = command.record;
        const reviewer = verifyReviewerBatchIdentity(command.kind, command.data, command.requestId);
        const callerCancellation = verifyCallerCancellationBatchIdentity(command.kind, command.data, command.requestId);
        const callerControl = verifyCallerControlBatchIdentity(command.kind, command.data, command.requestId);
        if (callerControl && (!conditions || conditions.notBefore !== callerControl.at
            || conditions.expiresAt !== callerControl.delegation.deadline
            || !conditions.records.some(pin => pin.collection === 'access-grants' && pin.key === callerControl.delegation.grantId)
            || !conditions.records.some(pin => pin.collection === 'runs' && pin.key === record.id && pin.version === command.expectedVersion)))
            throw new WorkflowRuntimeError('invalid-command');
        if (callerCancellation && (!conditions || conditions.notBefore !== callerCancellation.at
            || conditions.expiresAt !== callerCancellation.delegation.deadline
            || !conditions.records.some(pin => pin.collection === 'access-grants' && pin.key === callerCancellation.delegation.grantId)
            || !conditions.records.some(pin => pin.collection === 'runs' && pin.key === record.id && pin.version === command.expectedVersion)))
            throw new WorkflowRuntimeError('invalid-command');
        if (reviewer && (!conditions || conditions.notBefore !== reviewer.at || conditions.expiresAt !== reviewer.delegation.deadline
            || !conditions.records.some(pin => pin.collection === 'access-grants' && pin.key === reviewer.delegation.grantId)
            || !conditions.records.some(pin => pin.collection === 'runs' && pin.key === record.id && pin.version === command.expectedVersion)))
            throw new WorkflowRuntimeError('invalid-command');
        if (callerCreation && (command.kind !== 'run-created' || command.expectedVersion !== '0' || !record.caller || !record.release || record.project || record.test))
            throw new WorkflowRuntimeError('invalid-command');
        const version = (BigInt(command.expectedVersion) + 1n).toString();
        const batch = { id: command.requestId, changes: [{ operation: 'put', collection: 'runs', key: record.id,
                    expectedVersion: command.expectedVersion, value: z.json().parse({ format: 'jevable.pg-run/v1', record }) }],
            events: [{ collection: 'runs', key: record.id, kind: command.kind, data: z.json().parse({ format: 'jevable.pg-run-event/v1', version, at: record.updatedAt, data: command.data }) }] };
        let committedEvents;
        const pending = this.owned(async () => {
            if (callerCreation && await this.journal.exists('runs', record.id))
                throw new WorkflowRuntimeError('not-found');
            if (callerCreation && await this.journal.receipt(command.requestId))
                throw new WorkflowRuntimeError('conflict');
            if (callerCancellation && await this.journal.receipt(command.requestId))
                throw new WorkflowRuntimeError('conflict');
            if (callerControl && await this.journal.receipt(command.requestId))
                throw new WorkflowRuntimeError('conflict');
            if (await this.journal.receipt(command.requestId))
                return this.journal.commit(batch, conditions);
            const row = callerCreation ? undefined : await this.journal.get('runs', record.id);
            if (row?.deleted || (row?.version ?? '0') !== command.expectedVersion)
                throw new WorkflowRuntimeError('conflict');
            const before = row ? await this.reader.read(record.id) : undefined;
            if (!before && await this.journal.count('runs') >= this.maxRuns)
                throw new WorkflowRuntimeError('limit');
            if (before && (before.events.length >= 50000 || Buffer.byteLength(JSON.stringify(before.events)) + Buffer.byteLength(JSON.stringify(command.data)) > 64_000_000))
                throw new WorkflowRuntimeError('limit');
            const events = [...before?.events ?? [], { kind: command.kind, data: command.data }];
            const graph = await this.reader.checked(record, events, before === undefined);
            validateRunTransition(before?.record, record, command.kind, command.data, graph, this.limits);
            if (command.kind === 'node-intent' && record.state.status === 'executing') {
                const attemptId = record.state.attempt.id;
                if (before?.events.some(event => {
                    if (event.kind !== 'node-intent' || !event.data || typeof event.data !== 'object')
                        return false;
                    const attempt = Reflect.get(event.data, 'attempt');
                    return attempt !== null && typeof attempt === 'object' && Reflect.get(attempt, 'id') === attemptId;
                }))
                    throw new WorkflowRuntimeError('conflict');
            }
            try {
                const receipt = await this.journal.commit(batch, conditions);
                this.retainedMetrics?.committed(record, command.kind);
                if (this.approvalCapture && ['approval-requested', 'approval-decided', 'run-cancelled'].includes(command.kind))
                    committedEvents = [...before?.events ?? [], { kind: command.kind, at: record.updatedAt, data: command.data }];
                return receipt;
            }
            catch (error) {
                this.retainedMetrics?.invalidate();
                throw error;
            }
        });
        return pending.then(async (receipt) => {
            // Never reacquire the non-reentrant gate, resolve credentials or send inside the run transaction.
            if (committedEvents && this.approvalCapture) {
                try {
                    await this.approvalCapture.committed(record, committedEvents, command.kind, command.data);
                }
                catch {
                    this.approvalCapture.refused(record.id, command.kind);
                }
            }
            return receipt;
        });
    }
}
