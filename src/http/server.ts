import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { SpanContext } from '@opentelemetry/api'
import type { HttpRateSqlObserver, HttpRateSqlOperation, HttpRateSqlObservation } from './rate-sql-observation.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { ProviderError } from '../providers/config.ts'
import { WorkflowCompileError, WorkflowExpressionError, WorkflowImportError, WorkflowSourceError, WorkflowValueError, admitWorkflowData } from '../workflow/index.ts'
import { PROTOCOL_VERSION } from '../capabilities.ts'
import type { operationCapabilities } from './operation-host.ts'
import type { PreviewSession } from '../preview/session.ts'
import { renderLivePage } from '../preview/live-page.ts'
import { renderReleasePage } from '../releases/page.ts'
import { renderReleaseReviewerPage } from '../releases/reviewer-page.ts'
import { releaseOpenApi } from '../releases/openapi.ts'
import type { ReleaseSession } from '../releases/service-session.ts'
import { loadRuntimeTls, type RuntimeTlsOptions } from './tls.ts'
import type { HttpRequestObservation } from '../telemetry/http.ts'
import type { AsyncSlotObservation } from '../telemetry/async-slots.ts'
import type { HttpConnectionObservation, HttpTransport, HttpTransportFailure } from '../telemetry/connections.ts'
import { grantTokenProof } from '../access/grants.ts'
import { reviewerDecisionRequestSchema, type ReviewerDecisionRequest, type ReviewerDecisionReceipt, type ReviewerDecisionContext } from '../access/reviewer.ts'
import { callerOperationSchema, type CallerOperation, type CallerReleasePin, type CallerRunResult } from '../access/caller.ts'
import type { CallerCancellationReceipt } from '../access/caller-cancellation.ts'
import type { CallerControlCheckpoint, CallerControlReceipt } from '../access/caller-control.ts'
import { callerStreamRequestSchema, observeCallerRun, encodeCallerStreamEvent } from './caller-stream.ts'
import type { TraceRequestContext } from '../telemetry/baggage.ts'
import { asyncRunPolicySchema, asyncRunReceipt, type AsyncRunPolicy, type AsyncRunHost } from './async-runs.ts'
import { httpRateLimitsSchema, createHttpRateLimiter, HttpRateLimitError, isOwnerControlCommand, type HttpRateLimits } from './rate-limits.ts'
import { createCoordinatedHttpRateLimiter, HttpRateCoordinatorError, type CoordinatedHttpRateLimits } from './coordinated-rate-limits.ts'
import { SignedWebhookVerifier, WebhookAuthenticationError, WEBHOOK_LIMITS, releaseWebhookConfigSchema, type ReleaseWebhookConfig } from '../releases/webhooks.ts'
import type { ReleaseMessageSession } from '../releases/messages.ts'
import { httpAccessGuard, httpAccessGuardAsync, type HttpAccessObservation, type HttpAccessStage } from './access-observation.ts'

export interface RuntimeServerOptions {
  token: string
  actor: string
  port?: number
  maxRequestBytes?: number
  maxResponseBytes?: number
  maxConcurrentRequests?: number
  tls?: RuntimeTlsOptions
  /** Opt-in reviewer route; release hosts additionally expose one scoped request read. */
  reviewerDecisions?: boolean
  /** Management-only pinned-release caller operations; disabled by default. No reserved owner capacity. */
  callerOperations?: boolean
  /** Owner-only start/status routes. Explicit bounded background capacity; disabled by default. */
  asyncRuns?: AsyncRunPolicy
  /** HMAC-authenticated intake for one API release; requires explicit shared async capacity. */
  webhooks?: ReleaseWebhookConfig
  /** Startup-only, instance-local request quotas. Disabled by default; not distributed or durable. */
  rateLimits?: HttpRateLimits
  /** Trusted SDK-only atomic coordinator. Explicit shared scope/policy; no discovery or local fallback. */
  coordinatedRateLimits?: CoordinatedHttpRateLimits
  /** Opt-in local-machine trust: mint project-only preview sessions without an owner key in the browser. */
  previewAutoConnect?: boolean
}
/** Internal owned host port. Importing the transport never imports or opens a storage backend. */
export interface RuntimeServiceHost {
  capabilities(): object
  operations?: ReturnType<typeof operationCapabilities>
  operation?(value: unknown): Promise<unknown>
  asyncRuns?: AsyncRunHost
  releaseMessages?: ReleaseMessageSession
  reviewerDecision?(token: string, value: ReviewerDecisionRequest, context: ReviewerDecisionContext): Promise<ReviewerDecisionReceipt>
  reviewerRequest?(token: string): Promise<unknown>
  callerOperation?(token: string, value: CallerOperation,
    context: <Result extends CallerRunResult | CallerCancellationReceipt | CallerControlCheckpoint | CallerControlReceipt>(pin: CallerReleasePin, execute: () => Promise<Result>) => Promise<Result>): Promise<CallerRunResult | CallerCancellationReceipt | CallerControlCheckpoint | CallerControlReceipt>
  withTraceParent<T>(parent: string | undefined, operation: () => T): T
  withTraceContext?<T>(context: TraceRequestContext, operation: () => T): T
  observeHttpRequest?(method: string | undefined, path: string | undefined): HttpRequestObservation | undefined
  observeHttpAccess?(stage: HttpAccessStage): HttpAccessObservation | undefined
  observeHttpRateSql?(operation: HttpRateSqlOperation, parent: SpanContext | undefined): HttpRateSqlObservation | undefined
  observeHttpAsyncSlot?(): AsyncSlotObservation | undefined
  observeHttpConnection?(transport: HttpTransport): HttpConnectionObservation | undefined
  observeHttpTransportFailure?(transport: HttpTransport, failure: HttpTransportFailure): void
  close(): Promise<void>
  health?(): Promise<unknown>
  /** Process-local OTel identity, not HTTP fencing authority or exporter delivery proof. */
  telemetryResource?(): { serviceInstanceId: string } | undefined
  failure?(error: unknown): { status: number; code: string } | undefined
  release?: { pin: ReleaseSession['pin'] }
  preparePreview?(): Promise<Pick<PreviewSession, 'pin' | 'authenticate' | 'bootstrap' | 'revoke' | 'operation'>>
}
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
function failure(error: unknown): { status: number; code: string } {
  if (error instanceof WebhookAuthenticationError) return { status: 401, code: error.code }
  if (error instanceof HttpRateLimitError || error instanceof HttpRateCoordinatorError) return error
  if (error instanceof HttpError) return error
  if (error instanceof WorkflowRuntimeError) return { status: ({ 'invalid-command': 400, 'not-found': 404, conflict: 409,
    archived: 409, referenced: 409, limit: 413, busy: 409, corrupt: 500, closed: 503 })[error.code], code: error.code }
  if (error instanceof ProviderError) return { status: 422, code: error.code }
  if ([WorkflowCompileError, WorkflowExpressionError, WorkflowImportError, WorkflowSourceError, WorkflowValueError].some(kind => error instanceof kind)) return { status: 400, code: 'invalid-workflow' }
  return { status: 500, code: 'operation-failed' }
}

