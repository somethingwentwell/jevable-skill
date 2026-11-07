import { setImmediate as yieldToHost } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import type { Span } from '@opentelemetry/api'
import type { CompiledWorkflow, WorkflowCompilerLimits } from '../workflow/index.ts'
import type { RuntimeTelemetry } from '../telemetry/traces.ts'
import type { LocalRun } from './run-types.ts'
import type { RunEventKind } from './run-transition.ts'
import type { ModelCalls } from './model-port.ts'
import type { ExecutionControl } from './control.ts'
import { advanceDurably, findNode } from './run-evaluator.ts'
import { WorkflowRuntimeError } from './errors.ts'
import { savedRunTrace } from './run-telemetry.ts'
import { recordedRoutes } from './run-routes.ts'
import { breakpointAt, breakpointConfiguration } from './breakpoints.ts'
import { executionCheckpointHash } from './run-types.ts'
import { requestedPause } from './pause.ts'

type Awaitable<T> = T | Promise<T>
/** Host retains execution ownership and concurrency guards. Each save commits checkpoint and event together. */
export interface ExecutionPersistence {
  load(id: string): Awaitable<LocalRun>
  events(id: string): Awaitable<readonly { kind: string; data: unknown }[]>
  save(record: LocalRun, kind: RunEventKind, data: unknown): Awaitable<void>
  saveSegment(record: LocalRun, span: Span | undefined, operation: 'run' | 'resume' | 'approval'): Awaitable<LocalRun>
  finishCancellation(record: LocalRun): Awaitable<LocalRun>
}
export interface ExecutionOptions {
  port: ExecutionPersistence
  initial: LocalRun
  graph: CompiledWorkflow
  limits: WorkflowCompilerLimits
  maxTransitions: number
  operation: 'run' | 'resume' | 'approval'
  signal: AbortSignal
  models?: ModelCalls | undefined
  telemetry?: RuntimeTelemetry | undefined
  continuedSpan?: Span | undefined
  budget?: number
  control?: ExecutionControl | undefined
}

