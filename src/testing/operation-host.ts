import { RuntimeHttpError, type RuntimeTraceContext } from '../http/client.ts'
import type { RuntimeOperation } from '../http/operations.ts'
import { parseTraceParent } from '../telemetry/config.ts'
import { parseTraceRequestContext, selectBaggage, type TraceRequestContext } from '../telemetry/baggage.ts'
import type { TestSuiteHost } from './suite.ts'
import type { TestSuiteTelemetry } from './telemetry.ts'

type SuiteOperation = Extract<RuntimeOperation, { operation: 'tests.result' | 'tests.show' | 'projects.show' | 'tests.run' }>
export interface TestSuiteOperationClient { call(command: SuiteOperation, context?: RuntimeTraceContext): Promise<unknown> }
/** Existing pinned operation client supplies transport/authority; this host never creates or owns a service. */
export function createOperationTestSuiteHost(client: TestSuiteOperationClient, traceContext?: RuntimeTraceContext, telemetry?: TestSuiteTelemetry): TestSuiteHost {
  let context: Readonly<TraceRequestContext> | undefined
  try {
    if (traceContext !== undefined) {
      const snapshot = parseTraceRequestContext(typeof traceContext === 'string' ? { traceparent: traceContext } : traceContext)
      parseTraceParent(snapshot.traceparent)
      context = Object.freeze({ ...snapshot, baggage: selectBaggage(snapshot.baggage) })
    }
  } catch { throw new RuntimeHttpError('invalid-command') }
  const call = (command: SuiteOperation) => {
    let carrier = context
    try {
      const candidate = telemetry?.traceContext(context)
      void Promise.resolve(candidate).catch(() => {})
      if (candidate !== undefined) {
        // Optional diagnostic hooks must return a synchronous, plain carrier.
        // Promise objects otherwise look like valid empty carriers to the parser.
        if (candidate === null || typeof candidate !== 'object' ||
          (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null) ||
          typeof (candidate as { then?: unknown }).then === 'function') throw new Error('invalid diagnostic carrier')
        const snapshot = parseTraceRequestContext(candidate)
        parseTraceParent(snapshot.traceparent)
        carrier = Object.freeze({ ...snapshot, baggage: selectBaggage(snapshot.baggage) })
      }
    } catch { /* Diagnostic carrier faults keep the original explicitly admitted context. */ }
    return client.call(command, carrier)
  }
  return { ...(telemetry ? { observeTestSuite: identity => telemetry.observeTestSuite(identity, context) } : {}),
    testResult: runId => call({ operation: 'tests.result', runId }), testCase: id => call({ operation: 'tests.show', id }),
    project: id => call({ operation: 'projects.show', id }), runTest: (test, runId) => call({ operation: 'tests.run', test, runId }) }
}
