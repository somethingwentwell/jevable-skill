import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { z } from 'zod'
import { validateCa } from '../http/tls.ts'

/** Optional website-account client, not workflow ownership, provider discovery or desktop attachment. */
export class AccountError extends Error {
  constructor(readonly code: 'invalid-config' | 'invalid-authorization' | 'invalid-grant' | 'invalid-code' | 'refused' | 'invalid-response' | 'unavailable' | 'outcome-unknown', readonly status?: number) {
    super(`Jevable account operation failed: ${code}. No automatic retry; inspect the issuer's key list after an uncertain exchange or revocation.`)
    this.name = 'AccountError'
  }
}
export interface AccountClientOptions { issuer: string; ca?: string; allowLoopbackHttp?: boolean; timeoutMs?: number; maxResponseBytes?: number }
const printable = z.string().max(320).refine(s => !/[\u0000-\u001f\u007f]/u.test(s))
const authorizationSchema = z.strictObject({ format: z.literal('jevable.ai/account-authorization/v1'), issuer: z.string(),
  redirectUri: z.string(), name: printable.min(1).max(40), state: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), authorizationUrl: z.string() })
const grantSchema = z.strictObject({ format: z.literal('jevable.ai/account-grant/v1'), issuer: z.string(),
  keyId: z.uuid(), email: printable, key: z.string().regex(/^jvk_[A-Za-z0-9_-]{32}$/u) })
export type AccountAuthorization = z.infer<typeof authorizationSchema>
/** Contains a secret. Hosts must persist privately and never emit this value in CLI/preview output. */
export type AccountGrant = z.infer<typeof grantSchema>
const exchangeSchema = z.strictObject({ key: grantSchema.shape.key, key_id: z.uuid(), email: printable })
const statusSchema = z.strictObject({ email: printable,
  plan: z.strictObject({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u), name: printable, billing: z.enum(['monthly', 'annual']),
    status: z.enum(['active', 'trialing', 'past_due']), renews_at: z.iso.datetime({ offset: true }).nullable(), ends_at: z.iso.datetime({ offset: true }).nullable() }).nullable(),
  balance: z.number().finite(), low_balance: z.boolean(), low_balance_threshold: z.number().finite().nonnegative(),
  links: z.strictObject({ top_up: z.string(), manage_plan: z.string(), keys: z.string() }) })
export type AccountStatus = { status: 'unauthorized'; issuer: string; keyId: string; revocation: 'not-proven' }
  | ({ status: 'active'; issuer: string; keyId: string } & z.infer<typeof statusSchema>)
const challenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')
function redirect(value: string) {
  if (value === 'urn:jevable:paste') return value
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || !url.port || url.port === '0' || url.username || url.password || url.hash) throw new Error()
    return url.toString()
  } catch { throw new AccountError('invalid-authorization') }
}
function authorizationUrl(value: Pick<AccountAuthorization, 'issuer' | 'redirectUri' | 'name' | 'state' | 'challenge'>) {
  const url = new URL('/app/authorize', value.issuer)
  for (const [key, data] of Object.entries({ redirect_uri: value.redirectUri, name: value.name, state: value.state, code_challenge: value.challenge })) url.searchParams.set(key, data)
  return url.toString()
}
function admittedOrigin(value: string) {
  const url = new URL(value)
  if (url.origin !== value || url.username || url.password || url.search || url.hash || url.port === '0'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && url.port))) throw new Error()
  return url
}
export function inspectAccountAuthorization(value: unknown): AccountAuthorization {
  try {
    const a = authorizationSchema.parse(value)
    admittedOrigin(a.issuer)
    if (redirect(a.redirectUri) !== a.redirectUri
      || challenge(a.verifier) !== a.challenge || authorizationUrl(a) !== a.authorizationUrl) throw new Error()
    return a
  } catch { throw new AccountError('invalid-authorization') }
}
export function inspectAccountGrant(value: unknown): AccountGrant {
  try { const g = grantSchema.parse(value); admittedOrigin(g.issuer); return g }
  catch { throw new AccountError('invalid-grant') }
}

/** Shared pure admission for transport and durable host intent; never persists the code. */
export function admitAccountExchange(issuer: string, value: unknown, code: string, returnedState?: string) {
  const a = inspectAccountAuthorization(value)
  if (a.issuer !== issuer) throw new AccountError('invalid-authorization')
  if (!/^jvc_[A-Za-z0-9_-]{32}$/u.test(code)) throw new AccountError('invalid-code')
  if (a.redirectUri !== 'urn:jevable:paste' && (typeof returnedState !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(returnedState)
    || !timingSafeEqual(Buffer.from(returnedState), Buffer.from(a.state)))) throw new AccountError('invalid-authorization')
  return a
}

