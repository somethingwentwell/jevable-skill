/** Explicit wire selection shared by live transport and offline retained-request verification. */
import type { ModelRequestPlan, PreparedModelInput } from '../runtime/model-plan.ts'
import { ProviderError, type ProviderConnection } from './config.ts'
import { requestBody, readCompletion, type WireResult } from './openai-wire.ts'
import { createSystemOneRequest, parseSystemOneReply, readSystemOneReply, type SystemOneResult } from './systemone.ts'

export const nativeDataLimits = { maxDepth: 64, maxValues: 100_000 } as const
function nativeResult(result: SystemOneResult): WireResult {
  return { output: result.raw, providerModel: result.reply.model, usage: { tries: 1,
    inputTokens: result.reply.usage.input_tokens, outputTokens: result.reply.usage.output_tokens } }
}

export function prepareModelWire(plan: ModelRequestPlan, input: PreparedModelInput, connection: ProviderConnection) {
  if (plan.responseFormat === 'systemone-v1') {
    if (connection.protocol !== 'systemone' || input.systemPrompt !== '' || input.history !== undefined) throw new ProviderError('unsupported-settings')
    let state: unknown
    try { state = JSON.parse(input.prompt) } catch { throw new ProviderError('unsupported-settings') }
    const limits = { maxRequestBytes: connection.maxRequestBytes, maxResponseBytes: connection.maxResponseBytes, ...nativeDataLimits }
    const request = createSystemOneRequest({ model: plan.model, state, questions: plan.questions }, limits)
    return { request, path: '/systemone', accept: 'application/json',
      read: async (response: Response): Promise<WireResult> => nativeResult(await readSystemOneReply(response, request, limits)),
      decode: (raw: string): WireResult => nativeResult(parseSystemOneReply(raw, request, limits)) }
  }
  if (connection.protocol !== 'openai-compatible') throw new ProviderError('unsupported-settings')
  return { request: requestBody(plan, input, connection.tokenParameter), path: '/chat/completions',
    accept: plan.generation.stream ? 'text/event-stream' : 'application/json',
    read: (response: Response): Promise<WireResult> => readCompletion(response, plan, connection) }
}
