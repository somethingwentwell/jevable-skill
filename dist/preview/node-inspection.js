import { z } from 'zod';
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { executionCheckpointHash, localRunSchema } from "../runtime/run-types.js";
import { runReceipt } from "../runtime/receipts.js";
import { admitWorkflowData, parseWorkflow } from "../workflow/index.js";
import { DEFAULT_COMPILER_LIMITS } from "../limits.js";
import { projectPreviewExecution } from "./execution.js";
export const previewNodeSelectionSchema = z.strictObject({
    graphScope: z.string().min(1).max(256), nodeId: z.string().min(1).max(128),
    record: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('step'), index: z.number().int().min(0).max(49999) }),
        z.strictObject({ kind: z.literal('checkpoint') }),
    ]),
});
export const previewNodeInspectionRequestSchema = z.strictObject({ id: z.uuid(),
    expectedCheckpointSha256: z.string().regex(/^[a-f0-9]{64}$/u), selection: previewNodeSelectionSchema });
/** Private, detached projection of one exact retained record. Never binds, executes or reconstructs values. */
export function projectPreviewNodeInspection(preview, value, request, sourceLimits = DEFAULT_COMPILER_LIMITS.source) {
    const selected = previewNodeInspectionRequestSchema.safeParse(request);
    if (!selected.success)
        throw new WorkflowRuntimeError('invalid-command');
    let parsed;
    try {
        parsed = localRunSchema.safeParse(value);
    }
    catch {
        throw new WorkflowRuntimeError('corrupt');
    }
    if (!parsed.success)
        throw new WorkflowRuntimeError('corrupt');
    const run = parsed.data, command = selected.data;
    if (run.id !== command.id || !preview.revision || run.revision !== preview.revision)
        throw new WorkflowRuntimeError('not-found');
    if (run.state.steps.length > 50000)
        throw new WorkflowRuntimeError('limit');
    try {
        if (parseWorkflow(run.yaml, sourceLimits).revision !== preview.revision)
            throw Error('Source identity');
        projectPreviewExecution(preview, runReceipt(run));
    }
    catch {
        throw new WorkflowRuntimeError('corrupt');
    }
    const checkpointSha256 = executionCheckpointHash(run);
    if (checkpointSha256 !== command.expectedCheckpointSha256)
        throw new WorkflowRuntimeError('conflict');
    const graph = preview.graphs.find(graph => graph.scope === command.selection.graphScope);
    const node = graph?.nodes.find(node => node.id === command.selection.nodeId);
    if (!graph || !node)
        throw new WorkflowRuntimeError('not-found');
    const state = run.state, record = command.selection.record;
    const step = record.kind === 'step' ? state.steps[record.index] : undefined;
    if (record.kind === 'step' && !step)
        throw new WorkflowRuntimeError('not-found');
    if (record.kind === 'checkpoint' && state.status === 'completed')
        throw new WorkflowRuntimeError('not-found');
    const nodeId = step?.nodeId ?? (state.status === 'failed' ? state.nodeId : 'next' in state ? state.next : undefined);
    const scope = step ? step.scope : 'scope' in state ? state.scope : undefined;
    const inspection = step?.inspection ?? (!step && state.status === 'failed' ? state.inspection : undefined);
    const attempt = !step && 'attempt' in state ? state.attempt : undefined;
    const bookkeeping = Boolean(step && scope && nodeId === scope.loop && !inspection?.attemptId);
    const parent = scope ? preview.graphs[0].nodes.find(node => node.id === scope.loop && node.bodyScope) : undefined;
    const actualGraph = !scope || bookkeeping ? preview.graphs[0].scope : parent?.bodyScope;
    if (nodeId !== node.id || actualGraph !== graph.scope)
        throw new WorkflowRuntimeError('not-found');
    const field = (value, present) => {
        if (!present)
            return { status: 'unavailable' };
        try {
            return { status: 'recorded', value: admitWorkflowData(value, { maxBytes: 8_000_000, maxDepth: 128, maxValues: 1_000_000 }) };
        }
        catch {
            throw new WorkflowRuntimeError('limit');
        }
    };
    const input = attempt?.prepared.status === 'ready' ? field(attempt.prepared.input, true)
        : field(inspection?.input, inspection !== undefined && Object.hasOwn(inspection, 'input'));
    const output = step ? field(step.output, true) : { status: attempt ? 'unsettled' : 'unavailable' };
    const result = { schemaVersion: 1, format: 'jevable.preview-node-inspection/v1', privateInspection: true,
        runId: run.id, revision: run.revision, checkpointSha256, selection: command.selection,
        kind: step ? bookkeeping ? 'loop-iteration-result' : node.node.type === 'loop' ? 'loop-aggregate' : 'node-result' : 'checkpoint',
        status: step ? 'settled' : state.status, input, output,
        ...(scope ? { scope } : {}), ...(inspection?.attemptId || attempt ? { attemptId: inspection?.attemptId ?? attempt.id } : {}),
        ...(step?.port ? { port: step.port } : {}),
        ...(!step && state.status === 'failed' ? { code: state.code } : {}),
        ...(!step && state.status === 'cancelled' ? { previousStatus: state.previousStatus } : {}) };
    // Two independently bounded fields plus their envelope must fit the fixed live response ceiling.
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 16_000_000)
        throw new WorkflowRuntimeError('limit');
    return result;
}
