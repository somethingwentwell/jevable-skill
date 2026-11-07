/** Converted vendor workflows: a Jevable draft plus a per-node mapping report; nothing is executed or installed. */
/** Vendor formats with a pinned, tested converter. */
export type ImportFormat = 'n8n' | 'dify' | 'coze' | 'zapier' | 'make' | 'power-automate';
/** How faithfully one source node was converted. */
export type ImportMappingKind = 'exact' | 'approximate' | 'unsupported';
/** Stable reason codes; consumers localize them and never show vendor diagnostics verbatim. */
export type ImportMappingReason = 'mapped' | 'trigger-mode' | 'model-route' | 'expression' | 'operator' | 'code' | 'node-type' | 'unreachable' | 'language' | 'loop';
/** One source node's conversion. `target` names the Jevable node that represents it, when one was created. */
export interface ImportMapping {
    readonly source: string;
    readonly sourceType: string;
    readonly target?: string;
    readonly kind: ImportMappingKind;
    readonly reason: ImportMappingReason;
}
/** A converted draft for review; `document` still passes through ordinary source admission and review. */
export interface ImportResult {
    readonly format: ImportFormat;
    /** Vendor format version the converter pinned, such as the Dify DSL version. */
    readonly version: string;
    readonly title: string;
    readonly document: Record<string, unknown>;
    readonly mappings: readonly ImportMapping[];
}
/** A converted draft that already passed Jevable source admission, with the uploaded file's SHA-256. */
export interface ImportedWorkflow {
    readonly format: ImportFormat;
    readonly version: string;
    readonly title: string;
    readonly yaml: string;
    readonly sourceSha256: string;
    readonly mappings: readonly ImportMapping[];
}
/** Reasons an uploaded vendor workflow could not be converted; the uploaded text is never echoed. */
export type WorkflowImportFailure = 'too-large' | 'unknown-format' | 'unsupported-version' | 'invalid-draft' | 'secret-values';
