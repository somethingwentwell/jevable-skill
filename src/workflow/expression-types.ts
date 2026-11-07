/** Types for the non-executable expression language and its trusted compiler environment. */
import type { NodeId, ReadonlyJsonValue } from './types.ts'

/** Static type projected from a validated input/output schema; no implicit property lookup. */
export type ExpressionType =
  | { readonly kind: 'string' | 'number' | 'boolean' | 'null' }
  | { readonly kind: 'object'
    readonly properties: Readonly<Record<string, ExpressionType>>
    readonly required: readonly string[] }
  | { readonly kind: 'array'; readonly items: ExpressionType; readonly empty?: boolean | undefined }

/** Only nodes guaranteed to have completed on this path belong in the environment. */
export interface ExpressionEnvironment {
  readonly inputs: ExpressionType
  readonly nodes: Readonly<Record<NodeId, ExpressionType>>
  readonly loop?: { readonly item: ExpressionType } | undefined
}

/** Parsing and evaluation budgets are supplied by the consuming runtime configuration. */
export interface ExpressionLimits {
  readonly maxSourceBytes: number
  readonly maxNodes: number
  readonly maxDepth: number
  readonly maxResultBytes: number
}

/** Whitelisted instructions, without JavaScript AST objects, calls or executable source. */
export type ExpressionInstruction =
  | { readonly kind: 'literal'; readonly value: string | number | boolean | null }
  | { readonly kind: 'reference'; readonly path: readonly (string | number)[]; readonly valueType: ExpressionType }
  | { readonly kind: 'exists'; readonly reference: Extract<ExpressionInstruction, { kind: 'reference' }> }
  | { readonly kind: 'not' | 'negative'; readonly operand: ExpressionInstruction }
  | { readonly kind: 'binary'; readonly operator: '==' | '!=' | '>' | '>=' | '<' | '<=' | '&&' | '||'; readonly left: ExpressionInstruction; readonly right: ExpressionInstruction }

/** Immutable expression admitted in one typed environment; recompile at file/wire boundaries. */
export interface CompiledExpression {
  readonly instruction: ExpressionInstruction
  readonly resultType: ExpressionType
  readonly references: readonly (readonly (string | number)[])[]
  readonly maxResultBytes: number
}

/** Schema-validated execution values from the same path used during compilation. */
export interface ExpressionValues {
  readonly inputs: ReadonlyJsonValue
  readonly nodes: Readonly<Record<NodeId, { readonly output: ReadonlyJsonValue }>>
  readonly loop?: { readonly item: ReadonlyJsonValue; readonly index: number } | undefined
}
