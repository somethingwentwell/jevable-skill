import type { Branded } from '../shared/brand.ts';
import type { RevisionHash, WorkflowSnapshot } from './types.ts';
/** Explicit admission budgets; the byte limit covers the complete rendered model context. */
export interface WorkflowSelectionLimits {
    maxNodes: number;
    maxBytes: number;
}
/** A source reference grants no access; the host must verify its project against the requesting Session. */
export interface WorkflowNodeReference {
    readonly projectId: Branded<'JevableProjectId'>;
    readonly revision: RevisionHash;
    /** Slash-separated node IDs, with each preceding segment identifying a containing Loop. */
    readonly path: string;
}
/** Safe category only; rejected source and suspected secret values never enter diagnostics. */
export declare class WorkflowSelectionError extends Error {
    readonly code: 'invalid-reference' | 'missing-node' | 'limit' | 'sensitive-content';
    /** @param code - Payload-free reason the selection cannot be admitted. */
    constructor(code: 'invalid-reference' | 'missing-node' | 'limit' | 'sensitive-content');
}
/**
 * Encode one node as a canonical composer reference; no source data or secret enters the URI.
 * @param reference - Admitted project/revision and scoped node identity.
 * @returns clipboard-safe reference text, also accepted by the host parser.
 */
export declare function workflowNodeMention(reference: WorkflowNodeReference): string;
/**
 * Decode explicit node mentions without treating their labels or contents as instructions.
 * @param text - One direct-user text block.
 * @param limits - Complete block byte and reference-count admission budgets.
 * @returns unchanged ordinary text, or readable node labels and detached validated references.
 */
export declare function parseWorkflowNodeMentions(text: string, limits: WorkflowSelectionLimits): {
    text: string;
    references: readonly WorkflowNodeReference[];
};
/**
 * Replace recognizable credentials in retained data before it leaves the installation, such as an exported transcript.
 * Matching is heuristic: known credential field names and common key/token formats only.
 * @param value - Detached JSON data; it is not modified.
 * @returns a copy with matching field values and embedded matches replaced by `[redacted]`.
 */
export declare function redactCredentials(value: unknown): unknown;
/**
 * Capture selected source only, including edges between selected nodes in the same graph.
 * @param snapshot - Trusted, already admitted immutable revision; never reloaded from a mutable latest pointer.
 * @param references - Explicit same-project node references, authorized by the host before this call.
 * @param limits - Maximum selected references and bytes in the complete rendered message.
 * @returns detached model-facing text with untrusted-data framing, redacted credential fields and no implicit Loop children.
 * @throws WorkflowSelectionError without reflecting source values; no content is silently truncated.
 */
export declare function captureWorkflowSelection(snapshot: Pick<WorkflowSnapshot, 'document' | 'revision'>, references: readonly WorkflowNodeReference[], limits: WorkflowSelectionLimits): string;
