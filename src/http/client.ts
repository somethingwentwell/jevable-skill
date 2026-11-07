import { PROTOCOL_VERSION } from '../capabilities.ts'
import { RuntimeHttpError } from './errors.ts'
export { RuntimeHttpError } from './errors.ts'
import type { RuntimeOperation } from './operations.ts'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { validateCa } from './tls.ts'
import { z } from 'zod'
import { createParser } from 'eventsource-parser'
import { grantTokenProof } from '../access/grants.ts'
import { reviewerDecisionRequestSchema, reviewerDecisionReceiptSchema, type ReviewerDecisionRequest } from '../access/reviewer.ts'
import { parseTraceParent } from '../telemetry/config.ts'
import { parseTraceRequestContext, selectBaggage, type TraceRequestContext } from '../telemetry/baggage.ts'
import { admitWorkflowData } from '../workflow/index.ts'
import { callerOperationSchema, callerStartRequestSchema, callerReleasePinSchema, callerRunReceiptSchema, callerRunResultSchema,
  callerCancellationRequestSchema, type CallerCancellationRequest, type CallerReleasePin, type CallerStartRequest, type CallerOperation,
  type CallerRunReceipt, type CallerRunResult } from '../access/caller.ts'
import { callerCancellationReceiptSchema, type CallerCancellationReceipt } from '../access/caller-cancellation.ts'
import { callerControlRequestSchema, callerControlCheckpointSchema, callerControlReceiptSchema,
  type CallerControlRequest, type CallerControlCheckpoint, type CallerControlReceipt } from '../access/caller-control.ts'
import { callerStreamOptionsSchema, admitCallerStreamEvent, type CallerStreamOptions, type CallerStreamEvent } from './caller-stream.ts'
import { asyncRunRequestSchema, asyncRunReceiptSchema, asyncReleasePinSchema,
  type AsyncRunRequest, type AsyncRunReceipt } from './async-runs.ts'

export interface RuntimeClientTlsOptions { ca?: string; expectedInstanceId?: string }
export type RuntimeTraceContext = string | TraceRequestContext
export interface AsyncRunClientOptions {
  timeoutMs?: number
  maxResponseBytes?: number
  ca?: string
  /** Required for an exact-release host; retained and checked on every request and receipt. */
  release?: { id: string; sha256: string; revision: string }
}

interface ResponseAdmission {
  releaseSha256?: string
  admit?: (value: unknown, status: number, response: IncomingMessage) => unknown
}

function admitClientTraceContext(value: RuntimeTraceContext | undefined) {
  try {
    const context = parseTraceRequestContext(typeof value === 'string' ? { traceparent: value } : value ?? {})
    parseTraceParent(context.traceparent)
    const baggage = selectBaggage(context.baggage)
    return { ...context, baggage }
  } catch { throw new RuntimeHttpError('invalid-command') }
}

/** Bounded delta seconds only. A header is a hint, never an instruction to schedule a retry. */
function rateRetryAfter(response: IncomingMessage, code: string, status: number): number | undefined {
  const value = response.headers['retry-after']
  return status === 429 && code === 'rate-limit' && typeof value === 'string' && /^[1-9][0-9]{0,3}$/u.test(value)
    && Number(value) <= 3600 ? Number(value) : undefined
}

/** Explicit loopback HTTP or verified HTTPS; no discovery, redirects or automatic retries. */
class RuntimeHttpTransport {
  private readonly endpoint: string
  private readonly ca: string | undefined
  private expectedInstanceId: string | undefined
  protected constructor(endpoint: string, private readonly token: string, private readonly timeoutMs = 30_000,
    private readonly maxResponseBytes = 20_000_000, tls: RuntimeClientTlsOptions = {}, kind: 'owner' | 'reviewer' | 'caller' = 'owner') {
    let url: URL
    try { url = new URL(endpoint) } catch { throw new RuntimeHttpError('invalid-endpoint') }
    if ((url.protocol !== 'https:' && (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port))
      || url.port === '0' || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || !(kind === 'owner' ? /^[a-f0-9]{64}$/u.test(token) : grantTokenProof(token))
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000
      || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 64_000_000) throw new RuntimeHttpError('invalid-config')
    try {
      if (!tls || typeof tls !== 'object' || Object.keys(tls).some(key => key !== 'ca' && key !== 'expectedInstanceId')
        || (tls.expectedInstanceId !== undefined && !z.uuid().safeParse(tls.expectedInstanceId).success)
        || (tls.ca !== undefined && url.protocol !== 'https:')) throw new Error()
      this.ca = tls.ca === undefined ? undefined : validateCa(tls.ca)
      this.expectedInstanceId = tls.expectedInstanceId
    } catch { throw new RuntimeHttpError('invalid-config') }
    this.endpoint = url.origin
  }
  /** Explicit one-way owner pin, shared by every later request. Never relax or silently replace it. */
  pinInstance(instanceId: string) {
    if (!z.uuid().safeParse(instanceId).success) throw new RuntimeHttpError('invalid-config')
    if (this.expectedInstanceId !== undefined && this.expectedInstanceId !== instanceId) throw new RuntimeHttpError('conflict')
    this.expectedInstanceId = instanceId
  }

