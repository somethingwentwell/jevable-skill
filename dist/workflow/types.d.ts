/** Types for admitted Jevable source documents, not executable runtime plans. */
import type { Branded } from '../shared/brand.ts';
export type { JsonValue } from '../shared/values.ts';
/** Recursively immutable JSON retained in an admitted revision. */
export type ReadonlyJsonValue = null | boolean | number | string | readonly ReadonlyJsonValue[] | {
    readonly [key: string]: ReadonlyJsonValue;
};
/** Stable workflow identity within a project catalog. */
export type WorkflowId = Branded<'JevableWorkflowId'>;
/** Node identity within one workflow graph. */
export type NodeId = Branded<'JevableNodeId'>;
/** SHA-256 of canonical source, including presentation and metadata. */
export type RevisionHash = Branded<'JevableRevisionHash'>;
/** Supported source-level node families; runtime support is checked separately. */
export type NodeType = 'trigger' | 'llm' | 'decision' | 'rule' | 'loop' | 'humanApproval' | 'custom' | 'output';
/** A node's source data before node-specific runtime validation. */
export interface WorkflowNode {
    readonly type: NodeType;
    readonly title?: string | undefined;
    readonly description?: string | undefined;
    readonly config: {
        readonly [key: string]: ReadonlyJsonValue;
    };
    readonly extensions?: {
        readonly [key: string]: ReadonlyJsonValue;
    } | undefined;
}
/** A single directed connection, optionally selected by a named output port. */
export interface WorkflowEdge {
    readonly from: NodeId;
    readonly to: NodeId;
    readonly port?: string | undefined;
}
/** Versioned source document; history is stored separately from this document. */
export interface WorkflowDocument {
    readonly apiVersion: 'jevable.ai/v1alpha1';
    readonly kind: 'Workflow';
    readonly metadata: {
        readonly id: WorkflowId;
        readonly name: string;
        readonly description?: string | undefined;
    };
    readonly spec: {
        readonly inputSchema: {
            readonly [key: string]: ReadonlyJsonValue;
        };
        readonly nodes: Readonly<Record<NodeId, WorkflowNode>>;
        readonly edges: readonly WorkflowEdge[];
        readonly presentation?: {
            readonly [key: string]: ReadonlyJsonValue;
        } | undefined;
        readonly extensions?: {
            readonly [key: string]: ReadonlyJsonValue;
        } | undefined;
    };
    readonly extensions?: {
        readonly [key: string]: ReadonlyJsonValue;
    } | undefined;
}
/** Caller-owned admission budgets; apply the same limits on every source entry path. */
export interface WorkflowLimits {
    maxSourceBytes: number;
    maxDepth: number;
    maxValues: number;
    maxNodes: number;
    maxEdges: number;
}
/** Validated source snapshot. It is not evidence of provider, schema or runtime readiness. */
export interface WorkflowSnapshot {
    readonly document: WorkflowDocument;
    readonly revision: RevisionHash;
    readonly yaml: string;
    readonly order: readonly NodeId[];
}
/** Change metadata excludes raw configuration values, which may contain sensitive data. */
export interface WorkflowDiff {
    readonly from: RevisionHash;
    readonly to: RevisionHash;
    readonly addedNodes: readonly NodeId[];
    readonly removedNodes: readonly NodeId[];
    readonly changedNodes: readonly NodeId[];
    readonly edgesChanged: boolean;
    readonly inputSchemaChanged: boolean;
    readonly metadataChanged: boolean;
    readonly presentationChanged: boolean;
    readonly extensionsChanged: boolean;
}