/** Explicit pinned origin; verified TLS, bounded bodies/deadline, no redirects, cookies, discovery or retries. */
export class AccountClient {
  readonly issuer: string
  private readonly ca: string | undefined
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  constructor(value: AccountClientOptions) {
    try {
      const options = z.strictObject({ issuer: z.string(), ca: z.string().optional(), allowLoopbackHttp: z.boolean().default(false),
        timeoutMs: z.number().int().min(1).max(60_000).default(10_000), maxResponseBytes: z.number().int().min(1024).max(100_000).default(32_000) }).parse(value)
      const url = new URL(options.issuer)
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port === '0'
        || (url.protocol !== 'https:' && !(options.allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && url.port))
        || (options.ca !== undefined && url.protocol !== 'https:')) throw new Error()
      this.issuer = url.origin; this.ca = options.ca === undefined ? undefined : validateCa(options.ca)
      this.timeoutMs = options.timeoutMs; this.maxResponseBytes = options.maxResponseBytes
    } catch { throw new AccountError('invalid-config') }
  }
  /** Pure preparation. The returned verifier is private; only authorizationUrl is suitable for opening. */
  prepareAuthorization(name: string, redirectUri = 'urn:jevable:paste'): AccountAuthorization {
    const verifier = randomBytes(32).toString('base64url')
    const value = { format: 'jevable.ai/account-authorization/v1' as const, issuer: this.issuer,
      name, redirectUri: redirect(redirectUri), state: randomBytes(32).toString('base64url'), verifier, challenge: challenge(verifier) }
    return inspectAccountAuthorization({ ...value, authorizationUrl: authorizationUrl(value) })
  }
  /** Mutating one-time exchange. Host must retain its private intent before dispatch, and never auto-retry uncertainty. */
  async exchange(value: unknown, code: string, returnedState?: string): Promise<AccountGrant> {
    const a = admitAccountExchange(this.issuer, value, code, returnedState)
    const response = await this.request('/api/app/token', { code, code_verifier: a.verifier, redirect_uri: a.redirectUri })
    this.requireSuccess(response.status, true)
    const result = exchangeSchema.safeParse(response.body)
    if (!result.success) throw new AccountError('outcome-unknown', response.status)
    return inspectAccountGrant({ format: 'jevable.ai/account-grant/v1', issuer: this.issuer, keyId: result.data.key_id, email: result.data.email, key: result.data.key })
  }
  private admitGrant(value: unknown) { const grant = inspectAccountGrant(value); if (grant.issuer !== this.issuer) throw new AccountError('invalid-grant'); return grant }
  async status(value: unknown): Promise<AccountStatus> {
    const grant = this.admitGrant(value), response = await this.request('/api/app/account', undefined, grant.key)
    if (response.status === 401) return { status: 'unauthorized', issuer: this.issuer, keyId: grant.keyId, revocation: 'not-proven' }
    this.requireSuccess(response.status, false)
    const result = statusSchema.safeParse(response.body)
    if (!result.success || result.data.low_balance !== (result.data.balance < result.data.low_balance_threshold)) throw new AccountError('invalid-response')
    for (const [key, path] of Object.entries({ top_up: '/checkout', manage_plan: '/console/billing', keys: '/console/keys' }))
      if (result.data.links[key as keyof typeof result.data.links] !== this.issuer + path) throw new AccountError('invalid-response')
    return { status: 'active', issuer: this.issuer, keyId: grant.keyId, ...result.data }
  }
  /** Explicit service revocation, not local credential erasure or proof of provider-side cancellation. */
  async revoke(value: unknown): Promise<{ issuer: string; keyId: string; revoked: true }> {
    const grant = this.admitGrant(value), response = await this.request('/api/app/revoke', {}, grant.key)
    this.requireSuccess(response.status, true)
    if (!z.strictObject({ revoked: z.literal(true) }).safeParse(response.body).success) throw new AccountError('outcome-unknown', response.status)
    return { issuer: this.issuer, keyId: grant.keyId, revoked: true }
  }
  private requireSuccess(status: number, mutation: boolean) {
    if (status !== 200) throw new AccountError(mutation && status >= 500 ? 'outcome-unknown' : 'refused', status)
  }
  private async request(path: string, body?: unknown, token?: string): Promise<{ status: number; body: unknown }> {
    const mutation = body !== undefined
    try {
      return await new Promise((yes, no) => {
        const payload = body === undefined ? undefined : JSON.stringify(body), request = this.issuer.startsWith('https:') ? httpsRequest : httpRequest
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs)
        const fail = () => { clearTimeout(timer); no(new AccountError(mutation ? 'outcome-unknown' : 'unavailable')) }
        const outgoing = request(this.issuer + path, { method: mutation ? 'POST' : 'GET', signal: controller.signal, agent: false,
          rejectUnauthorized: true, minVersion: 'TLSv1.2', maxHeaderSize: 16_384, ...(this.ca === undefined ? {} : { ca: this.ca }),
          headers: { Accept: 'application/json', ...(token === undefined ? {} : { Authorization: 'Bearer ' + token }),
            ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) } }, response => {
          let length = 0; const parts: Buffer[] = []
          response.on('error', fail); response.on('aborted', fail)
          response.on('data', (part: Buffer) => { length += part.length; if (length > this.maxResponseBytes) { controller.abort(); fail() } else parts.push(part) })
          response.on('end', () => {
            clearTimeout(timer)
            const status = response.statusCode ?? 0
            if (status !== 200) { yes({ status, body: undefined }); return }
            try {
              if (!/^application\/json(?:\s*;|$)/iu.test(String(response.headers['content-type']))) throw new Error()
              yes({ status, body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))) })
            } catch { no(new AccountError(mutation ? 'outcome-unknown' : 'invalid-response', status)) }
          })
        })
        outgoing.on('error', fail); outgoing.end(payload)
      })
    } catch (error) { if (error instanceof AccountError) throw error; throw new AccountError(mutation ? 'outcome-unknown' : 'unavailable') }
  }
}
