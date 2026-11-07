import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { JournalError } from "../storage/postgres.js";
import { withDomainWrite } from "../storage/domain-owner.js";
import { PostgresProjectStore } from "../projects/postgres-store.js";
import { DEFAULT_COMPILER_LIMITS } from "../limits.js";
import { compileWorkflowYaml } from "../workflow/index.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { parseTest, testCommandSchema } from "./schema.js";
import { TestLedger } from "./ledger.js";
import { generateTestsSchema } from "./generation-schema.js";
import { generateInputs } from "./generate.js";
import { triggerMetadata } from "../runtime/trigger.js";
import { validateTestTriggerMode } from "./validate.js";
import { postgresTestWrite, decodePostgresTest } from "./postgres-record.js";
import { PostgresRunReader } from "../runtime/postgres-reader.js";
import { reviewTestErasure } from "./erasure.js";
import { testErasureRequestSchema, savedTestErasureSchema, testErasureReceiptHash, prepareTestErasureReceipt, verifyTestErasureRetry } from "./erasure-write.js";
const savedGeneration = z.strictObject({ format: z.literal('jevable.pg-test-generation/v1'), snapshot: z.unknown(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
const erasureSubject = z.strictObject({ format: z.literal('jevable.pg-test-erasure-subject/v1'),
    requestId: z.uuid().regex(/^[a-f0-9-]+$/u) });
/** Async saved-case review and atomic schema-generated drafts; never dispatches execution. */
export class PostgresTestStore {
    journal;
    limits;
    maxRecordBytes;
    projects;
    ledger;
    constructor(journal, limits = DEFAULT_COMPILER_LIMITS, maxRecordBytes = 4_000_000) {
        this.journal = journal;
        this.limits = limits;
        this.maxRecordBytes = maxRecordBytes;
        if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1024 || maxRecordBytes > 16_000_000)
            throw new WorkflowRuntimeError('invalid-command');
        this.projects = new PostgresProjectStore(journal, limits.source, maxRecordBytes);
        this.ledger = new TestLedger(limits, maxRecordBytes);
    }
    validateRecord(row) {
        return decodePostgresTest(row, this.ledger, (id, generation) => this.projects.get(id, generation), this.maxRecordBytes);
    }
    async read(id) {
        if (!z.uuid().safeParse(id).success)
            throw new WorkflowRuntimeError('invalid-command');
        const row = await this.journal.get('test-cases', id);
        if (!row || row.deleted)
            throw new WorkflowRuntimeError('not-found');
        return { record: await this.validateRecord(row), version: row.version };
    }
    async get(id, generation) { return this.ledger.select((await this.read(id)).record, generation); }
    async history(id) { return (await this.read(id)).record; }
    async list(after, limit = 100) {
        const page = await this.journal.page('test-cases', after, limit), tests = [];
        for (const row of page.records) {
            const item = this.ledger.select(await this.validateRecord(row));
            tests.push({ id: item.id, generation: item.generation, title: item.definition.title, project: item.definition.project,
                ...(item.archived === undefined ? {} : { archived: item.archived }),
                status: item.status, sha256: item.sha256, actor: item.actor, at: item.at });
        }
        return { tests, nextCursor: page.nextCursor };
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
    caseWrite(record, expectedVersion) {
        return postgresTestWrite(record, expectedVersion, this.maxRecordBytes);
    }
    /** Internal verified metadata read. Caller holds the domain gate; never acquire it again here. */
    async erasureRecord(requestId) {
        const row = await this.journal.get('test-erasures', requestId);
        if (!row)
            throw new WorkflowRuntimeError('not-found');
        try {
            const saved = parseTest(savedTestErasureSchema, row.value, 8192), receipt = saved.receipt;
            if (row.deleted || row.key !== requestId || row.version !== '1' || receipt.requestId !== requestId
                || saved.sha256 !== testErasureReceiptHash(receipt))
                throw new WorkflowRuntimeError('corrupt');
            const subject = await this.journal.get('test-erasure-subjects', receipt.test.id.toLowerCase());
            const binding = erasureSubject.parse(subject?.value);
            const removed = await this.journal.get('test-cases', receipt.test.id);
            if (!subject || subject.deleted || subject.version !== '1' || subject.key !== receipt.test.id.toLowerCase()
                || binding.requestId !== requestId || !removed?.deleted || removed.value !== null
                || removed.key !== receipt.test.id || removed.version !== String(receipt.test.generation + 1)
                || (await this.journal.testCaseIdentity(receipt.test.id)).live)
                throw new WorkflowRuntimeError('corrupt');
            const project = await this.projects.get(receipt.project.id, receipt.project.generation);
            if (project.acceptedRevision !== receipt.project.revision)
                throw new WorkflowRuntimeError('corrupt');
            const evidence = await this.journal.events('0', 2, ['test-erasures'], requestId);
            if (evidence.events.length !== 1 || evidence.events[0].kind !== 'test-erased'
                || evidence.events[0].batchId !== requestId || !isDeepStrictEqual(evidence.events[0].data, receipt))
                throw new WorkflowRuntimeError('corrupt');
            const commit = await this.journal.receipt(requestId);
            const expected = [{ collection: 'test-erasures', key: requestId, version: '1', deleted: false },
                { collection: 'test-erasure-subjects', key: receipt.test.id.toLowerCase(), version: '1', deleted: false },
                { collection: 'test-cases', key: receipt.test.id, version: String(receipt.test.generation + 1), deleted: true }];
            if (!commit || !isDeepStrictEqual(commit.changes, expected) || commit.eventSequences.length !== 1
                || commit.eventSequences[0] !== evidence.events[0].sequence)
                throw new WorkflowRuntimeError('corrupt');
            return receipt;
        }
        catch (error) {
            if (error instanceof JournalError)
                throw error;
            throw new WorkflowRuntimeError('corrupt');
        }
    }
    erasure(requestId) {
        const id = parseTest(z.uuid().transform(value => value.toLowerCase()), requestId, 4096);
        return this.mutate(() => this.erasureRecord(id));
    }
    /** Startup validates every receipt and subject; missing counterparts fail closed, never repaired. */
    validateErasures() {
        return this.mutate(async () => {
            const checked = async (requestId) => {
                try {
                    return await this.erasureRecord(requestId);
                }
                catch (error) {
                    if (error instanceof WorkflowRuntimeError && error.code === 'not-found')
                        throw new WorkflowRuntimeError('corrupt');
                    throw error;
                }
            };
            for (const collection of ['test-erasures', 'test-erasure-subjects']) {
                if (await this.journal.count(collection) > 10000)
                    throw new WorkflowRuntimeError('limit');
                let after, count = 0;
                do {
                    const page = await this.journal.page(collection, after);
                    for (const row of page.records) {
                        if (++count > 10000)
                            throw new WorkflowRuntimeError('limit');
                        if (collection === 'test-erasures')
                            await checked(row.key);
                        else {
                            const parsed = erasureSubject.safeParse(row.value);
                            if (row.version !== '1' || !parsed.success)
                                throw new WorkflowRuntimeError('corrupt');
                            const receipt = await checked(parsed.data.requestId);
                            if (row.key !== receipt.test.id.toLowerCase())
                                throw new WorkflowRuntimeError('corrupt');
                        }
                    }
                    after = page.nextCursor ?? undefined;
                } while (after !== undefined);
            }
            let cursor = '0', count = 0;
            while (true) {
                const page = await this.journal.events(cursor, 100, ['test-erasures']);
                if (!page.events.length)
                    break;
                for (const event of page.events) {
                    if (++count > 10000)
                        throw new WorkflowRuntimeError('limit');
                    await checked(event.key);
                }
                cursor = page.cursor;
            }
        });
    }
    async erasureReferences(id) {
        const reader = new PostgresRunReader(this.journal, this.limits, this.maxRecordBytes);
        const counts = { runs: 0, generationBatches: 0, otherReferences: 0 };
        const scans = [{ collection: 'runs', capacity: 100000 },
            { collection: 'test-generations', capacity: 10000 }, { collection: 'test-cases', capacity: 10000 }];
        for (const scan of scans) {
            if (await this.journal.count(scan.collection) > scan.capacity)
                throw new WorkflowRuntimeError('limit');
            let after, count = 0;
            do {
                const page = await this.journal.page(scan.collection, after);
                for (const row of page.records) {
                    if (++count > scan.capacity)
                        throw new WorkflowRuntimeError('limit');
                    if (scan.collection === 'runs') {
                        if ((await reader.read(row.key)).record.test?.id.toLowerCase() === id.toLowerCase())
                            counts.runs++;
                    }
                    else if (scan.collection === 'test-generations') {
                        if ((await this.generation(row.key)).snapshot.cases.some(item => item.id.toLowerCase() === id.toLowerCase()))
                            counts.generationBatches++;
                    }
                    else {
                        const record = await this.validateRecord(row);
                        if (record.id !== id && record.id.toLowerCase() === id.toLowerCase())
                            counts.otherReferences++;
                    }
                }
                after = page.nextCursor ?? undefined;
            } while (after !== undefined);
        }
        return counts;
    }
    erase(value) {
        const command = parseTest(testErasureRequestSchema, value, 4096);
        return this.mutate(async () => {
            if (await this.journal.get('test-erasures', command.requestId)) {
                const receipt = await this.erasureRecord(command.requestId);
                verifyTestErasureRetry(receipt, command);
                return receipt;
            }
            if (await this.journal.get('test-erasure-subjects', command.test.id.toLowerCase()))
                throw new WorkflowRuntimeError('conflict');
            const { record, version } = await this.read(command.test.id);
            const review = reviewTestErasure(record, { test: command.test, reviewedHistorySha256: command.reviewedHistorySha256 }, await this.erasureReferences(record.id), this.limits, this.maxRecordBytes);
            if (review.reasons.includes('not-archived'))
                throw new WorkflowRuntimeError('conflict');
            if (!review.eligible)
                throw new WorkflowRuntimeError('referenced');
            if (await this.journal.count('test-erasures') >= 10000 || await this.journal.count('test-erasure-subjects') >= 10000)
                throw new WorkflowRuntimeError('limit');
            const receipt = prepareTestErasureReceipt(command, record);
            await this.journal.commit({ id: command.requestId, changes: [
                    { operation: 'put', collection: 'test-erasures', key: command.requestId, expectedVersion: '0',
                        value: z.json().parse({ format: 'jevable.test-erasure/v1', receipt, sha256: testErasureReceiptHash(receipt) }) },
                    { operation: 'put', collection: 'test-erasure-subjects', key: record.id.toLowerCase(), expectedVersion: '0',
                        value: { format: 'jevable.pg-test-erasure-subject/v1', requestId: command.requestId } },
                    { operation: 'delete', collection: 'test-cases', key: record.id, expectedVersion: version },
                ], events: [{ collection: 'test-erasures', key: command.requestId, kind: 'test-erased', data: z.json().parse(receipt) }] });
            return receipt;
        });
    }
    execute(value) {
        const command = parseTest(testCommandSchema, value);
        return this.mutate(async () => {
            const previous = command.operation === 'create' ? undefined : await this.read(command.id);
            const { record, test } = this.ledger.prepare(command, previous?.record);
            if (command.operation === 'create') {
                if ((await this.journal.testCaseIdentity(test.id)).retained)
                    throw new WorkflowRuntimeError('conflict');
                if (await this.journal.count('test-cases') >= 10000)
                    throw new WorkflowRuntimeError('limit');
            }
            const lifecycle = command.operation === 'archive';
            this.ledger.validate(test.definition, await this.projects.get(test.definition.project.id, lifecycle ? test.definition.project.generation : undefined), !lifecycle);
            const { change, event } = this.caseWrite(record, previous?.version ?? '0');
            await this.journal.commit({ id: randomUUID(), changes: [change], events: [event] });
            return test;
        });
    }
    async generation(id) {
        if (!z.uuid().safeParse(id).success)
            throw new WorkflowRuntimeError('invalid-command');
        const row = await this.journal.get('test-generations', id);
        if (!row || row.deleted)
            throw new WorkflowRuntimeError('not-found');
        try {
            if (row.version !== '1')
                throw new WorkflowRuntimeError('corrupt');
            const envelope = savedGeneration.parse(row.value), result = this.ledger.decodeGeneration(envelope, id), snapshot = result.snapshot;
            const pin = snapshot.request.project;
            this.ledger.validateGenerationProject(snapshot, await this.projects.get(pin.id, pin.generation));
            for (const item of snapshot.cases)
                this.ledger.validateGeneratedCase(snapshot, item, await this.get(item.id, 1));
            return result;
        }
        catch (error) {
            if (error instanceof JournalError)
                throw error;
            throw new WorkflowRuntimeError('corrupt');
        }
    }
    async generations(after, limit = 100) {
        const page = await this.journal.page('test-generations', after, limit), generations = [];
        for (const row of page.records)
            generations.push(await this.generation(row.key));
        return { generations, nextCursor: page.nextCursor };
    }
    /** Batch UUID retries observe the retained draft set; no generation command accepts or runs tests. */
    generate(value) {
        const { id, actor, ...request } = parseTest(generateTestsSchema, value);
        return this.mutate(async () => {
            const existing = await this.journal.get('test-generations', id);
            if (existing) {
                if (existing.deleted)
                    throw new WorkflowRuntimeError('conflict');
                const previous = await this.generation(id);
                if (!isDeepStrictEqual(previous.snapshot.request, request))
                    throw new WorkflowRuntimeError('conflict');
                return previous;
            }
            if (await this.journal.count('test-generations') >= 10000)
                throw new WorkflowRuntimeError('limit');
            const project = await this.projects.get(request.project.id);
            if (project.archived)
                throw new WorkflowRuntimeError('archived');
            if (project.generation !== request.project.generation || project.acceptedRevision !== request.project.revision)
                throw new WorkflowRuntimeError('conflict');
            const graph = compileWorkflowYaml(project.revisions.find(item => item.revision === project.acceptedRevision).yaml, this.limits);
            validateTestTriggerMode(request.triggerMode, graph);
            const generated = generateInputs(graph.input, this.limits.binding.data, request.limit);
            if (await this.journal.count('test-cases') + generated.candidates.length > 10000)
                throw new WorkflowRuntimeError('limit');
            const records = [];
            const cases = generated.candidates.map((candidate, index) => {
                const { record, test } = this.ledger.prepare(parseTest(testCommandSchema, { operation: 'create', actor, definition: {
                        title: `Generated case ${index + 1} (${candidate.reason})`, project: request.project, input: candidate.input,
                        expectations: [{ kind: 'status', value: 'completed' }], ...triggerMetadata(request)
                    } }));
                this.ledger.validate(test.definition, project, true);
                records.push(record);
                return { id: test.id, generation: 1, sha256: test.sha256, definition: test.definition, reason: candidate.reason, path: candidate.path };
            });
            const result = this.ledger.prepareGeneration(id, actor, request, generated, cases);
            for (const record of records)
                if ((await this.journal.testCaseIdentity(record.id)).retained)
                    throw new WorkflowRuntimeError('conflict');
            const writes = records.map(record => this.caseWrite(record, '0')), value = { format: 'jevable.pg-test-generation/v1', ...result };
            if (Buffer.byteLength(JSON.stringify(value)) > this.maxRecordBytes)
                throw new WorkflowRuntimeError('limit');
            await this.journal.commit({ id: randomUUID(), changes: [...writes.map(write => write.change), { operation: 'put', collection: 'test-generations', key: id,
                        expectedVersion: '0', value: z.json().parse(value) }], events: [...writes.map(write => write.event), { collection: 'test-generations', key: id,
                        kind: 'tests-generated', data: { generationId: id, sha256: result.sha256, projectId: project.id,
                            projectGeneration: project.generation, revision: project.acceptedRevision, caseCount: cases.length, actor } }] });
            return result;
        });
    }
}
