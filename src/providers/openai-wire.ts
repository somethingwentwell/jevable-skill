import { createParser } from 'eventsource-parser'
import { z } from 'zod'
import { ProviderError, type ChatProviderConnection } from './config.ts'
import type { ChatModelRequestPlan, PreparedModelInput } from '../runtime/model-plan.ts'
import { modelUserContent } from '../runtime/model-plan.ts'

export const RESULT_TOOL = 'jevable_return_result'
const structuredInstruction = 'Return your answer by calling jevable_return_result exactly once with the value field matching its schema. '
  + 'Do not call other functions or return a text answer. This function only collects your answer; it does not execute actions.'

/** Pure request construction is also used to verify historical execution without network calls. */
export function requestBody(plan: ChatModelRequestPlan, input: PreparedModelInput, tokenParameter: ChatProviderConnection['tokenParameter']) {
  const system = plan.responseFormat === 'text' ? input.systemPrompt
    : `${input.systemPrompt ? `${input.systemPrompt}\n\n` : ''}${structuredInstruction}`
  return { model: plan.model, messages: [
    ...(system ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: modelUserContent(input).map(part => part.text).join('\n\n') },
  ], [tokenParameter]: plan.generation.maxTokens, stream: plan.generation.stream,
  ...(plan.generation.stream ? { stream_options: { include_usage: true } } : {}),
  ...(plan.generation.temperature !== undefined ? { temperature: plan.generation.temperature } : {}),
  ...(plan.generation.topP !== undefined ? { top_p: plan.generation.topP } : {}),
  ...(plan.responseFormat === 'text' ? {} : { tools: [{ type: 'function', function: { name: RESULT_TOOL,
    description: 'Record the workflow result. No external action is executed.',
    parameters: { type: 'object', required: ['value'], additionalProperties: false, properties: { value: plan.output.definition } },
  } }], tool_choice: { type: 'function', function: { name: RESULT_TOOL } }, parallel_tool_calls: false }),
  }
}

const usageSchema = z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() })
const metadata = { id: z.string().max(256).optional(), model: z.string().max(256).optional(), usage: usageSchema.nullish() }
const toolSchema = z.object({ id: z.string().min(1), type: z.literal('function'),
  function: z.object({ name: z.literal(RESULT_TOOL), arguments: z.string() }) })
const replySchema = z.object({ ...metadata, choices: z.array(z.object({ index: z.literal(0), finish_reason: z.string(),
  message: z.object({ role: z.literal('assistant'), content: z.string().nullish(), refusal: z.string().nullish(),
    tool_calls: z.array(toolSchema).optional(), function_call: z.unknown().optional(), audio: z.unknown().optional() }),
})).length(1) })

export interface WireResult { output: string; usage: { tries: 1; inputTokens?: number; outputTokens?: number }; responseId?: string; providerModel?: string }

function result(output: string, meta: z.infer<typeof replySchema>): WireResult {
  return { output, usage: { tries: 1, ...(meta.usage ? { inputTokens: meta.usage.prompt_tokens, outputTokens: meta.usage.completion_tokens } : {}) },
    ...(meta.id === undefined ? {} : { responseId: meta.id }), ...(meta.model === undefined ? {} : { providerModel: meta.model }) }
}

export function parseReply(value: unknown, mode: ChatModelRequestPlan['responseFormat']): WireResult {
  const parsed = replySchema.safeParse(value)
  if (!parsed.success) throw new ProviderError('invalid-response')
  const choice = parsed.data.choices[0]!, message = choice.message
  if (message.refusal || message.function_call !== undefined || message.audio !== undefined) throw new ProviderError('invalid-response')
  if (mode === 'text') {
    if (choice.finish_reason !== 'stop' || message.tool_calls?.length || typeof message.content !== 'string') throw new ProviderError('invalid-response')
    return result(message.content, parsed.data)
  }
  if (choice.finish_reason !== 'tool_calls' || message.content || message.tool_calls?.length !== 1) throw new ProviderError('invalid-response')
  return result(message.tool_calls[0]!.function.arguments, parsed.data)
}

