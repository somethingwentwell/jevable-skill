/** Shared node settlement and durable dispatch for ordinary runs and debug checkpoints. */
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { deepFreeze } from "../shared/values.js";
import { evaluateBinding, evaluateResolvedRule, validateWorkflowValue, validateDecisionAnswers, WorkflowExpressionError, WorkflowValueError } from "../workflow/index.js";
import { WorkflowRuntimeError } from "./errors.js";
import { endRunSpan, savedRunTrace, observeCommittedRuleRoute } from "./run-telemetry.js";
import { modelValue } from "./model-format.js";
import { modelHistory, modelInput, modelRequestPlan } from "./model-plan.js";
import { compileRuntimeWorkflow, executionModelPlans } from "./admission.js";
export { LOCAL_PLAN_KINDS, planKinds, compileRuntimeWorkflow, executionModelPlans } from "./admission.js";
import { aiStepBudget } from "./run-budget.js";
/** Select one admitted start contract; there is no implicit API/webhook ingress or mode fallback. */
export function compileLocalRun(yaml, limits, triggerMode) {
    if (triggerMode !== undefined && triggerMode !== 'api')
        throw new WorkflowRuntimeError('invalid-command');
    const graph = compileRuntimeWorkflow(yaml, limits), trigger = graph.nodes[0].plan;
    if (trigger.kind !== 'trigger' || !(triggerMode === 'api' ? trigger.modes.includes('api')
        : trigger.modes.some(mode => mode === 'manual' || mode === 'chat')))
        throw new WorkflowRuntimeError('invalid-command');
    return graph;
}
/**
 * Whether the revision's AI step limit forbids starting another LLM or Decision step, counted from committed steps.
 * @param graph - Admitted graph; its limit was validated at admission.
 * @param steps - Committed steps; loop iteration results are not AI steps.
 * @returns true when the run already committed as many AI steps as the limit allows.
 */
function aiBudgetReached(graph, steps) {
    const limit = aiStepBudget(graph);
    if (limit === undefined)
        return false;
    const kind = (step) => findNode(graph, step.nodeId, step.scope)?.plan.kind;
    return steps.filter(step => kind(step) === 'llm' || kind(step) === 'decision').length >= limit;
}
/**
 * Pause before the first executable node without calculating its output.
 * @param graph - Admitted nonempty graph.
 * @returns an empty checkpoint pinned to the entry node.
 */
export function initialCheckpoint(graph) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the compiler requires a nonempty graph
    return { status: 'paused', steps: [], next: graph.nodes[0].id };
}
/**
 * Find the compiled node a continuation or step names, inside its loop body when scoped.
 * @param graph - Admitted graph.
 * @param id - Node identity.
 * @param scope - Loop iteration for body nodes.
 * @returns the node, or undefined when the identity does not exist at that scope (for example an iteration result).
 */
export function findNode(graph, id, scope) {
    if (!scope)
        return graph.nodes.find(node => node.id === id);
    const loop = graph.nodes.find(node => node.id === scope.loop)?.plan;
    return loop?.kind === 'loop' ? loop.body.nodes.find(node => node.id === id) : undefined;
}
/**
 * Whether a node identity exists in the graph or any loop body; body identities never repeat outer ones.
 * @param graph - Admitted graph.
 * @param id - Candidate identity, such as a debugger breakpoint.
 * @returns true when some outer or body node has that identity.
 */
export function hasNode(graph, id) {
    return graph.nodes.some(node => node.id === id || (node.plan.kind === 'loop' && node.plan.body.nodes.some(step => step.id === id)));
}
function locate(graph, id, scope) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- validated continuations belong to the admitted graph
    return findNode(graph, id, scope);
}
function loopNode(graph, id) {
    return locate(graph, id);
}
/** Values visible at a position: outer outputs plus, inside a loop, the current iteration's body outputs and `loop`. */
function valuesAt(graph, input, steps, scope) {
    const nodes = Object.fromEntries(steps.filter(step => !step.scope).map(step => [step.nodeId, { output: step.output }]));
    if (!scope)
        return { inputs: input, nodes };
    const { plan } = loopNode(graph, scope.loop);
    const outer = { inputs: input, nodes };
    // oxlint-disable-next-line typescript/no-non-null-assertion -- each loop mode compiles its own source binding
    const item = plan.mode === 'forEach' ? evaluateBinding(plan.items, outer)[scope.index]
        // oxlint-disable-next-line typescript/no-non-null-assertion -- each loop mode compiles its own source binding
        : evaluateBinding(plan.input, outer);
    const body = steps.filter(step => step.scope?.loop === scope.loop && step.scope.index === scope.index && step.nodeId !== scope.loop);
    return { inputs: input, nodes: { ...nodes, ...Object.fromEntries(body.map(step => [step.nodeId, { output: step.output }])) },
        loop: { item, index: scope.index } };
}
/**
 * Earlier LLM exchanges visible at a position, oldest first: outer steps plus, inside a loop, the current iteration's
 * body steps, matching expression visibility. Steps saved without their resolved prompt are skipped.
 */
