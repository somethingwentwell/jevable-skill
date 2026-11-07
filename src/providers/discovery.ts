import { z } from 'zod'
import { ProviderError, reference, connectionRecordSchema } from './config.ts'
import type { ProviderPersistence } from './persistence.ts'

const replySchema = z.object({ object: z.literal('list').optional(),
  data: z.array(z.object({ id: z.string().min(1).max(256).refine(id => id.trim() === id && !/[\u0000-\u001f\u007f]/u.test(id)) })).max(1000),
  has_more: z.literal(false).optional(),
})
export interface ModelDiscoveryOptions { signal?: AbortSignal }

/** Explicit advisory GET only. No model execution, permission changes, pagination, redirects or retries. */
export async function discoverConfiguredModels(store: Pick<ProviderPersistence, 'signal' | 'connection' | 'credential'>,
  id: string, options: ModelDiscoveryOptions = {}) {
  if (!reference.safeParse(id).success || !options || typeof options !== 'object'
    || Object.keys(options).some(key => key !== 'signal') || (options.signal !== undefined && !(options.signal instanceof AbortSignal)))
    throw new ProviderError('invalid-config')
  const signal = options.signal
  store.signal?.throwIfAborted()
  if (signal?.aborted) throw new ProviderError('cancelled')
  const saved = await store.connection(id)
  if (!saved) throw new ProviderError('missing-connection')
  const parsed = connectionRecordSchema.safeParse(saved)
  if (!parsed.success || parsed.data.connection.id !== id) throw new ProviderError('invalid-config')
  const route = parsed.data, connection = route.connection
  if (connection.protocol !== 'openai-compatible') throw new ProviderError('unsupported-settings')
  store.signal?.throwIfAborted()
  const credential = connection.authentication.kind === 'bearer' ? await store.credential(connection.authentication.credentialRef) : undefined
  if (connection.authentication.kind === 'bearer' && !credential) throw new ProviderError('missing-credential')
  store.signal?.throwIfAborted()
  if (signal?.aborted) throw new ProviderError('cancelled')
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), Math.min(30, connection.maxTimeoutSeconds) * 1000)
  const combined = AbortSignal.any([controller.signal, ...signal ? [signal] : [], ...store.signal ? [store.signal] : []])
  let response: Response | undefined
  try {
    response = await fetch(`${connection.endpoint}/models`, { method: 'GET', redirect: 'manual', signal: combined,
      headers: { accept: 'application/json', ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }) } })
    if (!response.ok) throw new ProviderError('http-error')
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || !response.body)
      throw new ProviderError('invalid-response')
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
    const decode = (chunk?: Uint8Array, stream = false) => {
      try { return decoder.decode(chunk, { stream }) } catch { throw new ProviderError('invalid-response') }
    }
    let bytes = 0, body = ''
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > connection.maxResponseBytes) throw new ProviderError('response-too-large')
        body += decode(chunk.value, true)
      }
      body += decode()
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    let value: unknown
    try { value = JSON.parse(body) } catch { throw new ProviderError('invalid-response') }
    const reply = replySchema.safeParse(value)
    if (!reply.success || new Set(reply.data.data.map(model => model.id)).size !== reply.data.data.length)
      throw new ProviderError('invalid-response')
    store.signal?.throwIfAborted()
    if (signal?.aborted) throw new ProviderError('cancelled')
    return { schemaVersion: 1 as const, connection: { id, generation: route.generation, provider: connection.provider, protocol: connection.protocol },
      observedAt: new Date().toISOString(), models: reply.data.data.map(({ id }) => ({ id, allowed: connection.allowedModels.includes(id) }))
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      permissions: 'unchanged' as const, scope: 'advisory-provider-list; not-execution-readiness' as const }
  } catch (error) {
    store.signal?.throwIfAborted()
    throw signal?.aborted ? new ProviderError('cancelled') : controller.signal.aborted ? new ProviderError('timeout')
      : error instanceof ProviderError ? error : new ProviderError('transport-error')
  } finally {
    clearTimeout(timeout)
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
  }
}
