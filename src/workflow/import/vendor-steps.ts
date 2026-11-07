/** Step conversion shared by the Zapier and Make importers: templates, simple filters and AI or code steps. */
import { llmConfig, placeholder, type DraftBuilder, type DraftNode } from './import-draft.ts'
import type { ImportMappingKind, ImportMappingReason } from './import-types.ts'

/** How a vendor reference resolves: a field of the trigger's data, the whole text of a converted AI step, or nothing usable. */
export type Reference = { kind: 'input'; path: string[] } | { kind: 'text'; node: string } | { kind: 'none' }
/** Vendor-specific reference parser: returns the referenced vendor step and field path of one `{{…}}` body, if it is one. */
export type ReferenceSyntax = (body: string) => { step: string; path: string[] } | undefined

/** Converted steps of one vendor workflow, used to resolve references to earlier steps. */
export class VendorSteps {
  private readonly steps = new Map<string, { id: string; trigger: boolean; ai: boolean }>()
  /**
   * @param draft - Draft receiving inferred input fields.
   * @param syntax - Parser for one reference body.
   * @param placeholders - Global pattern whose first group is a reference body inside a text template; defaults to `{{…}}`.
   */
  constructor(private readonly draft: DraftBuilder, private readonly syntax: ReferenceSyntax,
    private readonly placeholders: RegExp = /\{\{([^{}]*)\}\}/gu) {}

  /**
   * Remember a converted vendor step for later references.
   * @param step - Vendor step identity.
   * @param id - Jevable node identifier.
   * @param kind - Whether it is the trigger or an AI step; other steps cannot be referenced.
   */
  remember(step: string, id: string, kind: 'trigger' | 'ai' | 'other'): void {
    this.steps.set(step, { id, trigger: kind === 'trigger', ai: kind === 'ai' })
  }

  /**
   * Resolve one reference body.
   * @param body - Text between `{{` and `}}`.
   * @returns what the reference reads in Jevable terms.
   */
  resolve(body: string): Reference {
    const parsed = this.syntax(body.trim())
    const step = parsed && this.steps.get(parsed.step)
    if (!parsed || !step) return { kind: 'none' }
    if (step.trigger && parsed.path.length && parsed.path.every(part => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(part))) {
      return { kind: 'input', path: parsed.path }
    }
    return step.ai ? { kind: 'text', node: step.id } : { kind: 'none' }
  }

  /**
   * Translate a vendor text template into a Jevable binding template.
   * @param template - Vendor text with `{{…}}` references.
   * @returns the binding text, and whether every reference was translated.
   */
  template(template: string): { text: string; exact: boolean } {
    let exact = true
    const text = template.replace(this.placeholders, (whole, body: string) => {
      const binding = this.binding(this.resolve(body))
      // An untranslated reference stays as literal text for the reviewer to rewrite.
      if (binding === undefined) exact = false
      return binding ?? whole
    })
    return { text, exact }
  }

  /**
   * The Jevable binding that reads a resolved reference as text.
   * @param reference - Resolved vendor reference.
   * @returns the binding, or undefined when the reference reads nothing Jevable can name.
   */
  binding(reference: Reference): string | undefined {
    if (reference.kind === 'input') { this.draft.input(reference.path, 'string'); return `\${{ inputs.${reference.path.join('.')} }}` }
    return reference.kind === 'text' ? `\${{ nodes.${reference.node}.output }}` : undefined
  }

  /**
   * Translate one comparison into an If/Else condition over the trigger's data.
   * @param left - Vendor reference text, such as `{{1.status}}`.
   * @param operator - Jevable comparison operator.
   * @param right - Compared value.
   * @returns the condition binding, or undefined when the left side is not a single trigger field.
   */
  condition(left: string, operator: '==' | '!=' | '>' | '<' | '>=' | '<=', right: unknown): string | undefined {
    const [, body] = /^\{\{([^{}]*)\}\}$/u.exec(left.trim()) ?? []
    return this.compare(body === undefined ? { kind: 'none' } : this.resolve(body), operator, right)
  }

  /**
   * Translate one comparison of a resolved reference into an If/Else condition over the trigger's data.
   * @param reference - Resolved left side.
   * @param operator - Jevable comparison operator.
   * @param right - Compared value.
   * @returns the condition binding, or undefined when the left side is not a trigger field or a numeric operand is not a number.
   */
  compare(reference: Reference, operator: '==' | '!=' | '>' | '<' | '>=' | '<=', right: unknown): string | undefined {
    if (reference.kind !== 'input') return undefined
    const numeric = operator !== '==' && operator !== '!='
    const value = numeric ? Number(right) : String(right)
    if (numeric && !Number.isFinite(value)) return undefined
    this.draft.input(reference.path, numeric ? 'number' : 'string')
    return `\${{ inputs.${reference.path.join('.')} ${operator} ${JSON.stringify(value)} }}`
  }
}

/**
 * Convert a vendor AI step into an LLM step with the vendor prompt and model.
 * @param prompt - Vendor prompt already translated into a Jevable template, and whether every reference was translated.
 * @param model - Vendor model name.
 * @param provider - Vendor provider name.
 * @returns the node with its mapping fidelity; the model route always needs the user's choice.
 */
export function aiStep(prompt: { text: string; exact: boolean }, model: unknown, provider: string): {
  node: DraftNode
  kind: ImportMappingKind
  reason: ImportMappingReason
} {
  return { node: { type: 'llm', config: llmConfig(prompt.text, typeof model === 'string' ? model : undefined, provider) },
    kind: 'approximate', reason: prompt.exact ? 'model-route' : 'expression' }
}

/**
 * Stand in for a vendor step Jevable cannot convert.
 * @param reason - Why: code, a vendor app, a loop, or an operator that is not translated.
 * @returns a run-blocking Custom placeholder and its mapping.
 */
export function blocked(reason: 'code' | 'node-type' | 'loop' | 'operator'): { node: DraftNode; kind: ImportMappingKind; reason: ImportMappingReason } {
  const descriptions = { 'code': 'Rewrite this code step as a reviewed Custom step.', 'node-type': 'Connect this app step through a supported step.',
    'loop': 'Rebuild this iteration as a Loop step.', 'operator': 'Rewrite this filter as a Rule.' }
  return { node: placeholder(descriptions[reason]), kind: 'unsupported', reason }
}