function runExchanges(graph, checkpoint) {
    const { scope } = checkpoint;
    return checkpoint.steps.flatMap((step) => {
        if (step.scope && (step.scope.loop !== scope?.loop || step.scope.index !== scope.index))
            return [];
        const input = step.inspection?.input;
        return findNode(graph, step.nodeId, step.scope)?.plan.kind === 'llm' && typeof input?.prompt === 'string'
            ? [{ nodeId: step.nodeId, prompt: input.prompt, reply: step.output }] : [];
    });
}
/**
 * Resolve only the next node's input; no output validation, route selection or external dispatch occurs.
 * A Human Approval input is also validated against its review schema, because reviewers see exactly this value.
 */
function prepareNodeInput(graph, input, checkpoint, limits) {
    const plan = locate(graph, checkpoint.next, checkpoint.scope).plan;
    try {
        const values = valuesAt(graph, input, checkpoint.steps, checkpoint.scope);
        let resolved;
        if (plan.kind === 'trigger')
            resolved = input;
        else if (plan.kind === 'ifElse')
            resolved = evaluateBinding(plan.condition, values);
        else if (plan.kind === 'llm') {
            resolved = { prompt: evaluateBinding(plan.prompt, values), systemPrompt: evaluateBinding(plan.systemPrompt, values),
                ...plan.history.scope === 'current-run' ? { history: modelHistory(plan.history, runExchanges(graph, checkpoint)) } : {} };
        }
        else if (plan.kind === 'decision')
            resolved = evaluateBinding(plan.state, values);
        else if (plan.kind === 'humanApproval') {
            resolved = { title: evaluateBinding(plan.title, values),
                input: validateWorkflowValue(plan.input.schema, evaluateBinding(plan.input.binding, values), limits) };
        }
        // oxlint-disable-next-line typescript/no-non-null-assertion -- each loop mode compiles its own source binding
        else if (plan.kind === 'loop')
            resolved = evaluateBinding(plan.mode === 'forEach' ? plan.items : plan.input, values);
        else {
            /* v8 ignore if -- whole-graph admission rejects unsupported node families. */
            if (plan.kind !== 'switch' && plan.kind !== 'output')
                throw new WorkflowRuntimeError('invalid-command');
            resolved = evaluateBinding(plan.value, values);
        }
        return { status: 'ready', input: structuredClone(resolved) };
    }
    catch (error) {
        /* v8 ignore if -- implementation defects propagate rather than becoming retained input failures. */
        if (!(error instanceof WorkflowValueError || error instanceof WorkflowExpressionError))
            throw error;
        return { status: 'invalid-node-value' };
    }
}
/**
 * Retain the admitted identity and available input when an attempt settles or becomes uncertain.
 * @param attempt - Saved pre-dispatch input preparation; presence does not prove dispatch occurred.
 * @returns inspection data without fabricated output or trace context.
 */
export function attemptInspection(attempt) {
    return { attemptId: attempt.id, ...(attempt.trace ? { trace: attempt.trace } : {}), ...attempt.prepared.status === 'ready' ? { input: attempt.prepared.input } : {} };
}
/**
 * Validate saved preparation without executing the pending node.
 * @param attempt - Optional legacy-compatible admission record.
 * @param graph - Validated graph; preparation does not invoke external operations.
 * @param input - Frozen run input.
 * @param checkpoint - Previously validated committed prefix and continuation.
 * @param limits - Runtime value bounds used for review-schema validation.
 * @returns whether the pending identity is new and its preparation matches the pinned inputs.
 */
