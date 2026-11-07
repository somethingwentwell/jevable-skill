import type { ImportResult } from './import-types.ts';
type N8nNode = {
    id?: string;
    name: string;
    type: string;
    typeVersion?: number;
    parameters?: Record<string, unknown>;
    disabled?: boolean;
};
type Target = {
    node: string;
    type: string;
    index: number;
};
type N8nWorkflow = {
    name?: string;
    nodes: N8nNode[];
    connections?: Record<string, Record<string, (Target[] | null)[]>>;
};
/** Minimum n8n typeVersion per converted node type; older versions store different parameters and are reported as unsupported. */
export declare const N8N_NODE_VERSIONS: Readonly<Record<string, number>>;
/**
 * Whether a parsed JSON value looks like an n8n editor workflow.
 * @param value - Parsed file content.
 * @returns true for an object with a node list whose entries carry n8n node types.
 */
export declare function isN8nWorkflow(value: unknown): value is N8nWorkflow;
/**
 * Convert an n8n workflow; unsupported nodes become placeholders that keep the draft from running.
 * @param workflow - Parsed editor JSON.
 * @returns the draft and its mapping report.
 */
export declare function convertN8n(workflow: N8nWorkflow): ImportResult;
export {};
