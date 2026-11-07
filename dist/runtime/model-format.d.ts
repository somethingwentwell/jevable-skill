import type { ReadonlyJsonValue, WorkflowDataLimits } from '../workflow/index.ts';
import type { ModelRequestPlan } from './model-plan.ts';
export declare function modelValue(plan: ModelRequestPlan, raw: string, limits: WorkflowDataLimits): ReadonlyJsonValue;