export function preparedAttemptMatches(attempt, graph, input, checkpoint, limits) {
    return !attempt || (attempt.nodeId === checkpoint.next
        && !checkpoint.steps.some(step => step.inspection?.attemptId === attempt.id)
        && isDeepStrictEqual(attempt.prepared, prepareNodeInput(graph, input, checkpoint, limits)));
}
/** Close a loop: its unscoped step carries every iteration result, then the outer graph continues through `port`. */
function finishLoop(loop, steps, port) {
    const results = steps.filter(step => step.nodeId === loop.id && step.scope?.loop === loop.id).map(step => structuredClone(step.output));
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the compiler checks every loop port destination
    return { status: 'paused', steps: [...steps, { nodeId: loop.id, output: { results, count: results.length }, port }], next: loop.destinations[port] };
}
/** Route inside a loop body: continue, or record the iteration result and start the next iteration or close the loop. */
function continueBody(graph, input, scope, node, steps, port) {
    const next = node.destinations[port];
    if (next !== undefined)
        return { status: 'paused', steps, next, scope: { ...scope } };
    const loop = loopNode(graph, scope.loop), { plan } = loop;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the compiler requires an exit for every unconnected body port
    const exit = plan.body.exits.find(candidate => candidate.from === node.id && candidate.port === port);
    let result;
    try {
        result = evaluateBinding(exit.result, valuesAt(graph, input, steps, scope));
    }
    catch (error) {
        /* v8 ignore if -- implementation defects propagate rather than becoming retained value failures. */
        if (!(error instanceof WorkflowValueError || error instanceof WorkflowExpressionError))
            throw error;
        return { status: 'failed', steps, nodeId: node.id, code: 'invalid-node-value', scope: { ...scope } };
    }
    const settled = [...steps, { nodeId: loop.id, output: structuredClone(result), scope: { ...scope } }];
    const restart = { status: 'paused', steps: settled, next: plan.body.entry, scope: { loop: loop.id, index: scope.index + 1 } };
    if (plan.mode === 'forEach') {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- For Each compiles an items binding
        const items = evaluateBinding(plan.items, valuesAt(graph, input, settled));
        return scope.index + 1 < items.length ? restart : finishLoop(loop, settled, 'done');
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- Repeat Until compiles its condition
    if (evaluateBinding(plan.until, { ...valuesAt(graph, input, settled), loop: { item: result, index: scope.index } }) === true) {
        return finishLoop(loop, settled, 'done');
    }
    if (scope.index + 1 < plan.maxIterations)
        return restart;
    return plan.onLimit === 'branch' ? finishLoop(loop, settled, 'limit') : { status: 'failed', steps: settled, nodeId: loop.id, code: 'loop-limit' };
}
/**
 * Execute exactly one node using only committed preceding values; never mutate the supplied checkpoint.
 * Entering a loop adds no step; a body node that exits its iteration also adds that iteration's result, and the last
 * iteration adds the loop's output.
 * @param graph - Admitted graph containing the checkpoint's next node.
 * @param input - Validated, revision-pinned run input.
 * @param checkpoint - Previously validated paused checkpoint.
 * @param limits - Runtime value bounds.
 * @param span - Optional live attempt span; always ended, never created during retained-data validation.
 * @param attempt - Already committed preparation for dispatch; omitted only for pure retained-data validation.
 * @param modelOutput - Exact model text or collector arguments saved before settlement or used in side-effect-free validation.
 * @param approval - Saved Human Approval decision; the caller has checked a named action against the node's actions.
 * @returns the next pause or terminal outcome; declared data failures use a fixed safe category.
 */
export function advanceCheckpoint(graph, input, checkpoint, limits, span, attempt, modelOutput, approval) {
    const scope = checkpoint.scope;
    const node = locate(graph, checkpoint.next, scope);
    const inspection = { ...attempt ? attemptInspection(attempt) : {}, ...span ? { trace: savedRunTrace(span) } : {} };
    const failed = (steps) => ({ status: 'failed', steps, nodeId: node.id, code: 'invalid-node-value', inspection,
        ...scope ? { scope: { ...scope } } : {} });
    let outcome = 'commit-or-execution-failed';
    try {
        const prepared = attempt?.prepared ?? prepareNodeInput(graph, input, checkpoint, limits);
        if (prepared.status !== 'ready') {
            outcome = 'invalid-node-value';
            return failed(checkpoint.steps);
        }
        inspection.input = prepared.input;
        const plan = node.plan;
        let output, port = 'next';
        if (plan.kind === 'trigger')
            output = prepared.input;
        else if (plan.kind === 'llm' || plan.kind === 'decision') {
            if (aiBudgetReached(graph, checkpoint.steps)) {
                outcome = 'stopped';
                return { status: 'failed', steps: checkpoint.steps, nodeId: node.id, code: 'ai-budget', inspection, ...scope ? { scope: { ...scope } } : {} };
            }
            if (modelOutput === undefined)
                throw new WorkflowRuntimeError('corrupt');
            inspection.modelOutput = modelOutput;
            output = modelValue(modelRequestPlan(plan), modelOutput, limits);
            if (plan.kind === 'decision')
                output = validateDecisionAnswers(plan, output, limits);
        }
        else if (plan.kind === 'ifElse' || plan.kind === 'switch') {
            const result = evaluateResolvedRule(plan, prepared.input);
            output = result.output;
            port = result.port;
        }
        else if (plan.kind === 'humanApproval') {
            if (approval === undefined || (approval.kind === 'action' && !plan.actions.includes(approval.action))) {
                throw new WorkflowRuntimeError('corrupt');
            }
            inspection.approval = approval;
            port = approval.kind === 'expired' ? 'timeout' : approval.action;
            if (approval.kind === 'expired' ? plan.onTimeout === 'expired' : port === 'reject' && plan.onReject === 'cancelled') {
                outcome = 'stopped';
                return { status: 'failed', steps: checkpoint.steps, nodeId: node.id, inspection,
                    code: approval.kind === 'expired' ? 'approval-expired' : 'approval-rejected', ...scope ? { scope: { ...scope } } : {} };
            }
            output = { action: port };
        }
        else if (plan.kind === 'loop') {
            outcome = 'completed';
            const items = prepared.input;
            if (plan.mode === 'forEach' && items.length > plan.maxIterations) {
                outcome = 'invalid-node-value';
                return { status: 'failed', steps: checkpoint.steps, nodeId: node.id, code: 'loop-limit', inspection };
            }
            if (plan.mode === 'forEach' && items.length === 0)
                return finishLoop(node, checkpoint.steps, 'done');
            return { status: 'paused', steps: checkpoint.steps, next: plan.body.entry, scope: { loop: node.id, index: 0 } };
        }
        else {
            /* v8 ignore next -- whole-graph admission rejects unsupported node families. */
            if (plan.kind !== 'output')
                throw new WorkflowRuntimeError('invalid-command');
            const value = prepared.input;
            output = plan.schema ? validateWorkflowValue(plan.schema, value, limits) : value;
            outcome = 'completed';
            return { status: 'completed', steps: [...checkpoint.steps, { nodeId: node.id, output: structuredClone(output), inspection }],
                output: structuredClone(output) };
        }
        outcome = 'completed';
        const steps = [...checkpoint.steps,
            { nodeId: node.id, output: structuredClone(output), port, inspection, ...scope ? { scope: { ...scope } } : {} }];
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the compiler checks every branch destination
        return scope ? continueBody(graph, input, scope, node, steps, port) : { status: 'paused', steps, next: node.destinations[port] };
    }
    catch (error) {
        /* v8 ignore if -- evaluator defects propagate; only output-schema failures become a safe node outcome. */
        if (!(error instanceof WorkflowValueError))
            throw error;
        outcome = 'invalid-node-value';
        return failed(checkpoint.steps);
    }
    finally {
        endRunSpan(span, outcome);
    }
}
function samePosition(checkpoint, target) {
    return checkpoint.status === 'paused' && checkpoint.next === target.next && isDeepStrictEqual(checkpoint.scope, target.scope);
}
/**
 * Recompute saved steps without side effects, feeding recorded model outputs, until the saved position is reached.
 * @param graph - Source-pinned graph.
 * @param input - Frozen run input.
 * @param steps - Saved committed steps.
 * @param limits - Runtime value bounds.
 * @param target - Saved continuation; omitted to stop at the saved step count.
 * @returns the recomputed checkpoint; a saved record that diverges fails comparison with it.
 */
export function replayCheckpoint(graph, input, steps, limits, target) {
    let expected = initialCheckpoint(graph);
    while (expected.status === 'paused' && (expected.steps.length < steps.length || (target !== undefined && !samePosition(expected, target)))) {
        const before = expected.steps.length;
        if (before >= steps.length && expected.scope === undefined && findNode(graph, expected.next)?.plan.kind !== 'loop')
            break;
        expected = advanceCheckpoint(graph, input, expected, limits, undefined, undefined, steps[before]?.inspection?.modelOutput, steps[before]?.inspection?.approval);
        if (expected.steps.length > steps.length)
            break;
    }
    return expected;
}
/**
 * Recompute a saved terminal outcome: replay the saved steps, then advance until a node settles without adding steps.
 * @param graph - Source-pinned graph.
 * @param input - Frozen run input.
 * @param actual - Saved completed or failed outcome, with optional model outputs on its inspections.
 * @param limits - Runtime value bounds.
 * @returns the recomputed terminal checkpoint, or a paused one when the saved record ends early.
 */
export function replayOutcome(graph, input, actual, limits) {
    let expected = replayCheckpoint(graph, input, actual.steps, limits);
    for (let guard = 0; expected.status === 'paused' && expected.steps.length === actual.steps.length && guard < 2; guard++) {
        expected = advanceCheckpoint(graph, input, expected, limits, undefined, undefined, actual.status === 'failed' ? actual.inspection?.modelOutput : undefined, actual.status === 'failed' ? actual.inspection?.approval : undefined);
    }
    return expected;
}
/**
 * Validate stored values and any recorded resolved input without fabricating metadata for older records.
 * @param actual - Stored checkpoint, with legacy inspection omissions permitted.
 * @param expected - Side-effect-free deterministic evaluation; never supplied by an external node adapter.
 * @returns whether execution values and each present input snapshot match; trace IDs are not recomputed.
 */
export function checkpointMatches(actual, expected) {
    const plain = (checkpoint) => ({ status: checkpoint.status,
        ...checkpoint.status === 'paused' ? { next: checkpoint.next, scope: checkpoint.scope }
            : checkpoint.status === 'completed' ? { output: checkpoint.output }
                : { nodeId: checkpoint.nodeId, code: checkpoint.code, scope: checkpoint.scope },
        steps: checkpoint.steps.map(step => ({ nodeId: step.nodeId, output: step.output, scope: step.scope })),
    });
    if (!isDeepStrictEqual(plain(actual), plain(expected)))
        return false;
    // Re-evaluation validates present port evidence; it must not backfill a port into an older stored record.
    if (actual.steps.some((step, index) => step.port !== undefined && step.port !== expected.steps[index]?.port))
        return false;
    const ids = [...actual.steps.map(step => step.inspection?.attemptId),
        ...actual.status === 'failed' ? [actual.inspection?.attemptId] : []].filter(id => id !== undefined);
    if (new Set(ids).size !== ids.length)
        return false;
    if (!actual.steps.every((step, index) => !step.inspection
        || isDeepStrictEqual(step.inspection.input, expected.steps[index]?.inspection?.input)))
        return false;
    return actual.status !== 'failed' || !actual.inspection
        || (expected.status === 'failed' && isDeepStrictEqual(actual.inspection.input, expected.inspection?.input));
}
/**
 * Commit intent before executing one node and commit its result before allowing a successor.
 * @param graph - Graph admitted under the configured execution policy.
 * @param input - Frozen run input.
 * @param checkpoint - Last committed values and exact next node.
 * @param limits - Explicit runtime value bounds.
 * @param persistence - Owning journal writes and attempt span factory; failures propagate without retry.
 * @param models - Explicitly configured model executor; absent policies refuse LLM admission.
 * @param signal - User cancellation forwarded to an in-flight model call.
 * @returns the owner's committed result. A failed result write must leave its intent uncertain. A Human Approval node with
 * a valid review input produces a waiting task instead of a settled step.
 */
export async function advanceDurably(graph, input, checkpoint, limits, persistence, models, signal) {
    let attempt = deepFreeze({ id: randomUUID(), nodeId: checkpoint.next,
        prepared: prepareNodeInput(graph, input, checkpoint, limits) });
    let span;
    const started = Date.now();
    let outcome = 'commit-or-execution-failed';
    try {
        await persistence.intent(attempt);
        span = await persistence.span(attempt.id);
        const trace = savedRunTrace(span);
        if (trace) {
            attempt = deepFreeze({ ...attempt, trace });
            await persistence.tracedIntent?.(attempt);
        }
        signal?.throwIfAborted();
        const plan = locate(graph, checkpoint.next, checkpoint.scope).plan;
        if (plan.kind === 'humanApproval' && attempt.prepared.status === 'ready') {
            const result = await persistence.result({ status: 'waiting', steps: checkpoint.steps, next: checkpoint.next, attempt,
                expiresAt: new Date(Date.now() + plan.expiresAfterMs).toISOString(), ...checkpoint.scope ? { scope: { ...checkpoint.scope } } : {} });
            outcome = 'paused';
            return result;
        }
        let model;
        // A step over the AI step limit settles as `ai-budget` below without contacting the model.
        if ((plan.kind === 'llm' || plan.kind === 'decision') && attempt.prepared.status === 'ready' && !aiBudgetReached(graph, checkpoint.steps)) {
            /* v8 ignore if -- graph admission requires the model executor before saving any intent. */
            if (!models)
                throw new WorkflowRuntimeError('invalid-command');
            model = await models.execute(plan, modelInput(plan, attempt.prepared.input), attempt.id, signal);
        }
        // Do not end a node span until its result is durably committed.
        const next = advanceCheckpoint(graph, input, checkpoint, limits, undefined, attempt, model?.output);
        const result = await persistence.result(annotated(timed(next, attempt.id, started), attempt.id, model ? { modelUsage: model.usage } : {}));
        if (plan.kind === 'ifElse' || plan.kind === 'switch') {
            const selected = next.steps.slice(checkpoint.steps.length).find(step => step.nodeId === checkpoint.next
                && step.inspection?.attemptId === attempt.id);
            observeCommittedRuleRoute(span, selected?.port);
        }
        outcome = next.status === 'failed' ? 'invalid-node-value' : 'completed';
        return result;
    }
    finally {
        endRunSpan(span, outcome);
    }
}
/**
 * Add observed metadata to the step or failure that settled one attempt.
 * @param next - Settled checkpoint from the evaluator.
 * @param id - Attempt that produced it; loop iteration results and other attempts are unchanged.
 * @param extra - Inspection fields replay validation never recomputes, such as timing and model use.
 * @returns a copy with the fields on that attempt's inspection.
 */
export function annotated(next, id, extra) {
    const steps = next.steps.map(step => step.inspection?.attemptId === id
        ? { ...step, inspection: { ...step.inspection, ...extra } } : step);
    if (next.status !== 'failed' || next.inspection?.attemptId !== id)
        return { ...next, steps };
    return { ...next, steps, inspection: { ...next.inspection, ...extra } };
}
/**
 * Add the observed start time and duration to the step or failure that settled one attempt.
 * @param next - Settled checkpoint from the evaluator.
 * @param id - Attempt that produced it; loop iteration results and other attempts are unchanged.
 * @param started - Epoch milliseconds when the attempt began, such as dispatch or the start of an approval wait.
 * @returns a copy with timing on that attempt's inspection.
 */
export function timed(next, id, started) {
    return annotated(next, id, { startedAt: new Date(started).toISOString(), durationMs: Math.max(0, Date.now() - started) });
}
/** Await every configured admission check before a run or node can be dispatched. */
export async function admitExecution(graph, models) {
    for (const plan of executionModelPlans(graph)) {
        if (!models)
            throw new WorkflowRuntimeError('invalid-command');
        await models.admit(plan);
    }
}
/**
 * Reconcile model settlements with durable Sessions without issuing network calls.
 * @param graph - Source-pinned graph.
 * @param checkpoint - Committed values or failure under validation.
 * @param models - Session-reading model adapter.
 * @returns resolution when every model settlement matches its Session.
 */
export async function verifyModelResults(graph, checkpoint, models) {
    const inspections = [...checkpoint.steps.map(step => ({ nodeId: step.nodeId, scope: step.scope, inspection: step.inspection })),
        ...checkpoint.status === 'failed' ? [{ nodeId: checkpoint.nodeId, scope: checkpoint.scope, inspection: checkpoint.inspection }] : []];
    for (const { nodeId, scope, inspection } of inspections) {
        const node = findNode(graph, nodeId, scope);
        if (inspection?.approval !== undefined && node?.plan.kind !== 'humanApproval')
            throw new WorkflowRuntimeError('corrupt');
        if (node?.plan.kind !== 'llm' && node?.plan.kind !== 'decision') {
            if (inspection?.modelOutput !== undefined)
                throw new WorkflowRuntimeError('corrupt');
            continue;
        }
        // Binding failures and steps stopped by the AI step limit never dispatch a model and retain no generated text.
        if (checkpoint.status === 'failed' && (inspection?.input === undefined || checkpoint.code === 'ai-budget') && nodeId === checkpoint.nodeId
            && inspection?.attemptId !== undefined && inspection.modelOutput === undefined)
            continue;
        if (!models || !inspection?.attemptId || inspection.input === undefined || inspection.modelOutput === undefined)
            throw new WorkflowRuntimeError('corrupt');
        await models.verify(node.plan, inspection.attemptId, modelInput(node.plan, inspection.input), inspection.modelOutput);
    }
}
