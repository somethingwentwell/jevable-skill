import { AsyncLocalStorage } from 'node:async_hooks'
import type { SpanContext } from '@opentelemetry/api'
import { RuntimeTelemetry } from '../telemetry/traces.ts'
import { parseTelemetryConfig, type TelemetryConfig } from '../telemetry/config.ts'
import type { OtlpCredential } from '../telemetry/otlp.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { parseTraceRequestContext, type TraceRequestContext } from '../telemetry/baggage.ts'
import type { SuiteObservation, SuiteObservationIdentity } from './suite-observation.ts'

const ownerFlags = ['retainedStateMetrics', 'runtimeWorkMetrics', 'storageQueueMetrics', 'storageTransactionMetrics',
  'journalTransactions', 'sqliteStatementMetrics', 'httpRequests', 'httpConnections', 'grantOperations', 'grantPolicyDecisions'] as const
/** Client diagnostics never impersonate storage, execution workers, sockets or grant administration. */
export function parseSuiteTelemetryConfig(value: unknown) {
  const policy = parseTelemetryConfig(value)
  if (ownerFlags.some(flag => policy[flag])) throw new WorkflowRuntimeError('invalid-command')
  return { ...policy, serviceName: (value as TelemetryConfig).serviceName ?? 'jevable-suite-client' }
}
export interface TestSuiteTelemetry {
  observeTestSuite(identity: SuiteObservationIdentity, context?: Readonly<TraceRequestContext>): SuiteObservation | undefined
  traceContext(fallback?: Readonly<TraceRequestContext>): Readonly<TraceRequestContext> | undefined
  withTraceContext<T>(context: TraceRequestContext, work: () => T): T
  status(): ReturnType<RuntimeTelemetry['status']>
  flush(): ReturnType<RuntimeTelemetry['flush']>
  close(): ReturnType<RuntimeTelemetry['close']>
}
/** Explicit, private client pipeline. No runtime/storage owner, environment discovery or global OTel registration. */
export function createTestSuiteTelemetry(config: TelemetryConfig, options: { credential?: OtlpCredential } = {}): TestSuiteTelemetry {
  const policy = parseSuiteTelemetryConfig(config)
  if (Object.keys(options).some(key => key !== 'credential') || (options.credential !== undefined && typeof options.credential !== 'function')) throw new WorkflowRuntimeError('invalid-command')
  const pipeline = new RuntimeTelemetry(policy, options.credential ?? (() => undefined), { component: 'suite-client' })
  const parents = new AsyncLocalStorage<SpanContext>()
  return {
    observeTestSuite(identity, context) {
      const create = () => pipeline.observeTestSuite(identity, (parent, work) => parents.run(parent, work))
      if (context === undefined) return create()
      const snapshot = Object.freeze({ ...parseTraceRequestContext(context) })
      const observation = pipeline.withTraceContext(snapshot, create)
      return observation && { within: work => pipeline.withTraceContext(snapshot, () => observation.within(work)),
        finish: outcome => observation.finish(outcome), cases: counts => observation.cases?.(counts) }
    },
    traceContext(fallback) {
      const parent = parents.getStore()
      if (!parent) return fallback
      const traceparent = `00-${parent.traceId}-${parent.spanId}-${parent.traceFlags & 1 ? '01' : '00'}`
      const baggage = pipeline.baggage()
      return Object.freeze({ traceparent, ...(baggage === undefined ? {} : { baggage }) })
    },
    withTraceContext: (context, work) => pipeline.withTraceContext(context, work),
    status: () => pipeline.status(), flush: () => pipeline.flush(), close: () => pipeline.close(),
  }
}
