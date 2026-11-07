import { randomUUID } from 'node:crypto'
import { z } from 'zod'

// Report admission must not initialize the optional collector SDK/transport.
const outcome = z.enum(['acknowledged', 'warning', 'rejected', 'failed', 'aborted', 'not-sent'])
const resultSchema = z.strictObject({ signal: z.enum(['traces', 'metrics', 'logs']), outcome,
  records: z.literal(1), attempted: z.boolean(), rejected: z.number().int().min(0).max(1).nullable(),
  failure: z.enum(['transport', 'response', 'serialization', 'collection', 'partial-rejection', 'aborted']).nullable() })
export const collectorProbeReportSchema = z.strictObject({ schemaVersion: z.literal(1), id: z.uuid(),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
  status: z.enum(['disabled', 'acknowledged', 'warning', 'failed', 'aborted']),
  protocol: z.enum(['http/protobuf', 'grpc']).nullable(), signals: z.array(resultSchema).max(3),
  trace: z.strictObject({ traceId: z.string().regex(/^(?!0{32}$)[a-f0-9]{32}$/u),
    spanId: z.string().regex(/^(?!0{16}$)[a-f0-9]{16}$/u), traceFlags: z.literal(1) }).nullable(),
  execution: z.literal('not-run'), retries: z.literal(false),
  sampling: z.literal('explicit-synthetic; independent-of-workflow-sampling'),
  deliveryGuarantee: z.literal('collector-response-only; not-backend-storage-or-dashboard'),
}).refine(report => new Set(report.signals.map(s => s.signal)).size === report.signals.length
  && Date.parse(report.finishedAt) >= Date.parse(report.startedAt)
  && (report.status === 'disabled' ? report.protocol === null && report.trace === null && report.signals.length === 0
    : report.protocol !== null && report.trace !== null && report.signals.length > 0)
  && report.signals.every(s => s.outcome === 'acknowledged' ? s.attempted && s.rejected === 0 && s.failure === null
    : s.outcome === 'warning' ? s.attempted && s.rejected === 0 && s.failure === null
    : s.outcome === 'rejected' ? s.attempted && s.rejected === 1 && s.failure === 'partial-rejection'
    : s.rejected === null && s.failure !== null
      && (s.outcome === 'not-sent' ? !s.attempted : s.outcome === 'failed' ? s.attempted : s.failure === 'aborted'))
  && (report.status === 'disabled' || report.status === 'aborted' ? report.status !== 'aborted' || report.signals.some(s => s.failure === 'aborted')
    : report.status === 'failed' ? report.signals.some(s => ['rejected', 'failed', 'not-sent'].includes(s.outcome))
    : report.signals.every(s => ['acknowledged', 'warning'].includes(s.outcome))
      && (report.status === 'warning') === report.signals.some(s => s.outcome === 'warning')))
export type CollectorProbeReport = z.infer<typeof collectorProbeReportSchema>
export type CollectorProbeSignalResult = z.infer<typeof resultSchema>

/** Fresh identity per explicit invocation; not a durable or idempotent execution receipt. */
export function disabledCollectorProbe(): CollectorProbeReport {
  const at = new Date().toISOString()
  return collectorProbeReportSchema.parse({ schemaVersion: 1, id: randomUUID(), startedAt: at, finishedAt: at,
    status: 'disabled', protocol: null, signals: [], trace: null, execution: 'not-run', retries: false,
    sampling: 'explicit-synthetic; independent-of-workflow-sampling',
    deliveryGuarantee: 'collector-response-only; not-backend-storage-or-dashboard' })
}
