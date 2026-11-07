import { validateWorkflowValue } from "../workflow/index.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
export function validateTestTriggerMode(triggerMode, graph) {
    if (triggerMode === undefined)
        return;
    const trigger = graph.nodes[0]?.plan;
    if (triggerMode !== 'api' || trigger?.kind !== 'trigger' || !trigger.modes.includes('api'))
        throw new WorkflowRuntimeError('invalid-command');
}
/** Same semantic admission for local drafts and untrusted transferred definitions; no execution. */
export function validateTestSource(definition, graph, limits) {
    validateTestTriggerMode(definition.triggerMode, graph);
    validateWorkflowValue(graph.input, definition.input, limits.binding.data);
    for (const expectation of definition.expectations) {
        if (!('nodeId' in expectation))
            continue;
        const loop = expectation.scope ? graph.nodes.find(node => node.id === expectation.scope.loop)?.plan : undefined;
        const nodes = expectation.scope ? loop?.kind === 'loop' ? loop.body.nodes : [] : graph.nodes;
        const selected = nodes.find(node => node.id === expectation.nodeId);
        if (!selected)
            throw new WorkflowRuntimeError('invalid-command');
        if (expectation.kind === 'node-port-equals') {
            const exits = expectation.scope && loop?.kind === 'loop' ? loop.body.exits : [];
            if (!Object.hasOwn(selected.destinations, expectation.value)
                && !exits.some(exit => exit.from === selected.id && exit.port === expectation.value))
                throw new WorkflowRuntimeError('invalid-command');
        }
    }
}
