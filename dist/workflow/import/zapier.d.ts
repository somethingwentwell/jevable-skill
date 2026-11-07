import type { ImportResult } from './import-types.ts';
interface ZapNode {
    id: number;
    parent_id?: number | null;
    type_of?: string;
    selected_api?: string;
    action?: string;
    title?: string | null;
    params?: Record<string, unknown>;
}
type Zap = {
    id?: number;
    title?: string;
    nodes: Record<string, ZapNode>;
};
type ZapExport = {
    metadata?: {
        version?: unknown;
    };
    zaps: Zap[];
};
/** Export `metadata.version` values this converter understands. */
export declare const ZAPIER_EXPORT_VERSIONS: RegExp;
/**
 * Whether a parsed JSON value looks like a Zapier Zap export.
 * @param value - Parsed file content.
 * @returns true for an object with a `zaps` list whose first entry has a node map.
 */
export declare function isZapierExport(value: unknown): value is ZapExport;
/**
 * The export format version.
 * @param exported - Detected export.
 * @returns the version when this converter supports it, otherwise undefined.
 */
export declare function zapierVersion(exported: ZapExport): string | undefined;
/**
 * Convert the first Zap of an export. The trigger becomes a manual Start, a Filter step one If/Else Rule when it is one
 * comparison of a trigger field, and AI steps LLM steps; each step follows its first child, and Paths and other apps become
 * placeholders that keep the draft from running.
 * @param exported - Parsed export with a supported version.
 * @param version - Supported export version.
 * @returns the draft and its mapping report.
 */
export declare function convertZapier(exported: ZapExport, version: string): ImportResult;
export {};
