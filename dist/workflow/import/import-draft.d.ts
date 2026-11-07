/** Shared draft builder for vendor converters: stable node IDs, typed edges, generated outputs and the mapping report. */
import type { ImportMapping, ImportMappingKind, ImportMappingReason } from './import-types.ts';
/** One Jevable node as written into the draft. */
export type DraftNode = {
    type: string;
    title?: string;
    description?: string;
    config: Record<string, unknown>;
};
type Node = DraftNode;
type Edge = {
    from: string;
    to: string;
    port?: string;
};
/** Mutable draft used while converting one vendor workflow. */
export declare class DraftBuilder {
    /** Outer graph nodes by Jevable identifier. */
    nodes: Record<string, Node>;
    /** Outer graph edges; at most one continuation per source port. */
    readonly edges: Edge[];
    /** Report entries in source order. */
    readonly mappings: ImportMapping[];
    private readonly ids;
    private readonly inputs;
    /**
     * Allocate a Jevable node identifier for a vendor node, stable within this conversion.
     * @param key - Vendor node identity.
     * @param label - Human name used to derive a readable identifier.
     * @returns an identifier matching the Jevable source rules and unique in this draft.
     */
    id(key: string, label: string): string;
    /**
     * Add one converted node and record how it maps to the vendor node.
     * @param key - Vendor node identity.
     * @param label - Vendor node name.
     * @param sourceType - Vendor node type, for the report.
     * @param node - Jevable node.
     * @param kind - Mapping fidelity.
     * @param reason - Stable reason code.
     * @returns the Jevable node identifier.
     */
    add(key: string, label: string, sourceType: string, node: Node, kind: ImportMappingKind, reason: ImportMappingReason): string;
    /**
     * Record that a translated expression reads an input field, so the inferred input schema declares it.
     * @param path - Field path below `inputs`.
     * @param type - Type implied by how the field is used; a later, more specific use wins over `string`.
     */
    input(path: readonly string[], type: InputType): void;
    /**
     * Build an input schema declaring every recorded field as required, nesting objects along dotted paths. A `[]` segment
     * makes the field before it a list whose items have the rest of the path.
     * @returns a Jevable input schema; with no recorded fields, an open object.
     */
    inferredInputSchema(): Record<string, unknown>;
    /**
     * Record a vendor node converted into a loop body step; it is not an outer node, so pruning never removes it.
     * @param label - Vendor node name.
     * @param sourceType - Vendor node type.
     * @param target - Body step identifier.
     * @param kind - Mapping fidelity.
     * @param reason - Stable reason code.
     */
    nest(label: string, sourceType: string, target: string, kind: ImportMappingKind, reason: ImportMappingReason): void;
    /**
     * Record a vendor node that has no Jevable node of its own, such as a model sub-node or an extra trigger.
     * @param label - Vendor node name.
     * @param sourceType - Vendor node type.
     * @param kind - Mapping fidelity.
     * @param reason - Stable reason code.
     */
    note(label: string, sourceType: string, kind: ImportMappingKind, reason: ImportMappingReason): void;
    /**
     * Finish the draft: add a manual Start when the source had no trigger, drop nodes that are unreachable because Jevable
     * has one continuation per port (reported as `unreachable`), and give every node without a continuation its own Output.
     * @param inputSchema - Workflow input schema.
     * @param metadata - Workflow identity and name.
     * @param extension - Import record kept in the revision for review.
     * @returns a complete Jevable workflow document.
     */
    document(inputSchema: unknown, metadata: {
        id: string;
        name: string;
    }, extension: Record<string, unknown>): Record<string, unknown>;
    /**
     * Add an edge unless its source is an Output or the port already continues elsewhere; a second continuation is parallel
     * fan-out Jevable cannot express.
     * @param from - Source node.
     * @param to - Target node.
     * @param port - Source port, omitted for the default continuation.
     */
    connect(from: string, to: string, port?: string): void;
}
/**
 * Derive a workflow metadata identifier from a vendor workflow name.
 * @param name - Vendor workflow name.
 * @returns a lowercase slug that starts with a letter.
 */
export declare function workflowId(name: string): string;
/** JSON type implied by how an imported expression uses an input field. */
export type InputType = 'string' | 'number' | 'boolean' | 'object';
/**
 * LLM settings for an imported step. The connection names no allowed route, so the revision check reports that the user
 * must choose an allowed model before the draft can run; every limit is written into the YAML for review.
 * @param prompt - Translated prompt template.
 * @param model - Vendor model name, if known.
 * @param provider - Vendor provider name, if known.
 * @param systemPrompt - Translated system prompt, if any.
 * @returns an LLM node configuration.
 */
export declare function llmConfig(prompt: string, model?: string, provider?: string, systemPrompt?: string): Record<string, unknown>;
/**
 * Stand in for vendor behavior with no Jevable equivalent; empty code blocks compilation, so the draft cannot run.
 * @param description - Why the step needs manual conversion.
 * @returns an empty Custom step.
 */
export declare function placeholder(description: string): Node;
export {};
