/** Static graph admission shared by release inspection and actual execution.
 * This module has no evaluator, provider transport, telemetry or vendor-import
 * dependency. Admission remains complete even when no node will be executed.
 */
import { compileWorkflowYaml } from "../workflow/compiler.js";
import { WorkflowRuntimeError } from "./errors.js";
import { aiStepBudget } from "./run-budget.js";
/** Plan kinds the local runtime executes; others compile but are refused before any node runs. */
export const LOCAL_PLAN_KINDS = ['trigger', 'ifElse', 'switch', 'output', 'llm', 'decision', 'loop', 'humanApproval'];
/** List every plan kind in encounter order, including loop bodies and duplicates. */
export function planKinds(nodes) {
    return nodes.flatMap(node => [node.plan.kind, ...node.plan.kind === 'loop' ? planKinds(node.plan.body.nodes) : []]);
}
/** Compile the entire supported graph, including untaken branches and loop bodies,
 * under the caller's compiler/resource policy before admitting any execution.
 */
export function compileRuntimeWorkflow(yaml, limits) {
    const graph = compileWorkflowYaml(yaml, limits);
    if (planKinds(graph.nodes).some(kind => !LOCAL_PLAN_KINDS.includes(kind))) {
        throw new WorkflowRuntimeError('invalid-command');
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the compiler requires one reachable entry trigger
    const trigger = graph.nodes[0].plan;
    if (trigger.kind !== 'trigger' || !trigger.modes.some(mode => mode === 'manual' || mode === 'chat' || mode === 'api'))
        throw new WorkflowRuntimeError('invalid-command');
    aiStepBudget(graph);
    return graph;
}
/** Model plans from the complete graph; never reads provider storage or dispatches. */
export function executionModelPlans(graph) {
    const plans = [];
    const visit = (nodes) => {
        for (const node of nodes) {
            if (node.plan.kind === 'loop')
                visit(node.plan.body.nodes);
            if (node.plan.kind !== 'llm' && node.plan.kind !== 'decision')
                continue;
            plans.push(node.plan);
        }
    };
    visit(graph.nodes);
    return plans;
}
