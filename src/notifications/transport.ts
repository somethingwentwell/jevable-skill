import { createHmac } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { notificationEndpointSchema, approvalNotificationEventSchema, type NotificationEndpoint,
  type ApprovalNotificationEvent, type NotificationResult } from './schema.ts'

/** Standard Webhooks v1 HMAC key encoding; never retain this key or the signature in a delivery record. */
export function notificationSigningKey(value: string): Buffer {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new WorkflowRuntimeError('invalid-command')
  const encoded = value.slice(6), key = Buffer.from(encoded, 'base64')
  if (key.length < 24 || key.length > 64 || key.toString('base64') !== encoded) throw new WorkflowRuntimeError('invalid-command')
  return key
}

/** Exactly one POST. No redirects, automatic retries, response-body retention or ambient proxy configuration. */
export async function postApprovalNotification(endpointValue: NotificationEndpoint, eventValue: ApprovalNotificationEvent,
  secret: string, signal?: AbortSignal): Promise<NotificationResult> {
  const endpoint = notificationEndpointSchema.safeParse(endpointValue), event = approvalNotificationEventSchema.safeParse(eventValue)
  if (!endpoint.success || !event.success) throw new WorkflowRuntimeError('invalid-command')
  const key = notificationSigningKey(secret), body = JSON.stringify(event.data)
  if (Buffer.byteLength(body) > 65536) throw new WorkflowRuntimeError('limit')
  if (signal?.aborted) return { status: 'uncertain', reason: 'aborted' }
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = createHmac('sha256', key).update(`${event.data.id}.${timestamp}.${body}`).digest('base64')
  key.fill(0)
  const url = new URL(endpoint.data.url)
  return new Promise(resolve => {
    let settled = false, timer: ReturnType<typeof setTimeout> | undefined
    const done = (result: NotificationResult) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(result)
    }
    const abort = () => { done({ status: 'uncertain', reason: 'aborted' }); request.destroy() }
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'POST', agent: false, maxHeaderSize: 16384, rejectUnauthorized: true, minVersion: 'TLSv1.2',
      headers: { 'content-type': 'application/cloudevents+json', 'content-length': Buffer.byteLength(body),
        'webhook-id': event.data.id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` },
    }, response => {
      const status = response.statusCode
      if (status !== undefined && status >= 200 && status <= 299) done({ status: 'accepted', httpStatus: status })
      else if (status !== undefined && status >= 300 && status <= 599) done({ status: 'rejected', httpStatus: status })
      else done({ status: 'uncertain', reason: 'invalid-response' })
      response.destroy(); request.destroy()
    })
    request.on('error', () => done({ status: 'uncertain', reason: 'transport' }))
    timer = setTimeout(() => { done({ status: 'uncertain', reason: 'timeout' }); request.destroy() }, endpoint.data.timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    if (!settled) request.end(body)
  })
}
