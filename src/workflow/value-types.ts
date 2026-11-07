/** Supported JSON Schema data and bounded runtime validation types. */
import type { ExpressionType } from './expression-types.ts'

/** JSON Schema draft-07 subset; unsupported keywords are rejected rather than ignored. */
export interface WorkflowValueSchemaDefinition {
  readonly type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  readonly description?: string | undefined
  readonly properties?: Readonly<Record<string, WorkflowValueSchemaDefinition>> | undefined
  readonly required?: readonly string[] | undefined
  readonly additionalProperties?: boolean | undefined
  readonly items?: WorkflowValueSchemaDefinition | undefined
  readonly minItems?: number | undefined
  readonly maxItems?: number | undefined
  readonly minLength?: number | undefined
  readonly maxLength?: number | undefined
  readonly minimum?: number | undefined
  readonly maximum?: number | undefined
  readonly enum?: readonly (string | number | boolean | null)[] | undefined
}

/** Resource limits apply to schemas and values before recursive compilation or validation. */
export interface WorkflowDataLimits {
  readonly maxBytes: number
  readonly maxDepth: number
  readonly maxValues: number
}

/** In-process schema compilation receipt; reconstruct from definition after persistence or transport. */
export interface CompiledValueSchema {
  readonly definition: WorkflowValueSchemaDefinition
  readonly valueType: ExpressionType
}