  protected async request(path: string, command?: unknown, traceParent?: RuntimeTraceContext, admission: ResponseAdmission = {}): Promise<unknown> {
    const context = admitClientTraceContext(traceParent)
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: IncomingMessage | undefined
    try {
      const payload = command === undefined ? undefined : JSON.stringify(command)
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = this.endpoint.startsWith('https:') ? httpsRequest : httpRequest
        const outgoing = request(this.endpoint + path, { method: command === undefined ? 'GET' : 'POST', signal: controller.signal,
          agent: false, maxHeaderSize: 16_384, rejectUnauthorized: true, minVersion: 'TLSv1.2',
          ...(this.ca === undefined ? {} : { ca: this.ca }),
          headers: { Authorization: `Bearer ${this.token}`, 'X-Jevable-Protocol': PROTOCOL_VERSION,
            ...(context.traceparent === undefined ? {} : { traceparent: context.traceparent }),
            ...(context.baggage === undefined ? {} : { baggage: context.baggage }),
            ...(this.expectedInstanceId === undefined ? {} : { 'X-Jevable-Instance': this.expectedInstanceId }),
            ...(admission.releaseSha256 === undefined ? {} : { 'X-Jevable-Release-Sha256': admission.releaseSha256 }),
            ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) } }, resolve)
        outgoing.on('error', reject)
        outgoing.end(payload)
      })
      const status = response.statusCode ?? 0
      if (response.headers['x-jevable-protocol'] !== PROTOCOL_VERSION) throw new RuntimeHttpError('protocol-mismatch', status)
      if (status >= 300 && status < 400) throw new RuntimeHttpError('redirect-refused', status)
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(response.headers['content-type'] ?? '')
        || response.headers['content-encoding'] !== undefined) throw new RuntimeHttpError('invalid-response', status)
      const chunks: Uint8Array[] = []; let bytes = 0
      for await (const chunk of response) {
        bytes += chunk.byteLength
        if (bytes > this.maxResponseBytes) throw new RuntimeHttpError('response-limit', status)
        chunks.push(chunk)
      }
      let value: unknown
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
      catch { throw new RuntimeHttpError('invalid-response', status) }
      if (status < 200 || status >= 300) {
        const code = value && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
          && /^[a-z][a-z0-9-]{0,63}$/u.test(value.code) ? value.code : 'operation-failed'
        throw new RuntimeHttpError(code, status, rateRetryAfter(response, code, status))
      }
      return admission.admit ? admission.admit(value, status, response) : value
    } catch (error) {
      if (error instanceof RuntimeHttpError) throw error
      throw new RuntimeHttpError(controller.signal.aborted ? 'request-timeout' : 'transport-uncertain')
    } finally { clearTimeout(timer); response?.destroy() }
  }

  /** One explicit POST stream. Abort/disconnect/EOF never reconnect, resume or repeat the request. */
  protected async *requestEvents(path: string, command: unknown, signal?: AbortSignal): AsyncGenerator<{ event: string; data: unknown }> {
    const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, this.timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    let response: IncomingMessage | undefined
    try {
      if (signal?.aborted) { controller.abort(); return }
      const payload = JSON.stringify(command)
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = this.endpoint.startsWith('https:') ? httpsRequest : httpRequest
        const outgoing = request(this.endpoint + path, { method: 'POST', signal: controller.signal, agent: false, maxHeaderSize: 16_384,
          rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(this.ca === undefined ? {} : { ca: this.ca }),
          headers: { Authorization: `Bearer ${this.token}`, 'X-Jevable-Protocol': PROTOCOL_VERSION,
            ...(this.expectedInstanceId === undefined ? {} : { 'X-Jevable-Instance': this.expectedInstanceId }),
            Accept: 'text/event-stream', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, resolve)
        outgoing.on('error', reject); outgoing.end(payload)
      })
      const status = response.statusCode ?? 0
      if (response.headers['x-jevable-protocol'] !== PROTOCOL_VERSION) throw new RuntimeHttpError('protocol-mismatch', status)
      if (status >= 300 && status < 400) throw new RuntimeHttpError('redirect-refused', status)
      if (status !== 200) {
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(response.headers['content-type'] ?? '')
          || response.headers['content-encoding'] !== undefined) throw new RuntimeHttpError('invalid-response', status)
        const chunks: Buffer[] = []; let bytes = 0
        for await (const chunk of response) {
          bytes += chunk.length; if (bytes > Math.min(this.maxResponseBytes, 16384)) throw new RuntimeHttpError('response-limit', status)
          chunks.push(chunk)
        }
        let value: unknown
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
        catch { throw new RuntimeHttpError('invalid-response', status) }
        const code = value && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
          && /^[a-z][a-z0-9-]{0,63}$/u.test(value.code) ? value.code : 'operation-failed'
        throw new RuntimeHttpError(code, status, rateRetryAfter(response, code, status))
      }
      if (!/^text\/event-stream(?:\s*;\s*charset=utf-8)?$/iu.test(response.headers['content-type'] ?? '')
        || response.headers['content-encoding'] !== undefined) throw new RuntimeHttpError('invalid-response', status)
      const decoder = new TextDecoder('utf-8', { fatal: true }), pending: { event: string; data: unknown }[] = []
      let bytes = 0, events = 0, frameBytes = 0, buffered = ''
      const parser = createParser({
        onError() { throw new RuntimeHttpError('invalid-response') },
        onRetry() { throw new RuntimeHttpError('invalid-response') },
        onEvent(event) {
          if (++events > 1000 || event.id !== undefined || !['snapshot', 'stopped'].includes(event.event ?? '')) throw new RuntimeHttpError('invalid-response')
          let data: unknown
          try { data = JSON.parse(event.data) } catch { throw new RuntimeHttpError('invalid-response') }
          pending.push({ event: event.event!, data })
        },
      })
      const feed = (text: string) => {
        buffered += text
        let end: number
        while ((end = buffered.indexOf('\n')) !== -1) {
          let line = buffered.slice(0, end)
          buffered = buffered.slice(end + 1)
          if (line.endsWith('\r')) line = line.slice(0, -1)
          frameBytes += Buffer.byteLength(line) + 1
          if (line.includes('\r') || frameBytes > 16384) throw new RuntimeHttpError('invalid-response')
          parser.feed(line + '\n')
          if (!line) frameBytes = 0
        }
        if (Buffer.byteLength(buffered) > 16384) throw new RuntimeHttpError('invalid-response')
      }
      const decode = (chunk?: Uint8Array) => {
        try { return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true }) }
        catch { throw new RuntimeHttpError('invalid-response') }
      }
      for await (const chunk of response) {
        if (signal?.aborted) return
        bytes += chunk.length; if (bytes > this.maxResponseBytes) throw new RuntimeHttpError('response-limit')
        feed(decode(chunk))
        while (pending.length) yield pending.shift()!
      }
      feed(decode())
      if (buffered || frameBytes) throw new RuntimeHttpError('invalid-response')
      while (pending.length) yield pending.shift()!
    } catch (error) {
      if (signal?.aborted) return
      if (error instanceof RuntimeHttpError) throw error
      throw new RuntimeHttpError(controller.signal.aborted ? 'request-timeout' : 'transport-uncertain')
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); response?.destroy() }
  }
}

