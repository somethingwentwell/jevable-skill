import type { ImportResult } from './import-types.ts';
type Condition = {
    a?: unknown;
    b?: unknown;
    o?: unknown;
};
interface MakeModule {
    id: number;
    module: string;
    version?: number;
    mapper?: Record<string, unknown>;
    filter?: {
        name?: string;
        conditions?: Condition[][];
    };
    routes?: {
        flow?: MakeModule[];
    }[];
}
type Blueprint = {
    name?: string;
    flow: MakeModule[];
    metadata?: {
        version?: unknown;
    };
};
/** Blueprint `metadata.version` values this converter understands. */
export declare const MAKE_BLUEPRINT_VERSIONS: readonly number[];
/**
 * Whether a parsed JSON value looks like a Make blueprint.
 * @param value - Parsed file content.
 * @returns true for an object with a `flow` list of modules.
 */
export declare function isMakeBlueprint(value: unknown): value is Blueprint;
/**
 * The blueprint format version.
 * @param blueprint - Detected blueprint.
 * @returns the version when this converter supports it, otherwise undefined.
 */
export declare function makeVersion(blueprint: Blueprint): number | undefined;
/**
 * Convert a Make scenario. The first module becomes a manual Start; a module's filter becomes an If/Else Rule when it is one
 * comparison of a trigger field; AI modules become LLM steps; a router follows its first route. Everything else becomes a
 * placeholder that keeps the draft from running.
 * @param blueprint - Parsed blueprint with a supported version.
 * @returns the draft and its mapping report.
 */
export declare function convertMake(blueprint: Blueprint): ImportResult;
export {};
