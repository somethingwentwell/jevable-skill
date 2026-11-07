import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ProjectStore } from "../projects/store.js";
import { compileWorkflowYaml } from "../workflow/index.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { parseTest, testCommandSchema } from "./schema.js";
import { TestLedger } from "./ledger.js";
import { generateTestsSchema } from "./generation-schema.js";
import { generateInputs } from "./generate.js";
import { triggerMetadata } from "../runtime/trigger.js";
import { validateTestTriggerMode } from "./validate.js";
import { localRunSchema } from "../runtime/run-types.js";
import { reviewTestErasure } from "./erasure.js";
import { testErasureRequestSchema, savedTestErasureSchema, testErasureReceiptHash, prepareTestErasureReceipt, verifyTestErasureRetry } from "./erasure-write.js";
/** Append-only case versions. Acceptance never executes; past accepted definitions remain available to runs. */
export class TestStore {
    db;
    limits;
    maxBytes;
    projects;
    ledger;
    constructor(db, limits, maxBytes) {
        this.db = db;
        this.limits = limits;
        this.maxBytes = maxBytes;
        this.projects = new ProjectStore(db, limits.source, maxBytes);
        this.ledger = new TestLedger(limits, maxBytes);
    }
    validate(definition, current, allowArchived = false) {
        const pin = definition.project, project = this.projects.get(pin.id, current ? undefined : pin.generation);
        this.ledger.validate(definition, project, current, allowArchived);
    }
    read(id) {
        const row = this.db.prepare('SELECT generation,record FROM test_cases WHERE id=?').get(id);
        if (!row)
            throw new WorkflowRuntimeError('not-found');
        try {
            if (Buffer.byteLength(row.record) > this.maxBytes)
                throw new Error();
            const record = this.ledger.decode(JSON.parse(row.record), id, row.generation);
            if (record.importedFrom) {
                const pin = record.versions[0].definition.project;
                this.ledger.validateImport(record, this.projects.get(pin.id, pin.generation));
            }
            for (const version of record.versions)
                this.validate(version.definition, false);
            return record;
        }
        catch {
            throw new WorkflowRuntimeError('corrupt');
        }
    }
    get(id, generation) {
        return this.ledger.select(this.read(id), generation);
    }
    list() {
        return this.db.prepare('SELECT id FROM test_cases ORDER BY rowid').all().map(({ id }) => {
            const item = this.get(id);
            return { id, generation: item.generation, title: item.definition.title, project: item.definition.project,
                ...(item.archived === undefined ? {} : { archived: item.archived }),
                status: item.status, sha256: item.sha256, actor: item.actor, at: item.at };
        });
    }
    history(id) { return this.read(id); }
    erasure(requestId) {
        const id = parseTest(z.uuid().transform(value => value.toLowerCase()), requestId, 4096);
        const row = this.db.prepare('SELECT request_id,test_id,record FROM test_erasures WHERE request_id=?').get(id);
        if (!row)
            throw new WorkflowRuntimeError('not-found');
        try {
            const saved = parseTest(savedTestErasureSchema, JSON.parse(row.record), 8192), receipt = saved.receipt;
            if (receipt.requestId !== row.request_id || receipt.test.id !== row.test_id || saved.sha256 !== testErasureReceiptHash(receipt)
                || this.db.prepare('SELECT id FROM test_cases WHERE lower(id)=lower(?)').get(receipt.test.id))
                throw new Error();
            const project = this.projects.get(receipt.project.id, receipt.project.generation);
            if (project.acceptedRevision !== receipt.project.revision)
                throw new Error();
            return receipt;
        }
        catch {
            throw new WorkflowRuntimeError('corrupt');
        }
    }
    /** Retained metadata remains a project reference even though unused draft payloads are removed. */
    erasures() {
        const rows = this.db.prepare('SELECT request_id FROM test_erasures ORDER BY request_id LIMIT 10001').all();
        if (rows.length > 10000)
            throw new WorkflowRuntimeError('limit');
        return rows.map(row => this.erasure(row.request_id));
    }
    erasureReferences(id) {
        if (this.db.prepare('SELECT count(*) AS count FROM runs').get().count > 100000)
            throw new WorkflowRuntimeError('limit');
        const rows = this.db.prepare('SELECT id,record FROM runs').iterate();
        let runs = 0;
        for (const row of rows) {
            try {
                if (Buffer.byteLength(row.record) > this.maxBytes)
                    throw new Error();
                const run = parseTest(localRunSchema, JSON.parse(row.record), this.maxBytes);
                if (run.id !== row.id)
                    throw new Error();
                if (run.test?.id.toLowerCase() === id.toLowerCase())
                    runs++;
            }
            catch {
                throw new WorkflowRuntimeError('corrupt');
            }
        }
        const batches = this.db.prepare('SELECT id FROM test_generations ORDER BY id LIMIT 10001').all();
        if (batches.length > 10000)
            throw new WorkflowRuntimeError('limit');
        let generationBatches = 0;
        for (const batch of batches)
            if (this.generation(batch.id).snapshot.cases.some(item => item.id.toLowerCase() === id.toLowerCase()))
                generationBatches++;
        const aliases = this.db.prepare('SELECT count(*) AS count FROM test_cases WHERE lower(id)=lower(?) AND id<>?').get(id, id);
        return { runs, generationBatches, otherReferences: aliases.count };
    }
    /** Atomic single-owner logical removal. Only unused archived manual drafts can lose their definitions. */
    erase(value) {
        const command = parseTest(testErasureRequestSchema, value, 4096);
        this.db.exec('BEGIN IMMEDIATE');
        try {
            if (this.db.prepare('SELECT request_id FROM test_erasures WHERE request_id=?').get(command.requestId)) {
                const receipt = this.erasure(command.requestId);
                verifyTestErasureRetry(receipt, command);
                this.db.exec('COMMIT');
                return receipt;
            }
            if (this.db.prepare('SELECT request_id FROM test_erasures WHERE lower(test_id)=lower(?)').get(command.test.id))
                throw new WorkflowRuntimeError('conflict');
            const record = this.read(command.test.id);
            const review = reviewTestErasure(record, { test: command.test, reviewedHistorySha256: command.reviewedHistorySha256 }, this.erasureReferences(record.id), this.limits, this.maxBytes);
            if (review.reasons.includes('not-archived'))
                throw new WorkflowRuntimeError('conflict');
            if (!review.eligible)
                throw new WorkflowRuntimeError('referenced');
            if (this.db.prepare('SELECT count(*) AS count FROM test_erasures').get().count >= 10000)
                throw new WorkflowRuntimeError('limit');
            const receipt = prepareTestErasureReceipt(command, record);
            const saved = { format: 'jevable.test-erasure/v1', receipt, sha256: testErasureReceiptHash(receipt) };
            this.db.prepare('INSERT INTO test_erasures(request_id,test_id,record) VALUES(?,?,?)').run(command.requestId, receipt.test.id, JSON.stringify(saved));
            const result = this.db.prepare('DELETE FROM test_cases WHERE id=? AND generation=?').run(receipt.test.id, receipt.test.generation);
            if (result.changes !== 1)
                throw new WorkflowRuntimeError('conflict');
            this.db.exec('COMMIT');
            return receipt;
        }
        catch (error) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch { /* A committed but unacknowledged write is inspected by its retained request. */ }
            throw error;
        }
    }
    /** Called inside the project-import transaction; savepoint never commits the surrounding project. */
    importDrafts(tests, project, bundleSha256, actor) {
        this.db.exec('SAVEPOINT imported_test_drafts');
        try {
            const result = tests.cases.map(item => this.apply(parseTest(testCommandSchema, { operation: 'create', actor,
                definition: { ...item.definition, project } }), { bundleSha256, source: item.source, project: item.definition.project, status: item.status }));
            this.db.exec('RELEASE imported_test_drafts');
            return result;
        }
        catch (error) {
            this.db.exec('ROLLBACK TO imported_test_drafts; RELEASE imported_test_drafts');
            throw error;
        }
    }
    execute(value) {
        const command = parseTest(testCommandSchema, value);
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = this.apply(command);
            this.db.exec('COMMIT');
            return result;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    apply(command, importedFrom) {
        const previous = command.operation === 'create' ? undefined : this.read(command.id);
        const { record, test } = this.ledger.prepare(command, previous, importedFrom);
        if (command.operation === 'create') {
            if (this.db.prepare('SELECT id FROM test_cases WHERE lower(id)=lower(?) UNION ALL SELECT test_id AS id FROM test_erasures WHERE lower(test_id)=lower(?)')
                .get(test.id, test.id))
                throw new WorkflowRuntimeError('conflict');
            if (this.db.prepare('SELECT count(*) AS count FROM test_cases').get().count >= 10000)
                throw new WorkflowRuntimeError('limit');
        }
        this.validate(test.definition, command.operation !== 'archive', importedFrom !== undefined);
        this.db.prepare('INSERT INTO test_cases(id,generation,record) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,record=excluded.record')
            .run(test.id, test.generation, JSON.stringify(record));
        return test;
    }
    generation(id) {
        const row = this.db.prepare('SELECT record FROM test_generations WHERE id=?').get(id);
        if (!row)
            throw new WorkflowRuntimeError('not-found');
        try {
            if (Buffer.byteLength(row.record) > this.maxBytes)
                throw new Error();
            const result = this.ledger.decodeGeneration(JSON.parse(row.record), id), snapshot = result.snapshot;
            const pin = snapshot.request.project;
            this.ledger.validateGenerationProject(snapshot, this.projects.get(pin.id, pin.generation));
            for (const item of snapshot.cases)
                this.ledger.validateGeneratedCase(snapshot, item, this.get(item.id, 1));
            return result;
        }
        catch {
            throw new WorkflowRuntimeError('corrupt');
        }
    }
    generations() {
        return this.db.prepare('SELECT id FROM test_generations ORDER BY rowid').all().map(({ id }) => this.generation(id));
    }
    /** The batch and all new drafts commit together; a caller-retained UUID is its retry identity. */
    generate(value) {
        const { id, actor, ...request } = parseTest(generateTestsSchema, value);
        this.db.exec('BEGIN IMMEDIATE');
        try {
            if (this.db.prepare('SELECT id FROM test_generations WHERE id=?').get(id)) {
                const previous = this.generation(id);
                if (!isDeepStrictEqual(previous.snapshot.request, request))
                    throw new WorkflowRuntimeError('conflict');
                this.db.exec('COMMIT');
                return previous;
            }
            if (this.db.prepare('SELECT count(*) AS count FROM test_generations').get().count >= 10000)
                throw new WorkflowRuntimeError('limit');
            const project = this.projects.get(request.project.id);
            if (project.archived)
                throw new WorkflowRuntimeError('archived');
            if (project.generation !== request.project.generation || project.acceptedRevision !== request.project.revision)
                throw new WorkflowRuntimeError('conflict');
            const graph = compileWorkflowYaml(project.revisions.find(item => item.revision === project.acceptedRevision).yaml, this.limits);
            validateTestTriggerMode(request.triggerMode, graph);
            const generated = generateInputs(graph.input, this.limits.binding.data, request.limit);
            const cases = generated.candidates.map((candidate, index) => {
                const test = this.apply(parseTest(testCommandSchema, { operation: 'create', actor, definition: {
                        title: `Generated case ${index + 1} (${candidate.reason})`, project: request.project, input: candidate.input,
                        expectations: [{ kind: 'status', value: 'completed' }], ...triggerMetadata(request)
                    } }));
                return { id: test.id, generation: 1, sha256: test.sha256, definition: test.definition, reason: candidate.reason, path: candidate.path };
            });
            const result = this.ledger.prepareGeneration(id, actor, request, generated, cases), encoded = JSON.stringify(result);
            this.db.prepare('INSERT INTO test_generations(id,record) VALUES(?,?)').run(id, encoded);
            this.db.exec('COMMIT');
            return result;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
}
