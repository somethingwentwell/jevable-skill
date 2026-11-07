import { parseWorkflow } from '../source.ts';
import type { WorkflowLimits } from '../types.ts';
import type { ImportedWorkflow } from './import-types.ts';
/**
 * Convert one n8n editor JSON, Dify DSL YAML, Coze canvas JSON or workflow YAML, Zapier Zap export, Make blueprint or Power
 * Automate flow definition file into admitted Jevable YAML for review.
 * @param source - Uploaded file text.
 * @param limits - Source limits applied to the upload and to the converted draft.
 * @returns the converted YAML, report and source hash.
 * @throws WorkflowImportError for unknown formats, unsupported versions, recognizable credentials in the upload or drafts that
 * fail source admission.
 */
export declare function importWorkflow(source: string, limits: WorkflowLimits): ImportedWorkflow;
/** Internal operation-local admission, never exported by the public workflow SDK.
 * The trusted project adapter may supply its ordinary parser so the converter's
 * generated YAML admission also yields the immutable snapshot used for review.
 * There is no uploaded witness, retained cache or bypass of the caller's limits.
 */
export declare function admitImportedWorkflow(source: string, limits: WorkflowLimits, readSource?: typeof parseWorkflow): {
    converted: ImportedWorkflow;
    admitted: import("../types.ts").WorkflowSnapshot;
};
