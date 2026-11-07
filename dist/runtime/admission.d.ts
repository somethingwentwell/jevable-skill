import type { CompiledWorkflow, CompiledWorkflowNode, WorkflowCompilerLimits } from '../workflow/compiler-types.ts';
import type { ModelNodePlan } from './model-plan.ts';
/** Plan kinds the local runtime executes; others compile but are refused before any node runs. */
export declare const LOCAL_PLAN_KINDS: readonly string[];
/** List every plan kind in encounter order, including loop bodies and duplicates. */
export declare function planKinds(nodes: readonly CompiledWorkflowNode[]): string[];
/** Compile the entire supported graph, including untaken branches and loop bodies,
 * under the caller's compiler/resource policy before admitting any execution.
 */
export declare function compileRuntimeWorkflow(yaml: string, limits: WorkflowCompilerLimits): CompiledWorkflow;
/** Model plans from the complete graph; never reads provider storage or dispatches. */
export declare function executionModelPlans(graph: CompiledWorkflow): ModelNodePlan[];
