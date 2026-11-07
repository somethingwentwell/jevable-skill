import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import { parse } from 'yaml'
import { LocalRuntime, executionCheckpointHash, createApprovalInbox } from '../src/runtime/index.ts'
import { runReceipt } from '../src/runtime/receipts.ts'
import { localRunSchema, stoppedCheckpointHash, type LocalRun } from '../src/runtime/run-types.ts'
import { compileLocalRun } from '../src/runtime/run-evaluator.ts'
import { validateRunTransition } from '../src/runtime/run-transition.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { RunStore } from '../src/runtime/store.ts'
import { RetainedRunMetrics } from '../src/runtime/retained-metrics.ts'
import { notificationWaitExpired, approvalLifecycleNotification } from '../src/notifications/schema.ts'
import { createPreview, projectPreviewExecution } from '../src/preview/index.ts'
import { PreviewSession } from '../src/preview/session.ts'
import { dispatchOperation } from '../src/http/operations.ts'

const yaml = await readFile(new URL('../examples/loop-approval.yaml', import.meta.url), 'utf8')
const owners = new Set<LocalRuntime>()
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const owner of owners) await owner.close(); owners.clear() })
async function fixture() {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-loop-approval-'))
  const owner = await LocalRuntime.open({ dataDirectory }); owners.add(owner)
  return { owner, dataDirectory }
}
function waiting(run: LocalRun) { if (run.state.status !== 'waiting') throw Error('Expected approval'); return run.state }
async function inbox(owner: LocalRuntime) { return createApprovalInbox({ listRuns: page => owner.listPage(page.after, page.limit), showRun: id => owner.show(id) }) }
const notification = (run: LocalRun, events: Awaited<ReturnType<LocalRuntime['events']>>, kind: 'requested' | 'decided' | 'expired' | 'cancelled' = 'requested', attemptId = waiting(run).attempt.id) =>
  approvalLifecycleNotification(run, events, { runId: run.id, revision: run.revision, attemptId, eventKind: kind })

