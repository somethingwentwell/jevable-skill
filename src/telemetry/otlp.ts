import type { TelemetryPolicy } from './config.ts'
import { postGrpc, type OtlpSignal } from './grpc.ts'
import { ExportFailure } from './failure.ts'
export { ExportFailure } from './failure.ts'

export type OtlpCredential = () => string | undefined | Promise<string | undefined>

/** A slow/failed storage read must not outlive the exporter deadline or leak its diagnostics. */
function resolveCredential(read: OtlpCredential, signal: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ExportFailure('transport'))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return read() }).then(value => {
      signal.removeEventListener('abort', abort); resolve(value)
    }, () => { signal.removeEventListener('abort', abort); reject(new ExportFailure('transport')) })
  })
}

/** One explicit, non-retrying request. Never expose credentials or collector error text. */
export async function postOtlp(endpoint: string, bytes: Uint8Array | undefined, policy: TelemetryPolicy,
  credential: OtlpCredential, controller: AbortController, signal: OtlpSignal = 'traces'): Promise<Buffer> {
  if (!bytes || bytes.byteLength > 4_000_000) throw new ExportFailure('serialization')
  let response: Response | undefined
  const timeout = setTimeout(() => controller.abort(), policy.timeoutMs)
  const deadline = performance.now() + policy.timeoutMs
  try {
    controller.signal.throwIfAborted()
    const key = policy.authentication.kind === 'bearer' ? await resolveCredential(credential, controller.signal) : undefined
    controller.signal.throwIfAborted()
    if (policy.authentication.kind === 'bearer' && !key) throw new ExportFailure('transport')
    if (policy.protocol === 'grpc') return await postGrpc(endpoint, bytes, signal, key, controller.signal, deadline - performance.now())
    response = await fetch(endpoint, { method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'content-type': 'application/x-protobuf', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: Buffer.from(bytes) })
    if (response.status !== 200 || !/^application\/x-protobuf(?:\s*;.*)?$/iu.test(response.headers.get('content-type') ?? '')) throw new ExportFailure('response')
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0
    if (reader) try {
      for (;;) {
        const next = await reader.read(); if (next.done) break
        size += next.value.byteLength
        if (size > 64000) throw new ExportFailure('response')
        chunks.push(next.value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    return Buffer.concat(chunks)
  } catch (error) {
    throw error instanceof ExportFailure ? error : new ExportFailure('transport')
  } finally { clearTimeout(timeout); await response?.body?.cancel().catch(() => {}) }
}

export async function boundedFlush(work: Promise<void>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })]) }
  finally { clearTimeout(timer) }
}
