import { z } from 'zod';
import { JournalError } from "../storage/postgres.js";
import { DEFAULT_COMPILER_LIMITS } from "../limits.js";
import { admitWorkflowData } from "../workflow/index.js";
import { PostgresProjectStore } from "../projects/postgres-store.js";
import { PostgresReleaseStore } from "../releases/postgres-store.js";
import { PostgresTestStore } from "../testing/postgres-store.js";
import { PostgresProviderStore } from "../providers/postgres-store.js";
import { ConfiguredModels } from "../providers/model-calls.js";
import { localRunSchema, stoppedCheckpoint } from "./run-types.js";
import { RunLedger } from "./run-ledger.js";
import { verifyModelResults } from "./run-evaluator.js";
import { runEventKind } from "./run-transition.js";
import { WorkflowRuntimeError } from "./errors.js";
import { PostgresGrantStore } from "../access/postgres-grants.js";
import { reviewerGrantIds, verifyReviewerBatchIdentity } from "../access/reviewer.js";
import { verifyCallerCancellationBatchIdentity } from "../access/caller-cancellation.js";
import { verifyCallerControlBatchIdentity } from "../access/caller-control.js";
const serial = z.string().regex(/^(0|[1-9][0-9]{0,18})$/u).refine(value => BigInt(value) < 9223372036854775806n);
const envelope = z.strictObject({ format: z.literal('jevable.pg-run/v1'), record: localRunSchema });
const eventEnvelope = z.strictObject({ format: z.literal('jevable.pg-run-event/v1'), version: serial, at: z.iso.datetime(), data: z.json() });
/** Internal verified reads; caller must hold the shared domain queue for a coherent read/guard/write operation. */
export class PostgresRunReader {
    journal;
    limits;
    maxRecordBytes;
    projects;
    releases;
    tests;
    models;
    ledger;
    grants;
    constructor(journal, limits = DEFAULT_COMPILER_LIMITS, maxRecordBytes = 4_000_000) {
        this.journal = journal;
        this.limits = limits;
        this.maxRecordBytes = maxRecordBytes;
        if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1024 || maxRecordBytes > 16_000_000)
            throw new WorkflowRuntimeError('invalid-command');
        this.projects = new PostgresProjectStore(journal, limits.source, maxRecordBytes, limits);
        this.releases = new PostgresReleaseStore(journal, maxRecordBytes);
        this.tests = new PostgresTestStore(journal, limits, maxRecordBytes);
        this.models = new ConfiguredModels(new PostgresProviderStore(journal, maxRecordBytes));
        this.ledger = new RunLedger(limits);
        this.grants = new PostgresGrantStore(journal);
    }
    parse(schema, value, corrupt = false) {
        try {
            return schema.parse(admitWorkflowData(value, { maxBytes: this.maxRecordBytes, maxDepth: 64, maxValues: 100000 }));
        }
        catch {
            throw new WorkflowRuntimeError(corrupt ? 'corrupt' : 'invalid-command');
        }
    }
    async history(id) {
        const events = [];
        let cursor = '0', bytes = 0;
        while (true) {
            const page = await this.journal.events(cursor, 200, ['runs'], id);
            if (!page.events.length)
                return events;
            for (const item of page.events) {
                const value = this.parse(eventEnvelope, item.data, true), kind = runEventKind.safeParse(item.kind);
                if (!kind.success || value.version !== String(events.length + 1))
                    throw new WorkflowRuntimeError('corrupt');
                verifyReviewerBatchIdentity(kind.data, value.data, item.batchId);
                verifyCallerCancellationBatchIdentity(kind.data, value.data, item.batchId);
                verifyCallerControlBatchIdentity(kind.data, value.data, item.batchId);
                bytes += Buffer.byteLength(JSON.stringify(item.data));
                if (events.length >= 50000 || bytes > 64_000_000)
                    throw new WorkflowRuntimeError('limit');
                events.push({ sequence: item.sequence, version: value.version, kind: kind.data, at: value.at, data: value.data });
            }
            cursor = page.cursor;
        }
    }
    async checked(record, events, current = false) {
        const project = record.project ? await this.projects.get(record.project.id, current ? undefined : record.project.generation) : undefined;
        const release = record.release ? await this.releases.get(record.release.id) : undefined;
        const test = record.test ? await this.tests.get(record.test.id, current ? undefined : record.test.generation) : undefined;
        if (current) {
            if (test?.archived)
                throw new WorkflowRuntimeError('archived');
            if (project?.archived)
                throw new WorkflowRuntimeError('archived');
            if (project && (project.generation !== record.project?.generation || project.acceptedRevision !== record.revision))
                throw new WorkflowRuntimeError('conflict');
            if (test && (test.status !== 'accepted' || test.generation !== record.test?.generation || test.sha256 !== record.test?.sha256))
                throw new WorkflowRuntimeError('conflict');
        }
        const grant = record.caller ? await this.grants.metadataForReplay(record.caller.grantId) : undefined;
        const reviewerGrants = [];
        for (const id of reviewerGrantIds(record, events))
            reviewerGrants.push(await this.grants.metadataForReplay(id));
        const graph = this.ledger.check(record, { events, reviewerGrants, ...(project ? { project } : {}), ...(release ? { release } : {}), ...(test ? { test } : {}), ...(grant ? { grant } : {}) });
        const state = stoppedCheckpoint(record.state);
        await verifyModelResults(graph, state.status === 'waiting' || state.status === 'executing'
            ? { status: 'paused', steps: state.steps, next: state.next, ...(state.scope ? { scope: state.scope } : {}) } : state, this.models);
        return graph;
    }
    async read(id) {
        if (!z.uuid().safeParse(id).success)
            throw new WorkflowRuntimeError('invalid-command');
        const row = await this.journal.get('runs', id);
        if (!row || row.deleted)
            throw new WorkflowRuntimeError('not-found');
        try {
            const record = this.parse(envelope, row.value, true).record, events = await this.history(id);
            if (record.id !== id || row.version !== String(events.length) || record.updatedAt !== events.at(-1)?.at)
                throw new WorkflowRuntimeError('corrupt');
            const graph = await this.checked(record, events);
            return { record, version: row.version, events, graph };
        }
        catch (error) {
            if (error instanceof JournalError || error instanceof WorkflowRuntimeError && error.code === 'limit')
                throw error;
            throw new WorkflowRuntimeError('corrupt');
        }
    }
}
