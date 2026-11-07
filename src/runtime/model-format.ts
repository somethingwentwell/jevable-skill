/** Validate retained model output using the workflow-owned schema. */
import { admitWorkflowData, validateWorkflowValue, WorkflowValueError } from '../workflow/index.ts'
import type { ReadonlyJsonValue, WorkflowDataLimits } from '../workflow/index.ts'
import type { ModelRequestPlan } from './model-plan.ts'
import { createSystemOneRequest, parseSystemOneReply } from '../providers/systemone.ts'
import { ProviderError } from '../providers/config.ts'

export function modelValue(plan: ModelRequestPlan, raw: string, limits: WorkflowDataLimits): ReadonlyJsonValue {
  if (plan.responseFormat === 'systemone-v1') {
    try {
      const bounds = { maxRequestBytes: 16_000_000, maxResponseBytes: Math.min(16_000_000, limits.maxBytes), maxDepth: limits.maxDepth,
        maxValues: Math.min(1_000_000, limits.maxValues) }
      const request = createSystemOneRequest({ model: plan.model, state: '', questions: plan.questions }, bounds)
      const result = parseSystemOneReply(raw, request, bounds)
      return validateWorkflowValue(plan.output, result.reply.answers, limits)
    } catch (error) {
      if (error instanceof ProviderError) throw new WorkflowValueError('Native model response does not match its reviewed contract.')
      throw error
    }
  }
  if (plan.responseFormat === 'text') return validateWorkflowValue(plan.output, raw, limits)
  if (Buffer.byteLength(raw, 'utf8') > limits.maxBytes) throw new WorkflowValueError('Structured model response exceeds its byte budget.')
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (_error) { throw new WorkflowValueError('Structured model response must contain JSON arguments.') }
  const admitted = admitWorkflowData(parsed, limits)
  if (admitted === null || typeof admitted !== 'object' || Array.isArray(admitted)
    || Object.keys(admitted).length !== 1 || !Object.hasOwn(admitted, 'value')) {
    throw new WorkflowValueError('Structured model response requires exactly one value field.')
  }
  return validateWorkflowValue(plan.output, (admitted as { readonly value: ReadonlyJsonValue }).value, limits)
}