/** Single-owner loopback HTTP or explicit direct HTTPS. Scoped preview remains loopback-only. */
export async function startRuntimeServer(options: RuntimeServerOptions, open: (actor: string) => Promise<RuntimeServiceHost>) {
  const parsed = z.strictObject({ token: z.string().regex(/^[a-f0-9]{64}$/u), actor: z.string().trim().min(1).max(256),
    port: z.number().int().min(0).max(65535), maxRequestBytes: z.number().int().min(1024).max(32_000_000),
    maxResponseBytes: z.number().int().min(1024).max(64_000_000), maxConcurrentRequests: z.number().int().min(1).max(64), reviewerDecisions: z.boolean(), callerOperations: z.boolean(),
    asyncRuns: asyncRunPolicySchema.optional(), webhooks: releaseWebhookConfigSchema.optional(), rateLimits: httpRateLimitsSchema.optional(), previewAutoConnect: z.boolean() }).safeParse({
      token: options.token, actor: options.actor, port: options.port ?? 0, maxRequestBytes: options.maxRequestBytes ?? 4_000_000,
      maxResponseBytes: options.maxResponseBytes ?? 20_000_000, maxConcurrentRequests: options.maxConcurrentRequests ?? 16,
      reviewerDecisions: options.reviewerDecisions ?? false, callerOperations: options.callerOperations ?? false, asyncRuns: options.asyncRuns, rateLimits: options.rateLimits,
      webhooks: options.webhooks,
      previewAutoConnect: options.previewAutoConnect ?? false })
  if (!parsed.success || (options.tls && (parsed.data.port === 0 || parsed.data.previewAutoConnect))
    || (options.rateLimits !== undefined && options.coordinatedRateLimits !== undefined)) throw new WorkflowRuntimeError('invalid-command')
  const coordinatedLimiter = options.coordinatedRateLimits === undefined ? undefined : createCoordinatedHttpRateLimiter(options.coordinatedRateLimits)
  if (parsed.data.webhooks && !parsed.data.asyncRuns) throw new WorkflowRuntimeError('invalid-command')
  if (parsed.data.webhooks?.keys.some(key => {
    const bytes = Buffer.from(key.slice(6), 'base64'), owner = Buffer.from(parsed.data.token, 'hex')
    try { return bytes.length === owner.length && timingSafeEqual(bytes, owner) }
    finally { bytes.fill(0); owner.fill(0) }
  })) throw new WorkflowRuntimeError('invalid-command')
  const tls = options.tls ? await loadRuntimeTls(options.tls) : undefined
  const policy = parsed.data, expectedAuth = Buffer.from(`Bearer ${policy.token}`)
  const rateLimiter = coordinatedLimiter ?? (policy.rateLimits ? createHttpRateLimiter(policy.rateLimits) : undefined)
  let state: 'starting' | 'ready' | 'draining' | 'closed' = 'starting'
  const admitRate = async (lane: 'requests' | 'controls', requestObservation?: HttpRequestObservation) => {
    if (!rateLimiter) return
    const stage: HttpAccessStage = coordinatedLimiter
      ? lane === 'requests' ? 'coordinated-rate-requests' : 'coordinated-rate-controls'
      : lane === 'requests' ? 'local-rate-requests' : 'local-rate-controls'
    let observeSql: HttpRateSqlObserver | undefined
    await httpAccessGuardAsync(() => {
      const observation = host.observeHttpAccess?.(stage)
      let parent: SpanContext | undefined
      try { parent = observation?.traceContext?.() } catch { /* Diagnostic identity only. */ }
      try { requestObservation?.linkRateAdmission?.(parent) } catch { /* Diagnostic link only. */ }
      try {
        const observe = host.observeHttpRateSql?.bind(host)
        if (coordinatedLimiter && parent && observe) {
          const captured = { traceId: parent.traceId, spanId: parent.spanId, traceFlags: parent.traceFlags }
          observeSql = operation => observe(operation, captured)
        }
      } catch { /* No inbound context or admission authority crosses this diagnostic port. */ }
      return observation
    }, async () => {
      if (coordinatedLimiter) await coordinatedLimiter.admit(lane, observeSql)
      else await rateLimiter.admit(lane)
      // Shared debit can await remote IO. Beginning drain while it is pending never authorizes dispatch.
      if (state !== 'ready') throw new HttpError(503, 'draining')
    }, error => error instanceof HttpRateLimitError)
  }
  const host = await open(policy.actor), instanceId = randomUUID()
  if (policy.webhooks && (!host.release || !host.releaseMessages || host.preparePreview)) {
    await host.close(); throw new WorkflowRuntimeError('invalid-command')
  }
  if (policy.previewAutoConnect && !host.preparePreview) {
    await host.close(); throw new WorkflowRuntimeError('invalid-command')
  }
  if (policy.asyncRuns && (!host.asyncRuns || host.preparePreview)) {
    await host.close(); throw new WorkflowRuntimeError('invalid-command')
  }
  if (policy.reviewerDecisions && (!host.reviewerDecision || host.preparePreview || host.release && !host.reviewerRequest)) {
    await host.close(); throw new WorkflowRuntimeError('invalid-command')
  }
  if (policy.callerOperations && (!host.callerOperation || host.preparePreview || host.release)) {
    await host.close(); throw new WorkflowRuntimeError('invalid-command')
  }
  let authority = '', origin = ''
  const transport = tls ? 'direct-https' : 'loopback-http'
  const active = new Set<Promise<void>>()
  const requestObservations = new WeakMap<ServerResponse, HttpRequestObservation>()
  // Includes pre-commit admission and post-202 execution; not a queue or a second storage owner.
  const asyncWork = new Set<Promise<void>>()
  const streams = new Set<AbortController>()
  const connectionSettlements = new Set<Promise<void>>()
  let preview: Awaited<ReturnType<NonNullable<RuntimeServiceHost['preparePreview']>>> | undefined
  const release = host.release
  const webhookVerifier = policy.webhooks ? new SignedWebhookVerifier(policy.webhooks) : undefined
  const page = host.preparePreview ? renderLivePage(instanceId, PROTOCOL_VERSION, host.operation ? 'owner' : 'preview', policy.previewAutoConnect) : undefined
  const releasePage = release ? renderReleasePage(policy.reviewerDecisions) : undefined
  const reviewerPage = release && policy.reviewerDecisions ? renderReleaseReviewerPage(instanceId) : undefined
  const releaseSpec = release ? releaseOpenApi(policy.reviewerDecisions) : undefined
  let resolveClosed!: () => void, rejectClosed!: (error: unknown) => void
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject })
  // A failed automatic drain remains observable through closed without an unhandled-rejection crash.
  void closed.catch(() => {})

  const responseContextHeaders = (response: ServerResponse): Record<string, string> => {
    try {
      const value = requestObservations.get(response)?.responseTraceparent?.()
      // Custom hosts are not allowed to inject arbitrary headers or credential values.
      if (typeof value === 'string' && /^00-(?!0{32})[a-f0-9]{32}-(?!0{16})[a-f0-9]{16}-(00|01)$/u.test(value)) {
        return { 'X-Jevable-Traceparent': value }
      }
    } catch { /* Correlation is best effort, never authority or permission to retry. */ }
    return {}
  }
  const send = (response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
    if (response.destroyed || response.writableEnded) return
    let json = JSON.stringify(value)
    if (Buffer.byteLength(json) > policy.maxResponseBytes) {
      status = 413; json = JSON.stringify({ schemaVersion: 1, status: 'error', code: 'response-limit',
        recovery: 'The operation may have committed. Inspect its exact identity before retrying; never invent a new run ID.' })
    }
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer', 'X-Jevable-Protocol': PROTOCOL_VERSION, ...headers, ...responseContextHeaders(response), ...(status >= 400 ? { Connection: 'close' } : {}) })
    response.end(json)
  }
  const rawBody = async (request: IncomingMessage, ceiling = policy.maxRequestBytes) => {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers['content-type'] ?? '')
      || request.headers['content-encoding'] !== undefined) throw new HttpError(415, 'json-required')
    if (request.headers['content-length'] !== undefined && Number(request.headers['content-length']) > ceiling) throw new HttpError(413, 'request-limit')
    const chunks: Buffer[] = []; let bytes = 0
    for await (const chunk of request) {
      bytes += chunk.length
      if (bytes > ceiling) throw new HttpError(413, 'request-limit')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, bytes)
  }
  const body = async (request: IncomingMessage, ceiling = policy.maxRequestBytes) => {
    const bytes = await rawBody(request, ceiling)
    try {
      return admitWorkflowData(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        { maxBytes: ceiling, maxDepth: 64, maxValues: 100_000 })
    } catch { throw new HttpError(400, 'invalid-json') }
  }
  const handle = async (request: IncomingMessage, response: ServerResponse, observation?: HttpRequestObservation) => {
    const refused = (error: unknown) => error instanceof HttpError || error instanceof WebhookAuthenticationError
    const access = <T>(stage: HttpAccessStage, work: () => T) => httpAccessGuard(() => host.observeHttpAccess?.(stage), work, refused)
    try {
      access('headers', () => {
      for (const name of ['host', 'authorization', 'origin', 'sec-fetch-site', 'content-type', 'x-jevable-protocol', 'x-jevable-instance', 'x-jevable-release-sha256', 'traceparent', 'accept', 'last-event-id', 'webhook-id', 'webhook-timestamp', 'webhook-signature']) {
        let count = 0
        for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i]!.toLowerCase() === name) count++
        if (count > 1) throw new HttpError(400, 'ambiguous-headers')
      }
      if (Object.keys(request.headers).some(name => name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-'))) throw new HttpError(403, 'proxy-headers-rejected')
      if (request.headers.host !== authority || (!tls && request.socket.remoteAddress !== '127.0.0.1')) throw new HttpError(403, 'host-rejected')
      if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new HttpError(403, 'origin-rejected')
      if (request.headers['sec-fetch-site'] !== undefined && !['none', 'same-origin'].includes(String(request.headers['sec-fetch-site']))) throw new HttpError(403, 'origin-rejected')
      if (!request.url || request.url.length > 2048 || request.url.includes('?') || request.url.includes('#')) throw new HttpError(400, 'invalid-path')
      if (state !== 'ready') throw new HttpError(503, 'draining')
      })
      if ((page || releasePage) && request.url === '/' && request.method === 'GET'
        || reviewerPage && request.url === '/review' && request.method === 'GET') {
        const selected = request.url === '/review' ? reviewerPage! : page ?? releasePage!
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(selected.html),
          'Cache-Control': 'no-store', 'Content-Security-Policy': selected.csp, 'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', ...responseContextHeaders(response) })
        response.end(selected.html); return
      }
      if (webhookVerifier && request.url === '/v1/webhooks') {
        if (request.method !== 'POST') throw new HttpError(405, 'method-not-allowed')
        // One authority only. Unauthenticated execution context and management headers are not adopted.
        if (['authorization', 'traceparent', 'baggage', 'x-jevable-protocol', 'x-jevable-instance', 'x-jevable-release-sha256']
          .some(name => request.headers[name] !== undefined)) throw new HttpError(400, 'webhook-headers-rejected')
        if (active.size >= policy.maxConcurrentRequests) throw new HttpError(429, 'concurrency-limit')
        const signed = { id: request.headers['webhook-id'], timestamp: request.headers['webhook-timestamp'], signature: request.headers['webhook-signature'] }
        const input = await httpAccessGuardAsync(() => host.observeHttpAccess?.('signed-webhook'), async () => {
          if (Object.values(signed).some(value => typeof value !== 'string')) throw new WebhookAuthenticationError()
          return webhookVerifier.verify({ ...signed as { id: string; timestamp: string; signature: string },
            body: await rawBody(request, Math.min(policy.maxRequestBytes, WEBHOOK_LIMITS.bodyBytes)) })
        }, refused)
        if (state !== 'ready') throw new HttpError(503, 'draining')
        if (rateLimiter) await admitRate('requests', observation)
        const admitted = await admitBackground(() => host.withTraceParent(undefined, () => observation
          ? observation.run(undefined, () => host.releaseMessages!.start(input)) : host.releaseMessages!.start(input)))
        send(response, admitted.observation === 'created' ? 202 : 200,
          asyncRunReceipt(instanceId, admitted.run, admitted.observation), { Location: '/v1/async-runs/' + admitted.run.id }); return
      }
      const scopedRoute = request.url === '/v1/preview/operations' || request.url === '/v1/preview/logout'
      const localBootstrap = Boolean(preview && policy.previewAutoConnect && request.url === '/v1/preview/local-bootstrap')
      // Browser CSRF guards, not protection against other local processes forging headers.
      if (localBootstrap) access('local-bootstrap', () => {
        if (request.headers.origin !== origin || request.headers.authorization !== undefined
          || request.headers['sec-fetch-site'] !== undefined && request.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, 'origin-rejected')
        if (request.headers['x-jevable-instance'] === undefined) throw new HttpError(400, 'instance-required')
      })
      const scopedToken = scopedRoute ? access('preview-session', () => {
        const value = preview?.authenticate(request.headers.authorization)
        if (!value) throw new HttpError(401, 'unauthorized')
        return value
      }) : undefined
      const reviewerRoute = policy.reviewerDecisions && request.url === '/v1/reviewer/decisions'
      const reviewerRequestRoute = policy.reviewerDecisions && Boolean(host.release) && request.url === '/v1/reviewer/request'
      const callerRoute = policy.callerOperations && request.url === '/v1/caller/operations'
      const callerStreamRoute = policy.callerOperations && request.url === '/v1/caller/stream'
      const delegatedRoute = reviewerRoute || reviewerRequestRoute || callerRoute || callerStreamRoute
      const asyncCreateRoute = Boolean(policy.asyncRuns) && request.url === '/v1/async-runs'
      // The header predicate above checked URL presence before any route dispatch.
      const asyncReadRoute = Boolean(policy.asyncRuns) && request.url!.startsWith('/v1/async-runs/')
      const delegatedToken = delegatedRoute && request.headers.authorization?.startsWith('Bearer ')
        ? request.headers.authorization.slice(7) : undefined
      const supplied = Buffer.from(request.headers.authorization ?? '')
      if (!localBootstrap && !scopedRoute) access(delegatedRoute ? 'grant-token-syntax' : 'owner-key', () => {
        if (delegatedRoute ? !grantTokenProof(delegatedToken) : supplied.length !== expectedAuth.length || !timingSafeEqual(supplied, expectedAuth)) throw new HttpError(401, 'unauthorized')
      })
      access('instance', () => {
        if (delegatedRoute && request.headers['x-jevable-instance'] === undefined) throw new HttpError(400, 'instance-required')
        if ((asyncCreateRoute || asyncReadRoute) && !z.uuid().safeParse(request.headers['x-jevable-instance']).success)
          throw new HttpError(400, 'instance-required')
        if (request.headers['x-jevable-instance'] !== undefined && request.headers['x-jevable-instance'] !== instanceId) throw new HttpError(409, 'instance-mismatch')
      })
      // One bounded control slot remains available when workflow requests fill ordinary capacity.
      const controlOnly = active.size >= policy.maxConcurrentRequests
      if (controlOnly && (active.size >= policy.maxConcurrentRequests + 1 || request.method !== 'POST'
        || !['/v1/operations', '/v1/preview/operations'].includes(request.url!))) throw new HttpError(429, 'concurrency-limit')
      if (request.url === '/v1/capabilities' && request.method === 'GET') {
        send(response, 200, { ...host.capabilities(), instanceId, remoteAccess: Boolean(tls), api: { transport, protocol: PROTOCOL_VERSION,
          maxRequestBytes: policy.maxRequestBytes, maxResponseBytes: policy.maxResponseBytes, maxConcurrentRequests: policy.maxConcurrentRequests,
          ...(rateLimiter ? { rateLimits: { ...rateLimiter.policy(), algorithm: coordinatedLimiter ? 'host-coordinated-token-bucket' : 'token-bucket',
            scope: coordinatedLimiter ? 'explicit-shared-scope' : 'runtime-instance',
            persistence: coordinatedLimiter ? 'coordinator-defined; not-attested' : false,
            ...(coordinatedLimiter ? { coordinator: coordinatedLimiter.identity() } : {}),
            automaticRetry: false, controls: { ...rateLimiter.policy().controls, authority: 'owner-or-scoped-preview-only' } } } : {}),
          asyncRuns: policy.asyncRuns ? { maxConcurrentRuns: policy.asyncRuns.maxConcurrentRuns, status: 'metadata-only',
            authority: 'owner-only; instance-required', release: release ? 'exact-release; read-hash-header-required' : 'owner-reviewed-pins',
            admission: '202-created; 200-retained; no-replay', automaticResume: false } : false,
          webhooks: policy.webhooks ? { authentication: 'standard-webhooks-v1-hmac-sha256', release: 'exact-api-release',
            input: 'entire-json-body', maxBodyBytes: WEBHOOK_LIMITS.bodyBytes, timestampToleranceSeconds: WEBHOOK_LIMITS.timestampToleranceSeconds,
            capacity: 'shared-with-owner-async-runs', authority: 'start-only; no-read-approval-or-control', automaticResume: false } : false,
          ...(host.operations ? { operations: host.operations } : {}),
          endpoints: [...(releasePage ? ['/', '/v1/openapi.json'] : []), ...(reviewerPage ? ['/review'] : []), '/v1/capabilities', '/v1/health', ...(host.operation ? ['/v1/operations'] : []), ...(policy.asyncRuns ? ['/v1/async-runs', '/v1/async-runs/{id}'] : []), ...(policy.webhooks ? ['/v1/webhooks'] : []), ...(policy.reviewerDecisions ? ['/v1/reviewer/decisions', ...(host.release && host.reviewerRequest ? ['/v1/reviewer/request'] : [])] : []), ...(policy.callerOperations ? ['/v1/caller/operations', '/v1/caller/stream'] : []), ...(preview ? ['/v1/preview/bootstrap', '/v1/preview/operations', '/v1/preview/logout', ...(policy.previewAutoConnect ? ['/v1/preview/local-bootstrap'] : [])] : [])],
          ...(policy.reviewerDecisions ? { reviewerDecisions: 'issued-exact-attempt-grant; metadata-only; instance-required' } : {}),
          ...(policy.callerOperations ? { callerOperations: 'issued-exact-release-grant; start-read-checkpoint-control-cancel; instance-and-release-required' } : {}),
          ...(policy.callerOperations ? { callerStream: 'bounded-post-sse; fresh-own-run-read-admission; metadata-only; no-resume-cursor-or-reconnect' } : {}),
          servesHtml: Boolean(preview || releasePage), preview: preview ? 'experimental-project-scoped' : false, instanceGuard: 'x-jevable-instance' } }); return
      }
      if (releaseSpec && request.url === '/v1/openapi.json') {
        if (request.method !== 'GET') throw new HttpError(405, 'method-not-allowed')
        if (rateLimiter) await admitRate('controls', observation)
        send(response, 200, releaseSpec); return
      }
      access('protocol', () => { if (request.headers['x-jevable-protocol'] !== PROTOCOL_VERSION) throw new HttpError(409, 'protocol-mismatch') })
      if (request.url === '/v1/health' && request.method === 'GET') {
        if (rateLimiter) await admitRate('controls', observation)
        send(response, 200, { schemaVersion: 1, instanceId, status: state, activeRequests: active.size,
          ...(policy.asyncRuns ? { activeAsyncRuns: asyncWork.size } : {}),
          ...(host.health ? { runtime: await host.health() } : {}),
          ...(release ? { release: release.pin, execution: 'not-run-by-health-check' } : {}) }); return
      }
      if (asyncReadRoute) {
        if (request.method !== 'GET') throw new HttpError(405, 'method-not-allowed')
        if (release) {
          access('release-pin', () => {
          const pin = request.headers['x-jevable-release-sha256']
          if (typeof pin !== 'string' || !/^[a-f0-9]{64}$/u.test(pin)) throw new HttpError(400, 'release-required')
          if (pin !== release.pin.sha256) throw new HttpError(409, 'release-mismatch')
          })
        }
        // Observation does not adopt a supplied parent, execute, resume or expose payloads.
        if (rateLimiter) await admitRate('controls', observation)
        const run = await host.withTraceParent(undefined, () => host.asyncRuns!.show(request.url!.slice('/v1/async-runs/'.length)))
        send(response, 200, asyncRunReceipt(instanceId, run, 'read')); return
      }
      if (!localBootstrap && !delegatedRoute && !asyncCreateRoute && !(host.operation && request.url === '/v1/operations') && !(preview && ['/v1/preview/bootstrap', '/v1/preview/operations', '/v1/preview/logout'].includes(request.url!))) throw new HttpError(404, 'not-found')
      if (request.method !== 'POST') throw new HttpError(405, 'method-not-allowed')
      if (callerStreamRoute && (request.headers.accept !== 'text/event-stream' || request.headers['last-event-id'] !== undefined))
        throw new HttpError(400, 'invalid-stream-request')
      const command = await body(request, reviewerRoute || reviewerRequestRoute || callerStreamRoute ? Math.min(policy.maxRequestBytes, 4096) : policy.maxRequestBytes)
      if (controlOnly) {
        // Read the exact checkpoint guard, then submit pause without needing an ordinary execution slot.
        // Normal schema/scope/actor validation still applies below. This is one shared bounded slot.
        if (!isOwnerControlCommand(request.url!, command)) throw new HttpError(429, 'concurrency-limit')
      }
      // Requests accepted before drain may finish; body arrival does not grant admission after drain begins.
      if (state !== 'ready') throw new HttpError(503, 'draining')
      // All POST routes share ordinary credit; only owner/scoped status/stop requests use reserve.
      // Delegated syntax is not authority: invalid grants can consume ordinary credit but never reserve.
      if (rateLimiter) await admitRate(!delegatedRoute && isOwnerControlCommand(request.url!, command) ? 'controls' : 'requests', observation)
      if (localBootstrap || request.url === '/v1/preview/bootstrap' || request.url === '/v1/preview/logout') {
        if (!z.strictObject({}).safeParse(command).success) throw new HttpError(400, 'invalid-command')
        const result = localBootstrap || request.url === '/v1/preview/bootstrap' ? preview!.bootstrap() : (preview!.revoke(scopedToken!), { status: 'disconnected' })
        send(response, 200, { schemaVersion: 1, instanceId, result }); return
      }
      const parent = request.headers.traceparent
      if (Array.isArray(parent)) throw new HttpError(400, 'ambiguous-headers')
      // Authenticated admission only. Multiple baggage fields combine per W3C; policy is owned by the runtime.
      const baggage = Array.isArray(request.headers.baggage) ? request.headers.baggage.join(',') : request.headers.baggage
      const contextual = <T>(execute: () => T): T => host.withTraceContext
        ? host.withTraceContext({ traceparent: parent, baggage }, () => observation ? observation.run(parent, execute) : execute())
        : observation ? observation.run(parent, execute) : host.withTraceParent(parent, execute)
      if (asyncCreateRoute) {
        const admitted = await admitBackground(() => contextual(() => host.asyncRuns!.start(command)))
        send(response, admitted.observation === 'created' ? 202 : 200, asyncRunReceipt(instanceId, admitted.run, admitted.observation),
          { Location: '/v1/async-runs/' + admitted.run.id }); return
      }
      if (callerStreamRoute) {
        const parsed = callerStreamRequestSchema.safeParse(command)
        if (!parsed.success) throw new HttpError(400, 'invalid-command')
        const controller = new AbortController(), onClose = () => controller.abort('disconnected')
        streams.add(controller); response.once('close', onClose)
        const read = () => host.callerOperation!(delegatedToken!, { operation: 'read', id: parsed.data.id, release: parsed.data.release }, (pin, execute) => {
          access('release-pin', () => {
            if (pin.id !== parsed.data.release.id || pin.sha256 !== parsed.data.release.sha256 || pin.revision !== parsed.data.release.revision)
              throw new HttpError(404, 'not-found')
          })
          // Read-only observation never adopts a supplied parent or reconstructs workflow telemetry.
          return host.withTraceParent(undefined, execute)
        })
        let bytes = 0
        try {
          for await (const event of observeCallerRun(read, instanceId, parsed.data, controller.signal)) {
            if (response.destroyed || response.writableEnded) return
            const chunk = encodeCallerStreamEvent(event)
            bytes += Buffer.byteLength(chunk)
            if (bytes > policy.maxResponseBytes) {
              if (!response.headersSent) throw new HttpError(413, 'response-limit')
              response.destroy(); return
            }
            if (!response.headersSent) response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
              'Referrer-Policy': 'no-referrer', 'X-Jevable-Protocol': PROTOCOL_VERSION, ...responseContextHeaders(response) })
            // Backpressure retains at most one frame. A slow/disconnected consumer never holds an owner indefinitely.
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => { response.destroy(); done(new Error('stream-write-timeout')) }, 5000)
              const aborted = () => done(new Error('stream-stopped'))
              const done = (error?: Error | null) => { clearTimeout(timer); controller.signal.removeEventListener('abort', aborted); error ? reject(error) : resolve() }
              const finalDrain = event?.type === 'stopped' && event.reason === 'draining'
              if (!finalDrain) controller.signal.addEventListener('abort', aborted, { once: true })
              if (controller.signal.aborted && !finalDrain) { done(new Error('stream-stopped')); return }
              response.write(chunk, done)
            })
          }
          response.end(); return
        } catch (error) {
          if (response.headersSent) { response.destroy(); return }
          throw error
        } finally { streams.delete(controller); response.off('close', onClose) }
      }
      if (reviewerRoute) {
        const parsed = reviewerDecisionRequestSchema.safeParse(command)
        if (!parsed.success) throw new HttpError(400, 'invalid-command')
        // Syntax is not authority. SDK authenticates role/action before invoking this trusted context.
        const result = await host.reviewerDecision!(delegatedToken!, parsed.data,
          execute => contextual(execute))
        send(response, 200, { schemaVersion: 1, instanceId, result }); return
      }
      if (reviewerRequestRoute) {
        if (!z.strictObject({}).safeParse(command).success) throw new HttpError(400, 'invalid-command')
        const result = await host.withTraceParent(undefined, () => host.reviewerRequest!(delegatedToken!))
        send(response, 200, { schemaVersion: 1, instanceId, result }); return
      }
      if (callerRoute) {
        const parsed = callerOperationSchema.safeParse(command)
        if (!parsed.success) throw new HttpError(400, 'invalid-command')
        const result = await host.callerOperation!(delegatedToken!, parsed.data, (pin, execute) => {
          // Compare the caller-reviewed pin to authenticated authority BEFORE execution or parent adoption.
          access('release-pin', () => {
            if (pin.id !== parsed.data.release.id || pin.sha256 !== parsed.data.release.sha256 || pin.revision !== parsed.data.release.revision)
              throw new HttpError(404, 'not-found')
          })
          return contextual(execute)
        })
        send(response, 200, { schemaVersion: 1, instanceId, result }); return
      }
      const execute = () => scopedRoute ? preview!.operation(command) : host.operation!(command)
      const result = await contextual(execute)
      send(response, 200, { schemaVersion: 1, instanceId, result })
    } catch (error) {
      const rejected = host.failure?.(error) ?? failure(error)
      send(response, rejected.status, { schemaVersion: 1, status: 'error', code: rejected.code,
        ...(error instanceof HttpRateLimitError ? { execution: 'not-dispatched', retryAfterSeconds: error.retryAfterSeconds } : {}),
        ...(error instanceof HttpRateCoordinatorError ? { execution: 'not-dispatched', quota: 'uncertain; no-retry-or-refund' } : {}),
        recovery: 'Inspect retained state before retrying a mutation. Reuse the original run UUID.' },
      error instanceof HttpRateLimitError ? { 'Retry-After': String(error.retryAfterSeconds) } : {})
    }
  }
  const admitBackground = async (start: () => ReturnType<AsyncRunHost['start']>) => {
    if (asyncWork.size >= policy.asyncRuns!.maxConcurrentRuns) throw new HttpError(429, 'async-concurrency-limit')
    let resolve!: () => void
    const slot = new Promise<void>(yes => { resolve = yes })
    let slotObservation: AsyncSlotObservation | undefined
    const finished = () => {
      asyncWork.delete(slot); resolve()
      try { slotObservation?.end() } catch { /* Diagnostic adapters never change work settlement or drain. */ }
    }
    asyncWork.add(slot)
    try { slotObservation = host.observeHttpAsyncSlot?.() } catch { /* Optional diagnostics never block admission. */ }
    let admitted
    try { admitted = await start() } catch (error) { finished(); throw error }
    try { slotObservation?.admitted() } catch { /* Diagnostics cannot abandon an admitted completion. */ }
    void admitted.completion.then(finished, finished)
    return admitted
  }
  const listener = (request: IncomingMessage, response: ServerResponse) => {
    let observation: HttpRequestObservation | undefined
    try { observation = host.observeHttpRequest?.(request.method, request.url) } catch { /* Diagnostics must not block admission. */ }
    if (observation) requestObservations.set(response, observation)
    // Install listeners before dispatch: even an immediate refusal or client disconnect must settle once.
    // Wait for handler completion too: a disconnected request can still commit durable work.
    const responseSettled = observation ? new Promise<void>(resolve => {
      const done = () => { response.off('finish', done); response.off('close', done); resolve() }
      response.once('finish', done); response.once('close', done)
    }) : undefined
    const task = handle(request, response, observation).finally(async () => {
      if (observation) {
        await responseSettled
        try { observation.end(response.headersSent ? response.statusCode : undefined, response.writableFinished) } catch { /* Best effort. */ }
      }
      requestObservations.delete(response)
    })
    active.add(task)
    void task.finally(() => active.delete(task)).catch(() => {})
  }
  const serverOptions = { maxHeaderSize: 16_384, headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 5_000 }
  const server = tls ? createHttpsServer({ ...serverOptions, cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2', handshakeTimeout: 10_000 }, listener)
    : createServer(serverOptions, listener)
  server.maxRequestsPerSocket = 100
  server.maxConnections = policy.maxConcurrentRequests * 4
  const observeFailure = (failure: HttpTransportFailure) => {
    try { host.observeHttpTransportFailure?.(transport, failure) } catch { /* Diagnostics never change socket handling. */ }
  }
  server.on('connection', socket => {
    let observation: HttpConnectionObservation | undefined
    try { observation = host.observeHttpConnection?.(transport) } catch { /* Admission is independent. */ }
    if (!observation) return
    const settled = new Promise<void>(resolve => socket.once('close', (hadError: boolean) => {
      try { observation.end(hadError) } catch { /* Best effort. */ }
      finally { resolve() }
    }))
    connectionSettlements.add(settled)
    void settled.then(() => connectionSettlements.delete(settled))
  })
  server.on('drop', () => observeFailure('connection-limit'))
  // HTTPS forwards tlsClientError to clientError with the same Error. Observe before
  // that forwarding, without changing its existing socket/response handling or counting twice.
  const tlsFailures = new WeakSet<Error>()
  if (tls) server.prependListener('tlsClientError', (error: Error) => { tlsFailures.add(error); observeFailure('tls-handshake') })
  server.on('clientError', (error, socket) => {
    if (!tlsFailures.has(error)) observeFailure(typeof (error as NodeJS.ErrnoException).code === 'string'
      && (error as NodeJS.ErrnoException).code!.startsWith('HPE_') ? 'http-parser' : 'http-client')
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  let telemetryResource: { serviceInstanceId: string } | undefined
  try {
    // Copy only the bounded identifier; a failing diagnostic host must not change startup.
    const identity = z.strictObject({ serviceInstanceId: z.uuid() }).safeParse(host.telemetryResource?.())
    if (identity.success) telemetryResource = identity.data
  } catch { /* Optional diagnostic metadata, never authority. */ }
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(policy.port, tls?.bindAddress ?? '127.0.0.1', () => { server.off('error', reject); resolve() }) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No listener')
    authority = tls?.authority ?? `127.0.0.1:${address.port}`
    origin = tls?.publicOrigin ?? `http://${authority}`
    preview = await host.preparePreview?.()
    state = 'ready'
  } catch (error) { server.close(); webhookVerifier?.close(); await host.close(); throw error }
  let drain: Promise<void> | undefined
  const close = async (timeoutMs = 5000) => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new WorkflowRuntimeError('invalid-command')
    if (!drain) {
      state = 'draining'
      for (const stream of streams) stream.abort('draining')
      const stopped = new Promise<void>(resolve => server.close(() => resolve()))
      server.closeIdleConnections()
      drain = (async () => {
        await Promise.allSettled([...active]); server.closeAllConnections(); await stopped
        // Sealed admission plus finished handlers means this snapshot contains every post-response execution.
        await Promise.allSettled([...asyncWork])
        // Server.close may resolve before socket close listeners. Export their final
        // active-count decrements before the owned telemetry provider shuts down.
        await Promise.allSettled([...connectionSettlements]); webhookVerifier?.close(); await host.close()
        state = 'closed'; resolveClosed()
      })()
      void drain.catch(rejectClosed)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([drain, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })])
      return { status: state as 'draining' | 'closed', activeRequests: active.size,
        ...(policy.asyncRuns ? { activeAsyncRuns: asyncWork.size } : {}) }
    } finally { clearTimeout(timer) }
  }
  return { url: origin, instanceId, protocol: PROTOCOL_VERSION, transport, close, closed,
    ...(telemetryResource ? { telemetryResource } : {}),
    listener: { address: tls?.bindAddress ?? '127.0.0.1', port: (server.address() as { port: number }).port },
    ...(tls ? { tls: { minimumVersion: 'TLSv1.2', certificateSha256: tls.certificateSha256 } } : {}),
    ...(release ? { release: release.pin } : {}),
    ...(preview ? { preview: { project: preview.pin, retention: 'project-and-runs-retained-after-session', visualReview: 'not-performed' } } : {}) }
}
