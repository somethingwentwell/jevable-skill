/** Immutable typed plans for the first executable workflow node families. */
import type { Branded } from '../shared/brand.ts'
import type { CompiledBinding, WorkflowBindingLimits } from './binding-types.ts'
import type { ExpressionType } from './expression-types.ts'
import type { CompiledValueSchema, WorkflowDataLimits } from './value-types.ts'
import type { NodeId, WorkflowLimits, WorkflowSnapshot } from './types.ts'
import type { WorkflowDecisionQuestion } from './decision-types.ts'

/** Workspace-owned provider connection identity, resolved outside workflow YAML. */
export type WorkflowConnectionId = Branded<'JevableConnectionId'>
/** Reference to a secret owned by the credential service, never a plaintext credential. */
export type WorkflowCredentialRef = Branded<'JevableCredentialRef'>
/** Requested provider route; runtime admission still enforces egress and adapter capabilities. */
export type WorkflowModelConnection =
  | { readonly mode: 'workspace'; readonly id: WorkflowConnectionId }
  | { readonly mode: 'custom'
    readonly protocol: 'openai-compatible'
    readonly endpoint: string
    readonly credentialRef?: WorkflowCredentialRef | undefined }

/** Explicit generation settings; adapters must reject unsupported fields, not silently drop them. */
export interface WorkflowGeneration {
  readonly maxTokens: number
  readonly temperature?: number | undefined
  readonly topP?: number | undefined
  readonly stream: boolean
}

/** History remains absent unless the runtime supplies an authorized bounded projection. */
export type WorkflowHistoryPolicy = { readonly scope: 'none' }
  | { readonly scope: 'current-run' | 'admitted-project'; readonly maxMessages: number; readonly maxBytes: number }

/** LLM instructions and provider requirements; contains no resolved secrets or network client. */
export interface CompiledLLMPlan {
  readonly kind: 'llm'
  readonly provider: string
  readonly model: string
  readonly connection: WorkflowModelConnection
  readonly prompt: CompiledBinding
  readonly systemPrompt: CompiledBinding
  readonly input?: { readonly binding: CompiledBinding; readonly schema: CompiledValueSchema } | undefined
  readonly output: CompiledValueSchema
  readonly responseFormat: 'text' | 'json-schema'
  readonly generation: WorkflowGeneration
  readonly history: WorkflowHistoryPolicy
  readonly execution: { readonly timeoutSeconds: number; readonly maxAttempts: number }
}

/** Named decision protocol; compilation preserves the requirement without granting network access or fallback. */
export type WorkflowDecisionConnection =
  | { readonly mode: 'workspace'; readonly id: WorkflowConnectionId }
  | { readonly mode: 'custom'
    readonly protocol: string
    readonly endpoint: string
    readonly credentialRef?: WorkflowCredentialRef | undefined }

/** Typed multi-question request; the execution adapter must normalize and validate every answer before routing. */
export interface CompiledDecisionPlan {
  readonly kind: 'decision'
  /** Omission preserves the original normalized LLM-compatible contract. */
  readonly answerFormat?: 'systemone-v1'
  readonly provider: string
  readonly model: string
  readonly connection: WorkflowDecisionConnection
  readonly state: CompiledBinding
  readonly questions: Readonly<Record<string, WorkflowDecisionQuestion>>
  readonly output: CompiledValueSchema
  /** Required only for the explicit llm compatibility provider; never an automatic retry route. */
  readonly llm?: { readonly provider: string; readonly generation: WorkflowGeneration } | undefined
  readonly execution: { readonly timeoutSeconds: number; readonly maxAttempts: number }
}

/** Deterministic branch selection with an exhaustive default for Switch. */
export type CompiledRulePlan =
  | { readonly kind: 'ifElse'; readonly condition: CompiledBinding }
  | { readonly kind: 'switch'
    readonly value: CompiledBinding
    readonly cases: readonly { readonly port: string; readonly value: string | number | boolean | null }[] }

/** Review instructions only; a runtime must persist the exact displayed data and authenticate every decision. */
export interface CompiledApprovalPlan {
  readonly kind: 'humanApproval'
  readonly title: CompiledBinding
  readonly input: { readonly binding: CompiledBinding; readonly schema: CompiledValueSchema }
  readonly actions: readonly string[]
  readonly expiresAfterMs: number
  readonly onReject: 'cancelled' | 'branch'
  readonly onTimeout: 'expired' | 'branch'
}

/** One body step's result mapping; a path ends by leaving an unconnected port of `from`. */
export interface CompiledLoopExit {
  readonly from: NodeId
  readonly port: string
  readonly result: CompiledBinding
}

/** Sequential bounded iteration over a compiled body graph; nested loops are not admitted. */
export interface CompiledLoopPlan {
  readonly kind: 'loop'
  readonly mode: 'forEach' | 'repeatUntil'
  /** For Each: the array iterated, one body run per element. */
  readonly items?: CompiledBinding | undefined
  /** Repeat Until: the constant value exposed as `loop.item` to every iteration. */
  readonly input?: CompiledBinding | undefined
  /** Repeat Until: evaluated after each iteration with `loop.item` bound to that iteration's result. */
  readonly until?: CompiledBinding | undefined
  readonly maxIterations: number
  readonly timeoutSeconds: number
  /** Repeat Until only: fail, or leave through the `limit` port, when the condition never holds. */
  readonly onLimit?: 'fail' | 'branch' | undefined
  readonly body: { readonly entry: NodeId; readonly nodes: readonly CompiledWorkflowNode[]; readonly exits: readonly CompiledLoopExit[] }
  readonly result: ExpressionType
}

/** Code-first step instructions; running them requires a separately admitted sandbox and capability grant. */
export interface CompiledCustomPlan {
  readonly kind: 'custom'
  readonly language: 'javascript'
  readonly code: string
  readonly input: { readonly binding: CompiledBinding; readonly schema?: CompiledValueSchema | undefined }
  readonly output: CompiledValueSchema
  readonly execution?: { readonly timeoutSeconds: number; readonly maxAttempts: number } | undefined
}

/** Compiled behavior; unsupported source families cannot appear in an admitted plan. */
export type WorkflowNodePlan =
  | { readonly kind: 'trigger'; readonly modes: readonly ('manual' | 'chat' | 'api' | 'webhook')[] }
  | CompiledLLMPlan | CompiledDecisionPlan | CompiledRulePlan | CompiledApprovalPlan | CompiledLoopPlan | CompiledCustomPlan
  | { readonly kind: 'output'; readonly value: CompiledBinding; readonly schema?: CompiledValueSchema | undefined }

/** One node's immutable instructions, available output type and exact continuation map. */
export interface CompiledWorkflowNode {
  readonly id: NodeId
  readonly plan: WorkflowNodePlan
  readonly outputType: ExpressionType
  readonly destinations: Readonly<Record<string, NodeId>>
}

/** Compiler resource policy; deployment-varying limits are supplied by the host. */
export interface WorkflowCompilerLimits {
  readonly source: WorkflowLimits
  readonly schema: WorkflowDataLimits
  readonly binding: WorkflowBindingLimits
}

/** Local execution instructions pinned to a complete source revision and compiler protocol version. */
export interface CompiledWorkflow {
  readonly compilerVersion: 'jevable-compiler/v1alpha1'
  readonly source: WorkflowSnapshot
  readonly input: CompiledValueSchema
  readonly nodes: readonly CompiledWorkflowNode[]
}
