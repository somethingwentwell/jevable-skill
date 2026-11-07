import { isDeepStrictEqual } from 'node:util';
import { runReceipt } from "../runtime/receipts.js";
/** Re-evaluate retained, verified evidence; never invokes models, resumes runs or writes state. */
export function testResult(test, run, inspect = false) {
    const state = run.state, terminal = state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled';
    const checks = test.definition.expectations.map((expectation, index) => {
        let actual, available = true;
        if (expectation.kind === 'status')
            actual = state.status;
        else if (expectation.kind === 'output-equals') {
            available = state.status === 'completed';
            actual = state.status === 'completed' ? state.output : undefined;
        }
        else if (expectation.kind === 'failure-code') {
            available = state.status === 'failed';
            actual = state.status === 'failed' ? state.code : undefined;
        }
        else {
            const step = state.steps.find(item => item.nodeId === expectation.nodeId && isDeepStrictEqual(item.scope, expectation.scope));
            available = expectation.kind === 'node-visited' || (expectation.kind === 'node-port-equals' ? step?.port !== undefined : step !== undefined);
            actual = expectation.kind === 'node-visited' ? step !== undefined : expectation.kind === 'node-port-equals' ? step?.port : step?.output;
        }
        const expected = 'value' in expectation ? expectation.value : true;
        return { index, kind: expectation.kind, matched: available && isDeepStrictEqual(actual, expected), available,
            ...('nodeId' in expectation ? { nodeId: expectation.nodeId, scope: expectation.scope } : {}),
            ...(inspect ? { expected, ...(available ? { actual } : {}) } : {}) };
    });
    const assessment = state.status === 'executing' ? 'uncertain' : state.status === 'paused' ? 'pending'
        : state.status === 'waiting' && !test.definition.expectations.some(item => item.kind === 'status' && item.value === 'waiting') ? 'pending'
            : checks.every(item => item.matched) ? 'passed' : 'failed';
    return { schemaVersion: 1, test: run.test, title: test.definition.title, assessment, workflowStatus: state.status,
        terminal, observedRunUpdatedAt: run.updatedAt, evidence: 'retained-run', privateInspection: inspect,
        checks, run: runReceipt(run) };
}