/** Owner-only async admission/status. Explicit instance pin, no discovery, retries or execution controls. */
export class AsyncRunClient extends RuntimeHttpTransport {
  private readonly release: AsyncRunClientOptions['release']
  constructor(endpoint: string, token: string, private readonly instanceId: string, options: AsyncRunClientOptions = {}) {
    if (!z.uuid().safeParse(instanceId).success || !options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['timeoutMs', 'maxResponseBytes', 'ca', 'release'].includes(key))
      || options.timeoutMs !== undefined && typeof options.timeoutMs !== 'number'
      || options.maxResponseBytes !== undefined && typeof options.maxResponseBytes !== 'number')
      throw new RuntimeHttpError('invalid-config')
    const release = options.release === undefined ? undefined : asyncReleasePinSchema.safeParse(options.release)
    if (release && !release.success) throw new RuntimeHttpError('invalid-config')
    super(endpoint, token, options.timeoutMs ?? 30_000, options.maxResponseBytes ?? 20_000_000,
      { expectedInstanceId: instanceId, ...(options.ca === undefined ? {} : { ca: options.ca }) })
    this.release = release?.data
  }

  async start(value: AsyncRunRequest, traceContext?: RuntimeTraceContext): Promise<AsyncRunReceipt> {
    let request: AsyncRunRequest
    try { request = asyncRunRequestSchema.parse(admitWorkflowData(value, { maxBytes: 4_000_000, maxDepth: 64, maxValues: 100_000 })) }
    catch { throw new RuntimeHttpError('invalid-command') }
    if (this.release && (request.kind !== 'release' || !this.sameRelease(request.release, this.release)))
      throw new RuntimeHttpError('invalid-command')
    return await this.request('/v1/async-runs', request, traceContext, {
      admit: (value, status, response) => {
        const receipt = this.receipt(value, request.id)
        const locations = response.rawHeaders.filter((_, index) => index % 2 === 0 && response.rawHeaders[index]!.toLowerCase() === 'location')
        if (locations.length !== 1 || response.headers.location !== '/v1/async-runs/' + receipt.run.id
          || !(status === 202 && receipt.observation === 'created' || status === 200 && receipt.observation === 'retained'))
          throw new RuntimeHttpError('invalid-response', status)
        const run = receipt.run
        if (run.test || run.triggerMode !== request.triggerMode || (run.startedPaused === true) !== (request.paused === true)
          || request.kind === 'workflow' && (run.project || run.release)
          || request.kind === 'project' && (run.release || !run.project || !this.sameId(run.project.id, request.project.id)
            || run.project.generation !== request.project.generation || run.revision !== request.project.revision)
          || request.kind === 'release' && (run.project || !run.release || !this.sameRelease({ ...run.release, revision: run.revision }, request.release)))
          throw new RuntimeHttpError('invalid-response', status)
        return receipt
      },
    }) as AsyncRunReceipt
  }

  /** A metadata read only. Never resumes, waits for completion, or returns private run payloads. */
  async show(id: string): Promise<AsyncRunReceipt> {
    if (!z.uuid().safeParse(id).success) throw new RuntimeHttpError('invalid-command')
    return await this.request('/v1/async-runs/' + id, undefined, undefined, {
      ...(this.release === undefined ? {} : { releaseSha256: this.release.sha256 }),
      admit: (value, status) => {
        const receipt = this.receipt(value, id)
        if (status !== 200 || receipt.observation !== 'read') throw new RuntimeHttpError('invalid-response', status)
        return receipt
      },
    }) as AsyncRunReceipt
  }

  private sameId(a: string, b: string) { return a.toLowerCase() === b.toLowerCase() }
  private sameRelease(a: NonNullable<AsyncRunClientOptions['release']>, b: NonNullable<AsyncRunClientOptions['release']>) {
    return this.sameId(a.id, b.id) && a.sha256 === b.sha256 && a.revision === b.revision
  }
  private receipt(value: unknown, id: string): AsyncRunReceipt {
    const parsed = asyncRunReceiptSchema.safeParse(value)
    if (!parsed.success || !this.sameId(parsed.data.instanceId, this.instanceId) || !this.sameId(parsed.data.run.id, id)
      || Date.parse(parsed.data.run.updatedAt) < Date.parse(parsed.data.run.createdAt)
      || this.release && (!parsed.data.run.release || parsed.data.run.project || parsed.data.run.test
        || !this.sameRelease({ ...parsed.data.run.release, revision: parsed.data.run.revision }, this.release)))
      throw new RuntimeHttpError('invalid-response')
    return parsed.data
  }
}

