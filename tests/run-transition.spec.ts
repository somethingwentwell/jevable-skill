import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { DEFAULT_COMPILER_LIMITS as limits } from '../src/limits.ts'
import { compileLocalRun, initialCheckpoint, advanceDurably, advanceCheckpoint } from '../src/runtime/run-evaluator.ts'
import { executionCheckpointHash, type LocalRun, type JevableAttemptId } from '../src/runtime/run-types.ts'
import { validateRunTransition as validate, type RunEventKind } from '../src/runtime/run-transition.ts'
import { recordedRoutes } from '../src/runtime/run-routes.ts'

const graph = compileLocalRun(await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8'), limits)
const at = '2026-09-29T00:00:00.000Z'
const fixture = (): LocalRun => ({ schemaVersion: 1, id: randomUUID(), yaml: graph.source.yaml, revision: graph.source.revision,
  input: 'input', createdAt: at, updatedAt: at, state: initialCheckpoint(graph), loopDeadlines: {} })
const guard = (before: LocalRun | undefined, next: LocalRun, kind: RunEventKind, data: unknown) => validate(before, next, kind, data, graph, limits)
async function transition() {
  const before = fixture(); let intent: LocalRun | undefined, result: LocalRun | undefined, payload: unknown
  if (before.state.status !== 'paused') throw Error('Expected pause')
  const checkpoint = before.state
  await advanceDurably(graph, before.input, checkpoint, limits.binding.data, {
    intent: async attempt => {
      intent = { ...before, state: { ...checkpoint, status: 'executing', attempt } }
      payload = { attempt, scope: null, revision: before.revision }; guard(before, intent, 'node-intent', payload)
    },
    span: () => undefined,
    result: async state => { result = { ...before, state } },
  })
  if (!intent || !result || intent.state.status !== 'executing') throw Error('Missing transition')
  const data = { attemptId: intent.state.attempt.id, nodeId: checkpoint.next, scope: null, status: result.state.status,
    routes: recordedRoutes(result.state.steps, checkpoint.steps.length) }
  return { before, intent, result, data, payload }
}

describe('run write transition guards', () => {
  it('admits only the initial checkpoint for creation', () => {
    const run = fixture(); guard(undefined, run, 'run-created', {})
    expect(() => guard(undefined, { ...run, loopDeadlines: { start: 1 } }, 'run-created', {})).toThrow('conflict')
    if (run.state.status !== 'paused') throw Error('Expected pause')
    const state = advanceCheckpoint(graph, run.input, run.state, limits.binding.data)
    expect(() => guard(undefined, { ...run, state }, 'run-created', {})).toThrow('conflict')
  })
  it('requires persisted intent and the matching result event', async () => {
    const f = await transition(); guard(f.intent, f.result, 'node-result', f.data)
    expect(() => guard(f.before, f.result, 'node-result', f.data)).toThrow('conflict')
    expect(() => guard(f.intent, f.result, 'node-result', { ...f.data, attemptId: randomUUID() })).toThrow('conflict')
  })
  it('keeps provenance, input and timestamps stable', async () => {
    const f = await transition()
    for (const patch of [{ input: 'other' }, { id: randomUUID() }, { revision: '0'.repeat(64) }, { updatedAt: '2026-09-28T00:00:00.000Z' }])
      expect(() => guard(f.intent, { ...f.result, ...patch }, 'node-result', f.data)).toThrow('conflict')
  })
  it('requires exact fresh route metadata on new settlements even when both copies omit it', async () => {
    const f = await transition()
    expect(() => guard(f.intent, f.result, 'node-result', { ...f.data, routes: [] })).toThrow('conflict')
    const result = structuredClone(f.result)
    delete result.state.steps[0]!.port
    expect(() => guard(f.intent, result, 'node-result', { ...f.data, routes: [] })).toThrow('conflict')
    expect(() => guard(f.intent, f.result, 'node-result', { ...f.data, routes: [{ stepIndex: 0, nodeId: 'start', port: 'false' }] })).toThrow('conflict')
  })
  it('rejects mismatched retained attempt identity even for replayable deterministic output', async () => {
    const f = await transition(), result = structuredClone(f.result)
    result.state.steps[0]!.inspection!.attemptId = randomUUID() as JevableAttemptId
    expect(() => guard(f.intent, result, 'node-result', f.data)).toThrow('conflict')
  })
  it('binds execution requests to the exact checkpoint and append-only request history', () => {
    const before = fixture(), request = { requestId: randomUUID(), expectedCheckpointSha256: executionCheckpointHash(before), mode: 'step' as const, actor: 'local:user', at }
    const next = { ...before, controlRequests: [request] }; guard(before, next, 'execution-requested', request)
    const bad = { ...request, expectedCheckpointSha256: '0'.repeat(64) }
    expect(() => guard(before, { ...before, controlRequests: [bad] }, 'execution-requested', bad)).toThrow('conflict')
  })
  it('allows pause during an intent but forbids new intent after pause and forbids breakpoint changes on pause', async () => {
    const f = await transition(), request = { requestId: randomUUID(), expectedCheckpointSha256: executionCheckpointHash(f.intent), mode: 'pause' as const, actor: 'local:user', at }
    guard(f.intent, { ...f.intent, controlRequests: [request] }, 'execution-requested', request)
    const invalid = { ...request, breakpoints: [] }
    expect(() => guard(f.intent, { ...f.intent, controlRequests: [invalid] }, 'execution-requested', invalid)).toThrow('conflict')
    const paused = { ...f.before, controlRequests: [{ ...request, expectedCheckpointSha256: executionCheckpointHash(f.before) }] }
    expect(() => guard(paused, { ...f.intent, controlRequests: paused.controlRequests }, 'node-intent', f.payload)).toThrow('conflict')
    guard({ ...f.intent, controlRequests: [request] }, { ...f.result, controlRequests: [request] }, 'node-result', f.data)
  })

  it('guards breakpoint-hit appends against configuration, checkpoint and scope', () => {
    const run = fixture(), request = { requestId: randomUUID(), expectedCheckpointSha256: executionCheckpointHash(run),
      mode: 'continue' as const, breakpoints: ['start'], actor: 'local:user', at }
    const before = { ...run, controlRequests: [request] }
    guard(run, before, 'execution-requested', request)
    const hit = { configurationRequestId: request.requestId, checkpointSha256: executionCheckpointHash(before),
      nodeId: graph.nodes[0]!.id, stepCount: 0, at }
    guard(before, { ...before, breakpointHits: [hit] }, 'breakpoint-hit', hit)
    for (const changed of [{ ...hit, configurationRequestId: randomUUID() }, { ...hit, stepCount: 1 },
      { ...hit, checkpointSha256: 'a'.repeat(64) }, { ...hit, scope: { loop: hit.nodeId, index: 0 } }]) {
      expect(() => guard(before, { ...before, breakpointHits: [changed] }, 'breakpoint-hit', changed)).toThrow('conflict')
    }
    const invalid = { ...request, breakpoints: ['not-in-graph'] }
    expect(() => guard(run, { ...run, controlRequests: [invalid] }, 'execution-requested', invalid)).toThrow('conflict')
  })
  it('rejects fabricated trace linkage on an otherwise valid result', async () => {
    const f = await transition(), result = structuredClone(f.result)
    result.state.steps[0]!.inspection!.trace = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 } as NonNullable<typeof result.state.steps[0]['inspection']>['trace']
    expect(() => guard(f.intent, result, 'node-result', f.data)).toThrow('conflict')
  })
  it('refuses new execution after cancellation intent', async () => {
    const f = await transition(), cancellation = { id: randomUUID(), actor: 'local:user', at }
    guard(f.before, { ...f.before, cancellation }, 'cancellation-requested', cancellation)
    expect(() => guard({ ...f.before, cancellation }, { ...f.intent, cancellation }, 'node-intent', f.payload)).toThrow('conflict')
  })
  it('never rewrites a terminal checkpoint', async () => {
    const f = await transition(), terminal: LocalRun = { ...f.result, state: { status: 'completed', steps: [], output: 'input' } }
    expect(() => guard(terminal, terminal, 'node-result', f.data)).toThrow('conflict')
  })
})