describe('durable approval tasks inside bounded loops', () => {
  it('reviews each frozen item once, reopens scope and preserves guarded continuation and metadata-only evidence', async () => {
    const f = await fixture(); let owner = f.owner
    const first = await owner.run(yaml, ['PRIVATE_FIRST', 'PRIVATE_SECOND'])
    expect(waiting(first)).toMatchObject({ next: 'review', scope: { loop: 'each', index: 0 }, attempt: { prepared: { input: { input: 'PRIVATE_FIRST' } } } })
    const initialEvents = await owner.events(first.id), requested = notification(first, initialEvents)
    expect(requested.data).toMatchObject({ scope: { loop: 'each', index: 0 }, loopExpiresAt: new Date(first.loopDeadlines.each!).toISOString() })
    expect((await inbox(owner)).tasks[0]).toMatchObject({ scope: { loop: 'each', index: 0 }, loopExpiry: 'not-expired-at-observation' })
    await owner.close(); owner = await LocalRuntime.open({ dataDirectory: f.dataDirectory }); owners.add(owner)
    expect(await owner.show(first.id)).toEqual(first)
    const paused = await owner.decide(first.id, waiting(first).attempt.id, 'approve', 'PRIVATE_REVIEWER', { pauseAfter: true })
    expect(paused.state).toMatchObject({ status: 'paused', next: 'review', scope: { loop: 'each', index: 1 } })
    const command = { requestId: randomUUID(), mode: 'continue' as const, expectedCheckpointSha256: executionCheckpointHash(paused) }
    const second = await owner.advance(first.id, command, 'PRIVATE_OPERATOR')
    expect(waiting(second)).toMatchObject({ scope: { loop: 'each', index: 1 }, attempt: { prepared: { input: { input: 'PRIVATE_SECOND' } } } })
    expect(waiting(second).attempt.id).not.toBe(waiting(first).attempt.id)
    expect(await owner.advance(first.id, command, 'PRIVATE_OPERATOR')).toEqual(second)
    await expect(owner.decide(first.id, waiting(first).attempt.id, 'approve', 'PRIVATE_REVIEWER')).rejects.toHaveProperty('code', 'conflict')
    const decided = notification(second, await owner.events(first.id), 'decided', waiting(first).attempt.id)
    expect(decided.data).toEqual(requested.data)
    const done = await owner.decide(first.id, waiting(second).attempt.id, 'reject', 'PRIVATE_REVIEWER')
    expect(done.state).toMatchObject({ status: 'completed', output: { count: 2, results: [{ item: 'PRIVATE_FIRST', action: 'approve' }, { item: 'PRIVATE_SECOND', action: 'reject' }] } })
    const evidence = await owner.exportRun(first.id)
    expect(evidence.snapshot.journal.filter(e => e.kind === 'approval-decided').map(e => 'scope' in e ? e.scope : undefined)).toEqual([{ loop: 'each', index: 0 }, { loop: 'each', index: 1 }])
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE_')
    await owner.close(); owner = await LocalRuntime.open({ dataDirectory: f.dataDirectory }); owners.add(owner)
    expect(await owner.show(first.id)).toEqual(done); expect(await owner.exportRun(first.id)).toEqual(evidence)
  })

  it.each(['reject', 'expired'] as const)('retains iteration scope on terminal %s without completing the next item', async kind => {
    const { owner } = await fixture()
    const source = kind === 'reject' ? yaml.replace('onReject: branch', 'onReject: cancelled').replace(/            - from: review\n              port: reject\n              result:.*\n/u, '') : yaml.replace('30m', '1s')
    const run = await owner.run(source, ['PRIVATE_ITEM', 'PRIVATE_NEXT'])
    if (kind === 'expired') { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(waiting(run).expiresAt) + 1) }
    const result = await owner.decide(run.id, waiting(run).attempt.id, kind === 'reject' ? 'reject' : 'approve', 'PRIVATE_ACTOR')
    expect(result.state).toMatchObject({ status: 'failed', code: kind === 'reject' ? 'approval-rejected' : 'approval-expired', scope: { loop: 'each', index: 0 } })
    expect(await owner.show(run.id)).toEqual(result)
    expect((await owner.events(run.id)).filter(e => e.kind === 'approval-requested')).toHaveLength(1)
    expect(notification(result, await owner.events(run.id), kind === 'expired' ? 'expired' : 'decided', waiting(run).attempt.id).data.scope).toEqual(waiting(run).scope)
  })

  it('branches approval expiry inside an iteration when the enclosing loop is still within its deadline', async () => {
    const { owner } = await fixture(), source = yaml.replace('30m', '1s').replace('onTimeout: expired', 'onTimeout: branch')
      .replace('          exits:\n', '          exits:\n            - { from: review, port: timeout, result: { item: "${{ loop.item }}", action: "${{ nodes.review.output.action }}" } }\n')
    const run = await owner.run(source, ['PRIVATE_ITEM'])
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(waiting(run).expiresAt) + 1)
    const result = await owner.decide(run.id, waiting(run).attempt.id, 'approve', 'PRIVATE_ACTOR')
    expect(result.state).toMatchObject({ status: 'completed', output: { count: 1, results: [{ item: 'PRIVATE_ITEM', action: 'timeout' }] } })
    expect(await owner.show(run.id)).toEqual(result)
  })

  it('includes review downtime in loop timeout, refuses notification admission and records no synthetic decision', async () => {
    const { owner } = await fixture(), run = await owner.run(yaml.replace('timeoutSeconds: 3600', 'timeoutSeconds: 1'), ['PRIVATE_ITEM'])
    const events = await owner.events(run.id), requested = notification(run, events)
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(run.loopDeadlines.each! + 1)
    expect(notificationWaitExpired(requested)).toBe(true)
    const page = await inbox(owner)
    expect(page.tasks[0]).toMatchObject({ expiry: 'not-expired-at-observation', loopExpiry: 'expired-at-observation' })
    expect(await owner.events(run.id)).toEqual(events)
    const result = await owner.decide(run.id, waiting(run).attempt.id, 'approve', 'PRIVATE_ACTOR', { pauseAfter: true })
    expect(result.state).toMatchObject({ status: 'failed', code: 'loop-timeout', scope: { loop: 'each', index: 0 } })
    expect(await owner.show(run.id)).toEqual(result)
    const after = await owner.events(run.id)
    expect(after.filter(e => e.kind === 'approval-decided')).toEqual([])
    expect(after.at(-1)).toMatchObject({ kind: 'loop-timeout', data: { scope: waiting(run).scope, attemptId: waiting(run).attempt.id, nodeId: 'review' } })
    expect(() => notification(result, after, 'expired', waiting(run).attempt.id)).toThrow('conflict')
    expect((await owner.exportRun(run.id)).snapshot.journal.at(-1)).toMatchObject({ kind: 'loop-timeout', scope: waiting(run).scope, attemptId: waiting(run).attempt.id })
  })

  it('cancels a waiting iteration exactly and preserves cancelled notification joins and checkpoint hash across restart', async () => {
    const f = await fixture(), run = await f.owner.run(yaml, ['PRIVATE_ITEM']), hash = stoppedCheckpointHash(run.state)
    const cancelled = f.owner.cancel(run.id, randomUUID(), 'PRIVATE_ACTOR')
    expect(cancelled.state).toMatchObject({ status: 'cancelled', previousStatus: 'waiting', scope: waiting(run).scope, attempt: waiting(run).attempt })
    expect(stoppedCheckpointHash(cancelled.state)).toBe(hash)
    expect(notification(cancelled, await f.owner.events(run.id), 'cancelled', waiting(run).attempt.id).data.scope).toEqual(waiting(run).scope)
    await f.owner.close(); const owner = await LocalRuntime.open({ dataDirectory: f.dataDirectory }); owners.add(owner)
    expect(await owner.show(run.id)).toEqual(cancelled)
    await expect(owner.decide(run.id, waiting(run).attempt.id, 'approve', 'PRIVATE_ACTOR')).rejects.toHaveProperty('code', 'conflict')
  })

  it.each([undefined, { loop: 'each', index: 1 }, { loop: 'start', index: 0 }])('rejects missing or forged wait scope %j during replay', async scope => {
    const f = await fixture(), run = await f.owner.run(yaml, ['PRIVATE_ITEM', 'PRIVATE_NEXT']), original = RunStore.prototype.get
    vi.spyOn(RunStore.prototype, 'get').mockImplementation(function (this: RunStore, id) {
      const saved = original.call(this, id)
      if (saved?.id !== run.id || saved.state.status !== 'waiting') return saved
      return { ...saved, state: { ...saved.state, scope } } as LocalRun
    })
    await expect(f.owner.show(run.id)).rejects.toHaveProperty('code', 'corrupt')
  })

  it('guards scope on approval request and settlement writes independently of replayable values', async () => {
    const { owner } = await fixture(), run = await owner.run(yaml, ['PRIVATE_ITEM'])
    const state = waiting(run), before = { ...run, state: { ...state, status: 'executing' as const } }
    const data = { attemptId: state.attempt.id, nodeId: state.next, scope: state.scope, status: 'waiting', expiresAt: state.expiresAt }
    const graph = compileLocalRun(yaml, DEFAULT_COMPILER_LIMITS)
    validateRunTransition(before, run, 'approval-requested', data, graph, DEFAULT_COMPILER_LIMITS)
    expect(() => validateRunTransition(before, { ...run, state: { ...state, scope: undefined } }, 'approval-requested', data, graph, DEFAULT_COMPILER_LIMITS)).toThrow('conflict')
    const result = await owner.decide(run.id, state.attempt.id, 'approve', 'PRIVATE_ACTOR', { pauseAfter: true })
    const event = (await owner.events(run.id)).find(e => e.kind === 'approval-decided')!
    validateRunTransition(run, result, 'approval-decided', event.data, graph, DEFAULT_COMPILER_LIMITS)
    const wrong = { ...event.data as Record<string, unknown>, scope: { loop: 'each', index: 1 } }
    expect(() => validateRunTransition(run, result, 'approval-decided', wrong, graph, DEFAULT_COMPILER_LIMITS)).toThrow('conflict')
  })

  it('samples an elapsed loop approval as expired without mutating the saved wait', async () => {
    const { owner } = await fixture(), run = await owner.run(yaml, ['PRIVATE_ITEM']), metrics = new RetainedRunMetrics(10)
    metrics.restore(run, await owner.events(run.id)); metrics.ready()
    expect(metrics.snapshot(run.loopDeadlines.each! + 1)).toMatchObject({ available: true, runs: { waiting: 1 }, approvals: { expired: { count: 1 }, awaiting: { count: 0 } } })
    expect((await owner.show(run.id)).state.status).toBe('waiting')
  })

  it('refuses a new requested notification after the loop deadline, before creating a send intent', async () => {
    const f = await fixture(); await f.owner.close()
    const owner = await LocalRuntime.open({ dataDirectory: f.dataDirectory, notifications: { endpoints: [{ id: 'review', url: 'http://127.0.0.1:9/events', credentialRef: 'review/key', timeoutMs: 100 }] } }); owners.add(owner)
    owner.setCredential('review/key', 'whsec_' + randomBytes(32).toString('base64'), 0, 'fixture')
    const run = await owner.run(yaml.replace('timeoutSeconds: 3600', 'timeoutSeconds: 1'), ['PRIVATE_ITEM'])
    const prepared = await owner.prepareApprovalNotification({ runId: run.id, revision: run.revision, attemptId: waiting(run).attempt.id }, 'review')
    const { event: _event, delivery: _delivery, ...pins } = prepared
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(run.loopDeadlines.each! + 1)
    await expect(owner.sendApprovalNotification({ ...pins, requestId: randomUUID() }, 'fixture')).rejects.toHaveProperty('code', 'conflict')
    expect((await owner.listApprovalNotifications({})).deliveries).toEqual([])
    expect((await owner.show(run.id)).state.status).toBe('waiting')
  })

  it.each(['complete', 'limit'] as const)('executes explicit approval in Repeat Until through %s without resetting iteration identity', async outcome => {
    const document = parse(yaml) as { spec: { inputSchema: unknown; nodes: { each: { config: Record<string, unknown> } } } }
    document.spec.inputSchema = { type: 'string' }
    const loop = document.spec.nodes.each.config
    delete loop.items; loop.mode = 'repeatUntil'; loop.input = '${{ inputs }}'; loop.until = outcome === 'complete' ? '${{ loop.index >= 1 }}' : '${{ false }}'; loop.onLimit = 'fail'; loop.maxIterations = 2
    const { owner } = await fixture(), first = await owner.run(JSON.stringify(document), 'PRIVATE_ITEM')
    const second = await owner.decide(first.id, waiting(first).attempt.id, 'approve', 'fixture')
    expect(waiting(second).scope?.index).toBe(1)
    const result = await owner.decide(first.id, waiting(second).attempt.id, 'approve', 'fixture')
    expect(result.state).toMatchObject(outcome === 'complete' ? { status: 'completed', output: { count: 2 } } : { status: 'failed', code: 'loop-limit' })
    expect(await owner.show(first.id)).toEqual(result)
  })

  it.each(['approval-requested', 'approval-decided'] as const)('retains the exact scoped predecessor when %s commit fails, with no invented settlement', async kind => {
    const { owner } = await fixture(), save = RunStore.prototype.save
    const spy = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function(this: RunStore, record, event, data) {
      if (event === kind) throw Error('fixture write failure')
      return save.call(this, record, event, data)
    })
    const id = randomUUID()
    if (kind === 'approval-requested') await expect(owner.run(yaml, ['PRIVATE_ITEM'], { id })).rejects.toThrow('fixture write failure')
    else {
      const run = await owner.run(yaml, ['PRIVATE_ITEM'], { id })
      await expect(owner.decide(id, waiting(run).attempt.id, 'approve', 'fixture')).rejects.toThrow('fixture write failure')
    }
    spy.mockRestore()
    const retained = await owner.show(id)
    expect(retained.state).toMatchObject({ status: kind === 'approval-requested' ? 'executing' : 'waiting', scope: { loop: 'each', index: 0 } })
    expect((await owner.events(id)).some(event => event.kind === kind)).toBe(false)
    await expect(owner.resume(id)).rejects.toHaveProperty('code', 'conflict')
  })

  it('supports project-scoped preview review actions and metadata overlay for each iteration without browser qualification', async () => {
    const { owner } = await fixture(), session = await PreviewSession.create({ call: command => dispatchOperation({ storage: 'sqlite', runtime: owner }, command, 'fixture:host') }, yaml)
    const id = randomUUID(), run = await session.operation({ operation: 'run', id, input: ['PRIVATE_FIRST', 'PRIVATE_SECOND'] }) as ReturnType<typeof runReceipt>
    const review = await session.operation({ operation: 'approval', id }) as { actions: string[]; scope: unknown; attemptId: string }
    expect(review.actions).toEqual(['approve', 'reject']); expect(review.scope).toEqual({ loop: 'each', index: 0 })
    const overlay = projectPreviewExecution(createPreview(yaml), run)
    expect(overlay.graphs[1]!.nodes.find(n => n.id === 'review')).toMatchObject({ status: 'waiting' })
    await session.operation({ operation: 'decide', id, attemptId: review.attemptId, action: 'approve' })
    expect((await session.operation({ operation: 'approval', id }) as { scope: unknown }).scope).toEqual({ loop: 'each', index: 1 })
  })

  it('keeps old unscoped waiting serialization and checkpoint hash stable with absent optional fields', async () => {
    const { owner } = await fixture(), source = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8'), run = await owner.run(source, { message: 'private' })
    const old = JSON.stringify(run.state)
    expect(JSON.stringify(localRunSchema.parse(run).state)).toBe(old)
    expect(run.state).not.toHaveProperty('scope')
    expect(notification(run, await owner.events(run.id)).data).not.toHaveProperty('scope')
    expect(notification(run, await owner.events(run.id)).data).not.toHaveProperty('loopExpiresAt')
  })

  it('re-arms a scoped body breakpoint at each iteration while preserving explicit approvals and restart replay', async () => {
    const f = await fixture(), command = (run: LocalRun, breakpoints?: string[]) => ({ requestId: randomUUID(), mode: 'continue' as const,
      expectedCheckpointSha256: executionCheckpointHash(run), ...(breakpoints ? { breakpoints } : {}) })
    const start = await f.owner.run(yaml, ['PRIVATE_FIRST', 'PRIVATE_SECOND'], { paused: true })
    const firstHit = await f.owner.advance(start.id, command(start, ['review']), 'fixture')
    expect(firstHit.state).toMatchObject({ status: 'paused', scope: { loop: 'each', index: 0 } })
    const first = await f.owner.advance(start.id, command(firstHit), 'fixture')
    const nextHit = await f.owner.decide(start.id, waiting(first).attempt.id, 'approve', 'fixture')
    expect(nextHit.state).toMatchObject({ status: 'paused', scope: { loop: 'each', index: 1 } })
    expect(nextHit.breakpointHits?.map(hit => hit.scope?.index)).toEqual([0, 1])
    await f.owner.close(); const owner = await LocalRuntime.open({ dataDirectory: f.dataDirectory }); owners.add(owner)
    expect(await owner.show(start.id)).toEqual(nextHit)
    const second = await owner.advance(start.id, command(nextHit), 'fixture')
    const done = await owner.decide(start.id, waiting(second).attempt.id, 'approve', 'fixture')
    expect(done.state.status).toBe('completed'); expect(await owner.show(start.id)).toEqual(done)
    expect((await owner.events(start.id)).filter(e => e.kind === 'approval-requested')).toHaveLength(2)
  })

  it('assesses an accepted saved case from an iteration wait without claiming workflow completion', async () => {
    const { owner } = await fixture(), project = owner.editProject({ operation: 'create', title: 'PRIVATE_PROJECT', yaml, actor: 'fixture' })
    const draft = owner.editTest({ operation: 'create', actor: 'fixture', definition: { title: 'PRIVATE_TEST', project: { id: project.id, generation: 1, revision: project.acceptedRevision },
      input: ['PRIVATE_ITEM'], expectations: [{ kind: 'status', value: 'waiting' }] } })
    const accepted = owner.editTest({ operation: 'accept', id: draft.id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256, actor: 'fixture' })
    const result = await owner.runTest({ id: accepted.id, generation: accepted.generation, sha256: accepted.sha256 }, randomUUID())
    expect(result).toMatchObject({ assessment: 'passed', terminal: false })
    const run = await owner.show(result.run.id)
    expect(waiting(run).scope).toEqual({ loop: 'each', index: 0 })
    expect(await owner.events(run.id)).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'approval-decided' })]))
  })
})