/** Grant-only pinned-release operations. Never authenticates owner operations or discovers a host. */
export class CallerClient extends RuntimeHttpTransport {
  private readonly release: CallerReleasePin
  constructor(endpoint: string, token: string, private readonly instanceId: string, release: CallerReleasePin,
    timeoutMs = 30_000, maxResponseBytes = 20_000_000, tls: Pick<RuntimeClientTlsOptions, 'ca'> = {}) {
    const pin = callerReleasePinSchema.safeParse(release)
    if (!pin.success || !z.uuid().safeParse(instanceId).success || !tls || typeof tls !== 'object' || Object.keys(tls).some(key => key !== 'ca'))
      throw new RuntimeHttpError('invalid-config')
    super(endpoint, token, timeoutMs, maxResponseBytes, { ...tls, expectedInstanceId: instanceId }, 'caller')
    this.release = pin.data
  }
  async start(value: CallerStartRequest, traceParent?: RuntimeTraceContext) {
    let parsed
    try { parsed = callerStartRequestSchema.safeParse(admitWorkflowData(value, { maxBytes: 4_000_000, maxDepth: 64, maxValues: 100_000 })) }
    catch { throw new RuntimeHttpError('invalid-command') }
    if (!parsed.success) throw new RuntimeHttpError('invalid-command')
    return this.call({ operation: 'start', release: this.release, ...parsed.data }, traceParent)
  }
  async read(id: string, traceParent?: RuntimeTraceContext) {
    const parsed = callerOperationSchema.safeParse({ operation: 'read', release: this.release, id })
    if (!parsed.success || parsed.data.operation !== 'read') throw new RuntimeHttpError('invalid-command')
    return this.call({ operation: 'read', release: this.release, id: parsed.data.id }, traceParent)
  }
  /** Observe metadata only, even when read permission also permits completed output. */
  async *stream(id: string, options: CallerStreamOptions = {}): AsyncGenerator<CallerStreamEvent> {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new RuntimeHttpError('invalid-command')
    const { signal, ...settings } = options, parsed = callerStreamOptionsSchema.safeParse(settings)
    if (!z.uuid().safeParse(id).success || !parsed.success || signal !== undefined && !(signal instanceof AbortSignal))
      throw new RuntimeHttpError('invalid-command')
    id = id.toLowerCase()
    let last: CallerStreamEvent | undefined
    for await (const packet of this.requestEvents('/v1/caller/stream', { ...parsed.data, id, release: this.release }, signal)) {
      let event: CallerStreamEvent
      try { event = admitCallerStreamEvent(packet.data, this.instanceId, id, this.release, last) }
      catch { throw new RuntimeHttpError('invalid-response') }
      if (event.type !== packet.event) throw new RuntimeHttpError('invalid-response')
      last = event; yield event
      if (event.type === 'stopped') return
    }
    if (signal?.aborted) {
      yield { schemaVersion: 1, type: 'stopped', sequence: (last?.sequence ?? 0) + 1, instanceId: this.instanceId,
        reason: 'interrupted', execution: 'not-requested' }; return
    }
    throw new RuntimeHttpError('stream-incomplete')
  }
  async cancel(id: string, value: CallerCancellationRequest, traceParent?: RuntimeTraceContext) {
    let parsed
    try { parsed = callerOperationSchema.safeParse({ operation: 'cancel', release: this.release, id,
      request: callerCancellationRequestSchema.parse(admitWorkflowData(value, { maxBytes: 4096, maxDepth: 8, maxValues: 32 })) }) }
    catch { throw new RuntimeHttpError('invalid-command') }
    if (!parsed.success || parsed.data.operation !== 'cancel') throw new RuntimeHttpError('invalid-command')
    return this.call(parsed.data, traceParent)
  }
  async checkpoint(id: string, traceParent?: RuntimeTraceContext) {
    const parsed = callerOperationSchema.safeParse({ operation: 'checkpoint', release: this.release, id })
    if (!parsed.success || parsed.data.operation !== 'checkpoint') throw new RuntimeHttpError('invalid-command')
    return this.call(parsed.data, traceParent)
  }
  async control(id: string, value: CallerControlRequest, traceParent?: RuntimeTraceContext) {
    let parsed
    try { parsed = callerOperationSchema.safeParse({ operation: 'control', release: this.release, id,
      request: callerControlRequestSchema.parse(admitWorkflowData(value, { maxBytes: 16384, maxDepth: 8, maxValues: 256 })) }) }
    catch { throw new RuntimeHttpError('invalid-command') }
    if (!parsed.success || parsed.data.operation !== 'control') throw new RuntimeHttpError('invalid-command')
    return this.call(parsed.data, traceParent)
  }
  private call(command: Extract<CallerOperation, { operation: 'start' }>, traceParent?: RuntimeTraceContext): Promise<{ schemaVersion: 1; instanceId: string; result: CallerRunReceipt }>
  private call(command: Extract<CallerOperation, { operation: 'read' }>, traceParent?: RuntimeTraceContext): Promise<{ schemaVersion: 1; instanceId: string; result: CallerRunResult }>
  private call(command: Extract<CallerOperation, { operation: 'cancel' }>, traceParent?: RuntimeTraceContext): Promise<{ schemaVersion: 1; instanceId: string; result: CallerCancellationReceipt }>
  private call(command: Extract<CallerOperation, { operation: 'checkpoint' }>, traceParent?: RuntimeTraceContext): Promise<{ schemaVersion: 1; instanceId: string; result: CallerControlCheckpoint }>
  private call(command: Extract<CallerOperation, { operation: 'control' }>, traceParent?: RuntimeTraceContext): Promise<{ schemaVersion: 1; instanceId: string; result: CallerControlReceipt }>
  private async call(command: CallerOperation, traceParent?: RuntimeTraceContext) {
    try { admitClientTraceContext(traceParent) } catch { throw new RuntimeHttpError('invalid-command') }
    let raw: unknown
    try { raw = admitWorkflowData(await this.request('/v1/caller/operations', command, traceParent),
      { maxBytes: 64_000_000, maxDepth: 64, maxValues: 100_000 }) }
    catch (error) { if (error instanceof RuntimeHttpError) throw error; throw new RuntimeHttpError('invalid-response') }
    const parsed = z.strictObject({ schemaVersion: z.literal(1), instanceId: z.literal(this.instanceId),
      result: command.operation === 'start' ? callerRunReceiptSchema : command.operation === 'cancel'
        ? callerCancellationReceiptSchema : command.operation === 'checkpoint' ? callerControlCheckpointSchema
          : command.operation === 'control' ? callerControlReceiptSchema : callerRunResultSchema }).safeParse(raw)
    const id = command.operation === 'start' ? command.options.id : command.id
    if (!parsed.success || parsed.data.result.id !== id || parsed.data.result.revision !== this.release.revision
      || parsed.data.result.release.id !== this.release.id || parsed.data.result.release.sha256 !== this.release.sha256
      || (command.operation === 'cancel' || command.operation === 'control') && (!('requestId' in parsed.data.result) || parsed.data.result.requestId !== command.request.requestId)
      || command.operation === 'control' && (!('mode' in parsed.data.result) || parsed.data.result.mode !== command.request.mode))
      throw new RuntimeHttpError('invalid-response')
    return parsed.data
  }
}

