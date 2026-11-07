import { type CompiledWorkflow, type WorkflowCompilerLimits } from '../workflow/index.ts';
import type { TestDefinition } from './schema.ts';
export declare function validateTestTriggerMode(triggerMode: TestDefinition['triggerMode'], graph: CompiledWorkflow): void;
/** Same semantic admission for local drafts and untrusted transferred definitions; no execution. */
export declare function validateTestSource(definition: TestDefinition, graph: CompiledWorkflow, limits: WorkflowCompilerLimits): void;