/** Shared execution loop. Await every persistence boundary; never retry an uncertain write or dispatch. */
export async function executeWorkflow(options: ExecutionOptions): Promise<LocalRun> {
  const { port: sourcePort, initial, graph, limits, maxTransitions, operation, signal, models, telemetry, continuedSpan, control } = options
  const budget = options.budget ?? Infinity
  let record = initial
  const initialHit = breakpointAt(initial)
  let segment = continuedSpan
  let nodeSpan: Span | undefined
  const scope = <T>(span: Span | undefined, work: () => T): T => telemetry ? telemetry.withJournalSpan(span, work) : work()
  const port: ExecutionPersistence = {
    load: id => scope(nodeSpan ?? segment, () => sourcePort.load(id)),
    events: id => scope(nodeSpan ?? segment, () => sourcePort.events(id)),
    save: (next, kind, data) => scope(nodeSpan ?? segment, () => sourcePort.save(next, kind, data)),
    saveSegment: (next, span, kind) => scope(span, () => sourcePort.saveSegment(next, span, kind)),
    finishCancellation: next => scope(segment, () => sourcePort.finishCancellation(next)),
  }
  let failed = true
  try {
    if (!segment) { segment = telemetry?.segment(initial, operation); record = await port.saveSegment(record, segment, operation) }
    if (control) { segment?.setAttribute('jevable.control.request_id', control.requestId); segment?.setAttribute('jevable.control.mode', control.mode) }
    let transitions = (await port.events(record.id)).filter(event => event.kind === 'node-intent').length
    let advanced = 0
    while (record.state.status === 'paused') {
      nodeSpan = undefined // No successor read may inherit an already ended prior node.
      // Yield to control requests even for long deterministic rule/loop runs.
      await yieldToHost()
      record = await port.load(initial.id)
      if (record.cancellation) { record = await port.finishCancellation(record); break }
      if (record.state.status !== 'paused') throw new WorkflowRuntimeError('conflict')
      if (advanced >= budget) break
      const checkpoint = record.state
      const node = findNode(graph, checkpoint.next, checkpoint.scope)!
      if (checkpoint.scope && Date.now() >= (record.loopDeadlines[checkpoint.scope.loop] ?? 0)) {
        record = { ...record, updatedAt: new Date().toISOString(), state: { status: 'failed', code: 'loop-timeout',
          nodeId: checkpoint.next, scope: checkpoint.scope, steps: checkpoint.steps } }
        await port.save(record, 'loop-timeout', { scope: checkpoint.scope })
        break
      }
      const configuration = breakpointConfiguration(record)
      const pause = requestedPause(record)
      if (pause) {
        segment?.setAttribute('jevable.pause.reason', 'requested')
        segment?.setAttribute('jevable.pause.request_id', pause.requestId)
        break
      }
      const bypass = advanced === 0 && initialHit && initialHit.nodeId === checkpoint.next && initialHit.stepCount === checkpoint.steps.length
        && isDeepStrictEqual(initialHit.scope, checkpoint.scope)
      if (control?.mode !== 'step' && !bypass && configuration?.breakpoints?.includes(checkpoint.next)) {
        if ((record.breakpointHits?.length ?? 0) >= 10000) throw new WorkflowRuntimeError('limit')
        const hit = { configurationRequestId: configuration.requestId, checkpointSha256: executionCheckpointHash(record),
          nodeId: checkpoint.next, stepCount: checkpoint.steps.length, at: new Date().toISOString(), ...(checkpoint.scope ? { scope: checkpoint.scope } : {}) }
        record = { ...record, updatedAt: hit.at, breakpointHits: [...record.breakpointHits ?? [], hit] }
        await port.save(record, 'breakpoint-hit', hit)
        segment?.setAttribute('jevable.pause.reason', 'breakpoint'); segment?.setAttribute('jevable.breakpoint.node_id', checkpoint.next)
        break
      }
      if (transitions++ >= maxTransitions) throw new WorkflowRuntimeError('limit')
      if (node.plan.kind === 'loop' && record.loopDeadlines[node.id] === undefined) {
        record = { ...record, loopDeadlines: { ...record.loopDeadlines, [node.id]: Date.now() + node.plan.timeoutSeconds * 1000 } }
      }
      const tracedModels: ModelCalls | undefined = models ? {
        admit: node => scope(nodeSpan ?? segment, () => models.admit(node)),
        verify: (...args) => scope(nodeSpan ?? segment, () => models.verify(...args)),
        execute: async (...args) => {
          const span = telemetry?.start('jevable.model', { 'jevable.run.id': record.id, 'jevable.attempt.id': args[2],
            'jevable.node.kind': args[0].kind }, nodeSpan?.spanContext())
          try {
            const trace = savedRunTrace(span)
            const baggage = telemetry?.baggage()
            const result = await scope(span, () => models.execute(args[0], args[1], args[2], args[3], trace ? { trace,
              ...(baggage === undefined ? {} : { baggage }), startTry: identity => {
              const child = telemetry!.start('jevable.model.try', { 'jevable.run.id': record.id, 'jevable.attempt.id': args[2],
                'jevable.node.kind': args[0].kind, 'jevable.model.try.id': identity.id, 'jevable.model.try.number': identity.number,
                'jevable.model.try.phase': identity.number === 1 ? 'initial' : 'retry' }, span!.spanContext())
              const saved = savedRunTrace(child)
              return { ...(saved ? { trace: saved } : {}), withJournalScope: work => scope(child, work), end: result => {
                child.setAttribute('jevable.model.try.dispatched', result.dispatched)
                child.setAttribute('jevable.model.try.settled', result.settled)
                if (result.httpStatus !== undefined) child.setAttribute('http.response.status_code', result.httpStatus)
                telemetry!.end(child, result.outcome, result.outcome !== 'completed')
              } }
            }, startBackoff: identity => {
              const child = telemetry!.start('jevable.model.backoff', { 'jevable.run.id': record.id, 'jevable.attempt.id': args[2],
                'jevable.node.kind': args[0].kind, 'jevable.model.try.id': identity.afterTryId,
                'jevable.model.try.number': identity.afterTryNumber, 'jevable.model.backoff.delay_ms': identity.delayMs }, span!.spanContext())
              return { end: result => telemetry!.end(child, result.outcome, result.outcome !== 'completed') }
            } } : undefined))
            span?.setAttribute('jevable.model.tries', result.usage.tries)
            if (result.usage.inputTokens !== undefined) span?.setAttribute('gen_ai.usage.input_tokens', result.usage.inputTokens)
            if (result.usage.outputTokens !== undefined) span?.setAttribute('gen_ai.usage.output_tokens', result.usage.outputTokens)
            telemetry?.end(span, 'completed'); return result
          } catch (error) { telemetry?.end(span, 'failed', true); throw error }
        } } : undefined
      await advanceDurably(graph, record.input, checkpoint, limits.binding.data, {
        intent: async attempt => {
          record = { ...record, updatedAt: new Date().toISOString(), state: { ...checkpoint, status: 'executing', attempt } }
          await port.save(record, 'node-intent', { attempt, scope: checkpoint.scope ?? null, revision: record.revision })
        },
        tracedIntent: async attempt => {
          record = await port.load(initial.id)
          record = { ...record, state: { ...checkpoint, status: 'executing', attempt } }
          await port.save(record, 'node-trace', { attemptId: attempt.id, trace: attempt.trace })
        },
        span: async id => {
          if (!telemetry) return undefined
          const attempt = (await port.events(record.id)).filter(event => event.kind === 'node-intent'
            && (event.data as { attempt?: { nodeId?: string }; scope?: unknown }).attempt?.nodeId === checkpoint.next
            && isDeepStrictEqual((event.data as { scope?: unknown }).scope, checkpoint.scope ?? null)).length
          nodeSpan = telemetry?.start('jevable.node', { 'jevable.run.id': record.id, 'jevable.attempt.id': id,
            'jevable.attempt.number': attempt, 'jevable.node.id': checkpoint.next, 'jevable.node.kind': node.plan.kind,
            ...(['ifElse', 'switch'].includes(node.plan.kind) ? { 'jevable.rule.settled': false } : {}),
            ...(checkpoint.scope ? { 'jevable.loop.id': checkpoint.scope.loop, 'jevable.loop.index': checkpoint.scope.index } : {}) }, segment?.spanContext())
          return nodeSpan
        },
        result: async next => {
          record = await port.load(initial.id)
          const attempt = record.state.status === 'executing' ? record.state.attempt : undefined
          record = { ...record, updatedAt: new Date().toISOString(), state: next }
          await port.save(record, next.status === 'waiting' ? 'approval-requested' : 'node-result', {
            attemptId: attempt?.id, nodeId: checkpoint.next, scope: checkpoint.scope ?? null, status: next.status,
            ...(next.status === 'waiting' ? { expiresAt: next.expiresAt } : { routes: recordedRoutes(next.steps, checkpoint.steps.length) }),
          })
        },
      }, tracedModels, signal)
      nodeSpan = undefined
      advanced++
    }
    if (record.cancellation) record = await port.finishCancellation(record)
    failed = record.state.status === 'failed'
    return record
  } catch (error) {
    let saved: LocalRun
    try { saved = await port.load(initial.id) }
    catch { throw error } // A lost owner must not obscure the original commit-uncertain/dispatch error.
    if (!saved.cancellation) throw error
    record = await port.finishCancellation(saved); failed = false; return record
  } finally {
    telemetry?.end(segment, failed ? 'failed-or-uncertain' : record.state.status, failed)
  }
}