const chunkSchema = z.object({ ...metadata, choices: z.array(z.object({ index: z.literal(0), finish_reason: z.string().nullable(),
  delta: z.object({ role: z.literal('assistant').optional(), content: z.string().nullish(), refusal: z.string().nullish(),
    function_call: z.unknown().optional(), audio: z.unknown().optional(),
    tool_calls: z.array(z.object({ index: z.literal(0), id: z.string().optional(), type: z.literal('function').optional(),
      function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional() })).max(1).optional(),
  }),
})).max(1) })

/** Bound the decompressed body, not just Content-Length; cancellation also stops body reading. */
async function consume(response: Response, limit: number, receive: (text: string) => void) {
  if (!response.body) throw new ProviderError('invalid-response')
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) throw new ProviderError('response-too-large')
      receive(decoder.decode(value, { stream: true }))
    }
    receive(decoder.decode())
  } finally { await reader.cancel().catch(() => { /* Preserve the read/parse failure, never retry the request. */ }); reader.releaseLock() }
}

/** Read JSON or SSE according to the requested mode; never accept an HTML page or an unfinished stream. */
export async function readCompletion(response: Response, plan: ChatModelRequestPlan, policy: Pick<ChatProviderConnection, 'maxResponseBytes' | 'maxStreamEvents'>): Promise<WireResult> {
  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (!plan.generation.stream) {
    if (mediaType !== 'application/json') throw new ProviderError('invalid-response')
    let body = ''
    await consume(response, policy.maxResponseBytes, text => { body += text })
    let value: unknown
    try { value = JSON.parse(body) } catch { throw new ProviderError('invalid-response') }
    return parseReply(value, plan.responseFormat)
  }
  if (mediaType !== 'text/event-stream') throw new ProviderError('invalid-response')
  let finished: string | undefined, done = false, count = 0, text = '', toolId = '', toolName = '', toolArguments = '', hasTool = false
  let id: string | undefined, model: string | undefined, usage: z.infer<typeof usageSchema> | undefined
  const parser = createParser({
    onError() { throw new ProviderError('invalid-response') },
    onEvent(event) {
      if (++count > policy.maxStreamEvents) throw new ProviderError('response-too-large')
      if (done || (event.event !== undefined && event.event !== 'message')) throw new ProviderError('invalid-response')
      if (event.data === '[DONE]') { if (!finished) throw new ProviderError('invalid-response'); done = true; return }
      let value: unknown
      try { value = JSON.parse(event.data) } catch { throw new ProviderError('invalid-response') }
      const parsed = chunkSchema.safeParse(value)
      if (!parsed.success) throw new ProviderError('invalid-response')
      const chunk = parsed.data
      if ((id !== undefined && chunk.id !== undefined && id !== chunk.id) || (model !== undefined && chunk.model !== undefined && model !== chunk.model)) throw new ProviderError('invalid-response')
      id ??= chunk.id; model ??= chunk.model
      if (chunk.usage) {
        if (usage) throw new ProviderError('invalid-response')
        usage = chunk.usage
      }
      const choice = chunk.choices[0]
      if (!choice) return
      if (finished) throw new ProviderError('invalid-response')
      const delta = choice.delta
      if (delta.refusal || delta.function_call !== undefined || delta.audio !== undefined) throw new ProviderError('invalid-response')
      text += delta.content ?? ''
      const tool = delta.tool_calls?.[0]
      if (tool) {
        hasTool = true
        if (tool.id && toolId && tool.id !== toolId) throw new ProviderError('invalid-response')
        toolId ||= tool.id ?? ''
        toolName += tool.function?.name ?? ''
        toolArguments += tool.function?.arguments ?? ''
      }
      if (choice.finish_reason !== null) finished = choice.finish_reason
    },
  })
  await consume(response, policy.maxResponseBytes, text => parser.feed(text))
  if (!done) throw new ProviderError('invalid-response')
  return parseReply({ id, model, usage, choices: [{ index: 0, finish_reason: finished, message: {
    role: 'assistant', content: text, ...(hasTool ? { tool_calls: [{ id: toolId, type: 'function', function: { name: toolName, arguments: toolArguments } }] } : {}),
  } }] }, plan.responseFormat)
}
