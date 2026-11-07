import type { ImportResult } from './import-types.ts';
type DifyNode = {
    id: string;
    parentId?: string;
    data: Record<string, unknown> & {
        type: string;
        title?: string;
    };
};
type DifyEdge = {
    source: string;
    target: string;
    sourceHandle?: string;
};
type DifyApp = {
    version: string;
    app?: {
        name?: string;
        mode?: string;
    };
    workflow: {
        graph: {
            nodes: DifyNode[];
            edges: DifyEdge[];
        };
    };
};
/** Dify DSL versions whose workflow graph layout this converter was written and tested against. */
export declare const DIFY_DSL_VERSIONS: RegExp;
/**
 * Whether a parsed YAML value looks like a Dify workflow export.
 * @param value - Parsed file content.
 * @returns true for a DSL document with a workflow graph.
 */
export declare function isDifyApp(value: unknown): value is DifyApp;
/**
 * Convert a Dify workflow export; unsupported nodes become placeholders that keep the draft from running.
 * @param app - Parsed DSL document with a supported version.
 * @returns the draft and its mapping report.
 */
export declare function convertDify(app: DifyApp): ImportResult;
export {};
