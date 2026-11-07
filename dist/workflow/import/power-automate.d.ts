import type { ImportResult } from './import-types.ts';
type Actions = Record<string, PowerAutomateAction>;
interface PowerAutomateAction {
    type?: string;
    kind?: string;
    inputs?: unknown;
    runAfter?: Record<string, unknown>;
    expression?: unknown;
    actions?: Actions;
    else?: {
        actions?: Actions;
    };
    cases?: Record<string, {
        case?: unknown;
        actions?: Actions;
    }>;
    default?: {
        actions?: Actions;
    };
}
/** Workflow Definition Language document shared by every Power Automate export. */
interface Definition {
    $schema: string;
    triggers: Record<string, PowerAutomateAction>;
    actions: Actions;
}
/** Where the definition was found, with the flow's display name when the export carries one. */
type Flow = {
    definition: Definition;
    title?: string;
};
/** Workflow Definition Language schema versions this converter understands. */
export declare const POWER_AUTOMATE_SCHEMA_VERSIONS: readonly string[];
/**
 * Find the workflow definition in a parsed Power Automate export.
 * @param value - Parsed file content.
 * @returns the definition and flow name, or undefined when the value is not a Power Automate flow.
 */
export declare function powerAutomateFlow(value: unknown): Flow | undefined;
/**
 * The definition schema version.
 * @param flow - Detected flow.
 * @returns the version when this converter supports it, otherwise undefined.
 */
export declare function powerAutomateVersion(flow: Flow): string | undefined;
/**
 * Convert a Power Automate flow. The trigger becomes a Start (exact only for a manual button); If becomes an If/Else Rule and
 * Switch a switch Rule when they compare one trigger field with constants; Scope contents are inlined; AI connector actions
 * become LLM steps; a Compose or Response that ends a path becomes an Output. Parallel branches keep their first path,
 * failure-only paths are dropped, and everything else becomes a placeholder that keeps the draft from running.
 * @param flow - Detected flow with a supported schema version.
 * @param version - Supported schema version.
 * @returns the draft and its mapping report.
 */
export declare function convertPowerAutomate(flow: Flow, version: string): ImportResult;
export {};
