import { z } from 'zod';
import { DEFAULT_COMPILER_LIMITS } from "../limits.js";
import { compileWorkflowYaml } from "../workflow/index.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { parseTest } from "./schema.js";
import { inspectTestSuite, readSuiteEntryResult } from "./suite.js";
const nodeId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u);
const stepsSchema = z.object({ run: z.object({ steps: z.array(z.object({ nodeId,
            scope: z.object({ loop: nodeId, index: z.number().int().nonnegative().max(1000000) }).optional(),
            attemptId: z.uuid().optional(), port: nodeId.optional(),
        })).max(50000) }) });
export const TEST_COVERAGE_MAX_STEPS = 100000;
/** Aggregate exact retained test identities against one compiled revision. Reads only testResult;
 * never discovers cases, starts work, infers legacy ports, counts a waiting checkpoint as settled,
 * or counts loop return bookkeeping as another node execution. Private values are not returned. */
export async function testSuiteCoverage(host, value, source, options = {}) {
    if (Object.keys(options).some(key => !['limits', 'signal'].includes(key))
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal)))
        throw new WorkflowRuntimeError('invalid-command');
    const limits = options.limits ?? DEFAULT_COMPILER_LIMITS;
    const { suite, sha256 } = inspectTestSuite(value), graph = compileWorkflowYaml(source, limits);
    const nodes = [], routes = [];
    const definitions = new Map();
    const loops = new Map(graph.nodes.filter(node => node.plan.kind === 'loop').map(node => [node.id, node]));
    const key = (scope, id) => JSON.stringify([scope, id]);
    const add = (scope, node) => {
        definitions.set(key(scope, node.id), node);
        nodes.push({ scope, nodeId: node.id, kind: node.plan.kind, settledResults: 0, runs: 0 });
        for (const [port, to] of Object.entries(node.destinations))
            routes.push({ scope, from: node.id, port, to, kind: 'continuation', selections: 0, runs: 0 });
    };
    for (const node of graph.nodes) {
        add('workflow', node);
        if (node.plan.kind === 'loop') {
            const scope = `workflow/${node.id}`;
            for (const child of node.plan.body.nodes)
                add(scope, child);
            for (const exit of node.plan.body.exits)
                routes.push({ scope, from: exit.from, port: exit.port, kind: 'loop-return', selections: 0, runs: 0 });
        }
    }
    const byNode = new Map(nodes.map(node => [key(node.scope, node.nodeId), node]));
    const outgoing = new Map();
    for (const route of routes) {
        const id = key(route.scope, route.from);
        outgoing.set(id, [...outgoing.get(id) ?? [], route]);
    }
    const entries = [];
    let totalSteps = 0, resultsWithoutRecordedPort = 0, loopIterationReturns = 0;
    for (const [index, item] of suite.entries.entries()) {
        if (options.signal?.aborted)
            break;
        const entry = { index, ...item, observation: 'not-observed' };
        entries.push(entry);
        let raw;
        try {
            raw = await host.testResult(item.runId);
        }
        catch (error) {
            const code = error instanceof WorkflowRuntimeError ? error.code : error && typeof error === 'object' && 'code' in error ? error.code : undefined;
            if (code === 'not-found')
                continue;
            const safe = new Set(['conflict', 'corrupt', 'closed', 'limit', 'ownership-lost', 'commit-uncertain', 'unavailable',
                'request-timeout', 'transport-uncertain', 'protocol-mismatch', 'unauthorized', 'instance-mismatch']);
            entry.error = { stage: 'read', code: typeof code === 'string' && safe.has(code) ? code : 'operation-failed', execution: 'not-requested' };
            // A failed owner/pin/read is not permission to rebind or probe further entries.
            break;
        }
        // Bound the full response before parsing; extra private fields are stripped by the metadata reader.
        const receipt = parseTest(stepsSchema, raw, 20000000);
        const result = readSuiteEntryResult(raw, entry);
        if (result.revision !== graph.source.revision)
            throw new WorkflowRuntimeError('conflict');
        totalSteps += receipt.run.steps.length;
        if (totalSteps > TEST_COVERAGE_MAX_STEPS)
            throw new WorkflowRuntimeError('limit');
        const seenNodes = new Set(), seenRoutes = new Set();
        const positions = new Set();
        for (const step of receipt.run.steps) {
            const scope = step.scope ? `workflow/${step.scope.loop}` : 'workflow';
            if (step.scope) {
                const loop = loops.get(step.scope.loop);
                if (loop?.plan.kind !== 'loop' || step.scope.index >= loop.plan.maxIterations)
                    throw new WorkflowRuntimeError('corrupt');
                if (step.nodeId === step.scope.loop && step.attemptId === undefined) {
                    // Without an attempt, a colliding legacy body ID cannot be distinguished from bookkeeping.
                    if (step.port !== undefined || definitions.has(key(scope, step.nodeId)))
                        throw new WorkflowRuntimeError('corrupt');
                    const position = key(scope, `return:${step.scope.index}`);
                    if (positions.has(position))
                        throw new WorkflowRuntimeError('corrupt');
                    positions.add(position);
                    loopIterationReturns++;
                    continue;
                }
            }
            const id = key(scope, step.nodeId), node = byNode.get(id);
            const position = JSON.stringify([scope, step.scope?.index, step.nodeId]);
            if (!node || positions.has(position))
                throw new WorkflowRuntimeError('corrupt');
            positions.add(position);
            node.settledResults++;
            seenNodes.add(node);
            const choices = outgoing.get(id) ?? [];
            if (step.port === undefined) {
                if (choices.length)
                    resultsWithoutRecordedPort++;
                continue;
            }
            const selected = choices.filter(route => route.port === step.port);
            if (selected.length !== 1)
                throw new WorkflowRuntimeError('corrupt');
            selected[0].selections++;
            seenRoutes.add(selected[0]);
        }
        for (const node of seenNodes)
            node.runs++;
        for (const route of seenRoutes)
            route.runs++;
        entry.result = result;
        entry.observation = 'retained';
    }
    // Preserve unobserved manifest entries after an unavailable owner without issuing additional reads.
    for (let index = entries.length; index < suite.entries.length; index++)
        entries.push({ index, ...suite.entries[index], observation: 'not-observed' });
    return { schemaVersion: 1, kind: 'JevableTestSuiteCoverage', suiteSha256: sha256, revision: graph.source.revision,
        observationStatus: options.signal?.aborted ? 'interrupted' : entries.every(entry => entry.result !== undefined) ? 'complete' : 'partial', entries, nodes, routes,
        summary: { selectedRuns: suite.entries.length, observedRuns: entries.filter(entry => entry.result).length,
            terminalRuns: entries.filter(entry => entry.result?.terminal).length,
            passedAssessments: entries.filter(entry => entry.result?.assessment === 'passed').length,
            nodesWithResults: nodes.filter(node => node.settledResults > 0).length, totalNodes: nodes.length,
            routesWithSelections: routes.filter(route => route.selections > 0).length, totalRoutes: routes.length,
            resultsWithoutRecordedPort, loopIterationReturns }, consistency: 'per-run-observations; not-an-atomic-snapshot',
        execution: 'not-requested', semantics: 'settled-results-and-recorded-port-selections; not-path-or-condition-coverage' };
}
