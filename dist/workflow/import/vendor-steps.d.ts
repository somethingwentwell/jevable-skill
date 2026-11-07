/** Step conversion shared by the Zapier and Make importers: templates, simple filters and AI or code steps. */
import { type DraftBuilder, type DraftNode } from './import-draft.ts';
import type { ImportMappingKind, ImportMappingReason } from './import-types.ts';
/** How a vendor reference resolves: a field of the trigger's data, the whole text of a converted AI step, or nothing usable. */
export type Reference = {
    kind: 'input';
    path: string[];
} | {
    kind: 'text';
    node: string;
} | {
    kind: 'none';
};
/** Vendor-specific reference parser: returns the referenced vendor step and field path of one `{{…}}` body, if it is one. */
export type ReferenceSyntax = (body: string) => {
    step: string;
    path: string[];
} | undefined;
/** Converted steps of one vendor workflow, used to resolve references to earlier steps. */
export declare class VendorSteps {
    private readonly draft;
    private readonly syntax;
    private readonly placeholders;
    private readonly steps;
    /**
     * @param draft - Draft receiving inferred input fields.
     * @param syntax - Parser for one reference body.
     * @param placeholders - Global pattern whose first group is a reference body inside a text template; defaults to `{{…}}`.
     */
    constructor(draft: DraftBuilder, syntax: ReferenceSyntax, placeholders?: RegExp);
    /**
     * Remember a converted vendor step for later references.
     * @param step - Vendor step identity.
     * @param id - Jevable node identifier.
     * @param kind - Whether it is the trigger or an AI step; other steps cannot be referenced.
     */
    remember(step: string, id: string, kind: 'trigger' | 'ai' | 'other'): void;
    /**
     * Resolve one reference body.
     * @param body - Text between `{{` and `}}`.
     * @returns what the reference reads in Jevable terms.
     */
    resolve(body: string): Reference;
    /**
     * Translate a vendor text template into a Jevable binding template.
     * @param template - Vendor text with `{{…}}` references.
     * @returns the binding text, and whether every reference was translated.
     */
    template(template: string): {
        text: string;
        exact: boolean;
    };
    /**
     * The Jevable binding that reads a resolved reference as text.
     * @param reference - Resolved vendor reference.
     * @returns the binding, or undefined when the reference reads nothing Jevable can name.
     */
    binding(reference: Reference): string | undefined;
    /**
     * Translate one comparison into an If/Else condition over the trigger's data.
     * @param left - Vendor reference text, such as `{{1.status}}`.
     * @param operator - Jevable comparison operator.
     * @param right - Compared value.
     * @returns the condition binding, or undefined when the left side is not a single trigger field.
     */
    condition(left: string, operator: '==' | '!=' | '>' | '<' | '>=' | '<=', right: unknown): string | undefined;
    /**
     * Translate one comparison of a resolved reference into an If/Else condition over the trigger's data.
     * @param reference - Resolved left side.
     * @param operator - Jevable comparison operator.
     * @param right - Compared value.
     * @returns the condition binding, or undefined when the left side is not a trigger field or a numeric operand is not a number.
     */
    compare(reference: Reference, operator: '==' | '!=' | '>' | '<' | '>=' | '<=', right: unknown): string | undefined;
}
/**
 * Convert a vendor AI step into an LLM step with the vendor prompt and model.
 * @param prompt - Vendor prompt already translated into a Jevable template, and whether every reference was translated.
 * @param model - Vendor model name.
 * @param provider - Vendor provider name.
 * @returns the node with its mapping fidelity; the model route always needs the user's choice.
 */
export declare function aiStep(prompt: {
    text: string;
    exact: boolean;
}, model: unknown, provider: string): {
    node: DraftNode;
    kind: ImportMappingKind;
    reason: ImportMappingReason;
};
/**
 * Stand in for a vendor step Jevable cannot convert.
 * @param reason - Why: code, a vendor app, a loop, or an operator that is not translated.
 * @returns a run-blocking Custom placeholder and its mapping.
 */
export declare function blocked(reason: 'code' | 'node-type' | 'loop' | 'operator'): {
    node: DraftNode;
    kind: ImportMappingKind;
    reason: ImportMappingReason;
};
