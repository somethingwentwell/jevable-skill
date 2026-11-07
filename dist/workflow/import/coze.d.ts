import type { ImportResult } from './import-types.ts';
/** coze.cn workflow YAML schema versions this converter was written against. */
export declare const COZE_DSL_VERSIONS: RegExp;
type Value = Record<string, unknown>;
/** One Coze step with the fields both export forms share. */
type CozeStep = {
    id: string;
    kind: string;
    title: string;
    params: Value;
    outputs: unknown;
};
/** A Coze workflow read from either export form. */
export interface CozeGraph {
    /** `studio-export`, `clipboard` or `canvas` for canvas JSON; the `schema_version` for coze.cn YAML. */
    readonly version: string;
    readonly form: 'canvas' | 'dsl';
    readonly title?: string;
    readonly steps: readonly CozeStep[];
    readonly edges: readonly {
        from: string;
        to: string;
        port?: string;
    }[];
}
/**
 * Read a parsed upload as a Coze workflow.
 * @param value - Parsed file content.
 * @returns the workflow for a Coze Studio export, copied nodes, a saved canvas or a coze.cn workflow YAML; otherwise undefined.
 */
export declare function cozeGraph(value: unknown): CozeGraph | undefined;
/**
 * Convert a Coze workflow; unsupported nodes become placeholders that keep the draft from running.
 * @param graph - Workflow read by `cozeGraph`, with a supported version.
 * @returns the draft and its mapping report.
 */
export declare function convertCoze(graph: CozeGraph): ImportResult;
export {};
