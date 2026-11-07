/** Typed JSON bindings for prompts, mapped inputs and workflow outputs. */
import type { CompiledExpression, ExpressionLimits, ExpressionType } from './expression-types.ts'
import type { WorkflowDataLimits } from './value-types.ts'

/** Explicit budgets for the complete binding and its embedded expression count. */
export interface WorkflowBindingLimits {
  readonly data: WorkflowDataLimits
  readonly expression: ExpressionLimits
  readonly maxExpressions: number
}

/** Non-executable value instructions; template expressions never become source code. */
export type BindingInstruction =
  | { readonly kind: 'literal'; readonly value: string | number | boolean | null }
  | { readonly kind: 'expression'; readonly expression: CompiledExpression }
  | { readonly kind: 'text'; readonly parts: readonly (string | CompiledExpression)[] }
  | { readonly kind: 'object'; readonly entries: readonly (readonly [string, BindingInstruction])[] }
  | { readonly kind: 'array'; readonly entries: readonly BindingInstruction[] }

/** Immutable binding for one typed workflow position; rebuild from source across file/wire boundaries. */
export interface CompiledBinding {
  readonly instruction: BindingInstruction
  readonly resultType: ExpressionType
  readonly limits: WorkflowDataLimits
}