/** Owner-only management client. Grant tokens cannot construct or authenticate it. */
export class RuntimeClient<Operation = RuntimeOperation> extends RuntimeHttpTransport {
  constructor(endpoint: string, token: string, timeoutMs = 30_000, maxResponseBytes = 20_000_000, tls: RuntimeClientTlsOptions = {}) {
    super(endpoint, token, timeoutMs, maxResponseBytes, tls)
  }
  capabilities() { return this.request('/v1/capabilities') }
  health() { return this.request('/v1/health') }
  operation(command: Operation, traceParent?: RuntimeTraceContext) { return this.request('/v1/operations', command, traceParent) }
}

/** Separate grant-only client. No discovery, owner operations, storage, token lookup or retries. */
export class ReviewerClient extends RuntimeHttpTransport {
  constructor(endpoint: string, token: string, private readonly instanceId: string, timeoutMs = 30_000,
    maxResponseBytes = 16_384, tls: Pick<RuntimeClientTlsOptions, 'ca'> = {}) {
    if (!z.uuid().safeParse(instanceId).success || !tls || typeof tls !== 'object' || Object.keys(tls).some(key => key !== 'ca'))
      throw new RuntimeHttpError('invalid-config')
    super(endpoint, token, timeoutMs, maxResponseBytes, { ...tls, expectedInstanceId: instanceId }, 'reviewer')
  }
  async decide(value: ReviewerDecisionRequest, traceParent?: RuntimeTraceContext) {
    const parsed = reviewerDecisionRequestSchema.safeParse(value)
    if (!parsed.success) throw new RuntimeHttpError('invalid-command')
    try { admitClientTraceContext(traceParent) } catch { throw new RuntimeHttpError('invalid-command') }
    const response = z.strictObject({ schemaVersion: z.literal(1), instanceId: z.literal(this.instanceId), result: reviewerDecisionReceiptSchema })
      .safeParse(await this.request('/v1/reviewer/decisions', parsed.data, traceParent))
    if (!response.success || response.data.result.requestId !== parsed.data.requestId || response.data.result.action !== parsed.data.action
      || response.data.result.pauseAfter !== (parsed.data.pauseAfter === true)) throw new RuntimeHttpError('invalid-response')
    return response.data
  }
}
