import { z } from 'zod'
import { reference } from '../providers/config.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { baggageKeysSchema } from './baggage.ts'

const destination = z.string().max(2048).refine(value => {
    try { const url = new URL(value); return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) }
    catch { return false }
  })
const grpcOrigin = (value: string) => { try { return new URL(value).pathname === '/' } catch { return false } }
export const telemetryConfigSchema = z.strictObject({
  protocol: z.enum(['http/protobuf', 'grpc']).default('http/protobuf'),
  endpoint: destination.optional(),
  metricsEndpoint: destination.optional(),
  exporterMetrics: z.boolean().default(false),
  retainedStateMetrics: z.boolean().default(false),
  runtimeWorkMetrics: z.boolean().default(false),
  storageQueueMetrics: z.boolean().default(false),
  storageTransactionMetrics: z.boolean().default(false),
  journalTransactions: z.boolean().default(false),
  sqliteStatementMetrics: z.boolean().default(false),
  httpRequests: z.boolean().default(false),
  httpResponseContext: z.boolean().default(false),
  httpConnections: z.boolean().default(false),
  httpAccessDecisions: z.boolean().default(false),
  grantOperations: z.boolean().default(false),
  grantPolicyDecisions: z.boolean().default(false),
  baggageKeys: baggageKeysSchema.optional(),
  logsEndpoint: destination.optional(),
  authentication: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('none') }),
    z.strictObject({ kind: z.literal('bearer'), credentialRef: reference })]),
  serviceName: z.string().min(1).max(128).default('jevable-workflow-runtime'),
  environment: z.string().min(1).max(128).default('local'),
  resource: z.strictObject({
    serviceNamespace: z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/u).optional(),
    kubernetes: z.strictObject({
      namespace: z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u).optional(),
      podName: z.string().min(1).max(253).regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/u).optional(),
      podUid: z.string().uuid().optional(),
      containerName: z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u).optional(),
      nodeName: z.string().min(1).max(253).regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/u).optional(),
      clusterName: z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/u).optional(),
    }).optional(),
  }).optional(),
  sampleRatio: z.number().min(0).max(1).default(1),
  queueSize: z.number().int().min(1).max(4096).default(256),
  batchSize: z.number().int().min(1).max(128).default(64),
  timeoutMs: z.number().int().min(10).max(30000).default(3000),
  flushTimeoutMs: z.number().int().min(10).max(60000).default(5000),
  intervalMs: z.number().int().min(10).max(60000).default(1000),
}).refine(value => value.batchSize <= value.queueSize && Boolean(value.endpoint || value.metricsEndpoint || value.logsEndpoint)
  && (!value.httpResponseContext || value.httpRequests)
  && (!value.journalTransactions || Boolean(value.endpoint || value.logsEndpoint))
  && (!(value.exporterMetrics || value.retainedStateMetrics || value.runtimeWorkMetrics || value.storageQueueMetrics || value.storageTransactionMetrics || value.sqliteStatementMetrics) || Boolean(value.metricsEndpoint))
  && (value.protocol !== 'grpc' || [value.endpoint, value.metricsEndpoint, value.logsEndpoint].every(endpoint =>
    endpoint === undefined || grpcOrigin(endpoint))))
export type TelemetryConfig = z.input<typeof telemetryConfigSchema>
export type TelemetryPolicy = z.output<typeof telemetryConfigSchema>
export function parseTelemetryConfig(value: unknown): TelemetryPolicy {
  const result = telemetryConfigSchema.safeParse(value)
  if (!result.success) throw new WorkflowRuntimeError('invalid-command')
  return result.data
}

/** Narrow W3C v00 admission. No ambient context or tracestate is accepted. Baggage has a separate explicit policy. */
export function parseTraceParent(value: string | undefined) {
  if (value === undefined) return undefined
  const match = /^00-((?!0{32})[a-f0-9]{32})-((?!0{16})[a-f0-9]{16})-(00|01)$/u.exec(value)
  if (!match) throw new WorkflowRuntimeError('invalid-command')
  return { traceId: match[1]!, spanId: match[2]!, traceFlags: match[3] === '01' ? 1 : 0, isRemote: true }
}
