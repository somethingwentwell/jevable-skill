import { type ModelNodePlan, type PreparedModelInput } from '../runtime/model-plan.ts';
import type { ModelEvidence } from './records.ts';
/** Check any retained request, including an unsettled one, against its source-pinned preparation. No current credentials or I/O. */
export declare function verifyEvidenceRequest(node: ModelNodePlan, input: PreparedModelInput, evidence: ModelEvidence): void;
