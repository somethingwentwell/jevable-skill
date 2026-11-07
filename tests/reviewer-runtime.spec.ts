import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parse, stringify } from 'yaml'
import { LocalRuntime, prepareGrantToken, type ModelCalls, type GrantScope } from '../src/runtime/index.ts'
import { RunStore } from '../src/runtime/store.ts'
import { compileLocalRun } from '../src/runtime/run-evaluator.ts'
import { validateRunTransition } from '../src/runtime/run-transition.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'

const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const loop = await readFile(new URL('../examples/loop-approval.yaml', import.meta.url), 'utf8')
const modelGraph = parse(approval), support = parse(await readFile(new URL('../examples/support.yaml', import.meta.url), 'utf8'))
modelGraph.spec.nodes.draft = support.spec.nodes.draft
modelGraph.spec.nodes.draft.config.prompt = '${{ inputs.message }}'
modelGraph.spec.edges = [{ from: 'start', to: 'review' }, { from: 'review', port: 'approve', to: 'draft' }, { from: 'draft', to: 'result' }]
const approvalModel = stringify(modelGraph)
const at = '2026-10-02T00:00:00.000Z', expiresAt = '2026-10-04T00:00:00.000Z'
const owners: LocalRuntime[] = []
const unsampled = { endpoint: 'http://127.0.0.1:9/v1/traces', authentication: { kind: 'none' as const }, sampleRatio: 0 }
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const owner of owners.splice(0)) await owner.close() })
async function fixture(source = approval, input: any = { message: 'PRIVATE_REVIEW_INPUT' }, models?: ModelCalls,
  telemetry?: Parameters<typeof LocalRuntime.open>[0]['telemetry']) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at)
  const directory = await mkdtemp(join(tmpdir(), 'jevable-reviewer-runtime-')), state = join(directory, 'state')
  const owner = await LocalRuntime.open({ dataDirectory: state, ...(models ? { models } : {}), ...(telemetry ? { telemetry } : {}) }); owners.push(owner)
  const run = await owner.run(source, input)
  if (run.state.status !== 'waiting') throw Error('expected approval wait')
  const scope: Extract<GrantScope, { kind: 'reviewer' }> = { kind: 'reviewer', runId: run.id, attemptId: run.state.attempt.id,
    revision: run.revision, decisions: ['approve', 'reject'] }
  async function issue(decisions = scope.decisions, expiry = expiresAt) {
    const p = prepareGrantToken(randomUUID())
    await owner.issueGrant({ id: p.id, tokenSha256: p.tokenSha256, actor: 'owner:test', expiresAt: expiry, scope: { ...scope, decisions } })
    return p
  }
  return { owner, state, run, scope, issue, prepared: await issue() }
}
const request = (action: 'approve' | 'reject' = 'approve', pauseAfter = true) => ({ requestId: randomUUID(), action, pauseAfter })

describe('standalone SQLite reviewer SDK', () => {
  it('reopens and replays a custom named decision without widening the delegated action set', async () => {
    const custom = approval.replace('actions: [approve, reject]', 'actions: [approve, reject, requestChanges]')
      .replace('    - from: review\n      port: approve\n      to: result',
        '    - from: review\n      port: approve\n      to: result\n    - from: review\n      port: requestChanges\n      to: result')
    const f = await fixture(custom), token = await f.issue(['requestChanges']), selected = { requestId: randomUUID(), action: 'requestChanges', pauseAfter: true }
    await expect(f.owner.decideWithGrant(token.token, { ...selected, action: 'approve' })).rejects.toHaveProperty('code', 'not-found')
    const first = await f.owner.decideWithGrant(token.token, selected)
    expect(first).toMatchObject({ action: 'requestChanges', status: 'paused' })
    const events = await f.owner.events(f.run.id)
    await f.owner.close()
    const reopened = await LocalRuntime.open({ dataDirectory: f.state }); owners.push(reopened)
    expect(await reopened.decideWithGrant(token.token, selected)).toEqual(first)
    expect(await reopened.events(f.run.id)).toEqual(events)
    await expect(reopened.decideWithGrant(token.token, { ...selected, action: 'reject' })).rejects.toHaveProperty('code', 'not-found')
  })
  it('runs trusted propagation only after authentication and freshly checks a receipt after the hook awaits', async () => {
    const f = await fixture(), selected = request(), hook = vi.fn(async (execute: () => Promise<any>) => execute())
    await expect(f.owner.decideWithGrant(prepareGrantToken(randomUUID()).token, selected, hook)).rejects.toHaveProperty('code', 'not-found')
    expect(hook).not.toHaveBeenCalled()
    await f.owner.decideWithGrant(f.prepared.token, selected)
    const events = await f.owner.events(f.run.id)
    await expect(f.owner.decideWithGrant(f.prepared.token, selected, async execute => {
      await f.owner.revokeGrant({ id: f.prepared.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
      return execute()
    })).rejects.toHaveProperty('code', 'not-found')
    expect(await f.owner.events(f.run.id)).toEqual(events)
  })
  it.each(['approve', 'reject'] as const)('atomically retains an unsampled %s decision segment without a pre-decision write', async action => {
    const f = await fixture(approval, undefined, undefined, unsampled), before = await f.owner.show(f.run.id), events = await f.owner.events(f.run.id)
    const selected = request(action), receipt = await f.owner.decideWithGrant(f.prepared.token, selected)
    const after = await f.owner.show(f.run.id), retained = await f.owner.events(f.run.id), event = retained.at(-1)!.data as any
    expect(after.traceSegments).toHaveLength(before.traceSegments!.length + 1)
    expect(retained.slice(events.length).map(e => e.kind)).toEqual(['approval-decided'])
    expect(event.segment).toEqual(after.traceSegments!.at(-1))
    expect(event.segment).toMatchObject({ operation: 'approval', at: receipt.at, trace: { traceFlags: 0 }, previous: before.traceSegments!.at(-1)!.trace })
    expect(await f.owner.decideWithGrant(f.prepared.token, selected)).toEqual(receipt)
    expect(await f.owner.events(f.run.id)).toEqual(retained)
  })
  it.each(['missing-event', 'missing-record', 'trace', 'operation', 'timestamp', 'previous', 'parent', 'order', 'duplicate'] as const)(
    'refuses retained reviewer segment %s corruption on reopen without reconstruction', async kind => {
      const f = await fixture(approval, undefined, undefined, unsampled)
      await f.owner.decideWithGrant(f.prepared.token, request()); await f.owner.close()
      const db = new DatabaseSync(join(f.state, 'runtime.sqlite'))
      try {
        const record = JSON.parse(db.prepare('SELECT record FROM runs WHERE id=?').get(f.run.id)!.record as string)
        const event = JSON.parse(db.prepare("SELECT data FROM events WHERE run_id=? AND kind='approval-decided'").get(f.run.id)!.data as string)
        const segment = record.traceSegments.at(-1)
        if (kind === 'missing-event') delete event.segment
        if (kind === 'missing-record') record.traceSegments.pop()
        if (kind === 'trace') event.segment.trace.spanId = 'c'.repeat(16)
        if (kind === 'operation') { segment.operation = 'resume'; event.segment = structuredClone(segment) }
        if (kind === 'timestamp') { segment.at = expiresAt; event.segment = structuredClone(segment) }
        if (kind === 'previous') { delete segment.previous; event.segment = structuredClone(segment) }
        if (kind === 'parent') { segment.parent = { ...segment.trace, traceId: 'd'.repeat(32) }; event.segment = structuredClone(segment) }
        if (kind === 'order') record.traceSegments.reverse()
        if (kind === 'duplicate') record.traceSegments.push(structuredClone(segment))
        db.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify(record), f.run.id)
        db.prepare("UPDATE events SET data=? WHERE run_id=? AND kind='approval-decided'").run(JSON.stringify(event), f.run.id)
      } finally { db.close() }
      await expect(LocalRuntime.open({ dataDirectory: f.state }).then(owner => { owners.push(owner); return owner })).rejects.toHaveProperty('code', 'corrupt')
    })
  it('rejects unpaired, owner, replaced and oversized reviewer trace appends at the transition guard', async () => {
    const f = await fixture(approval, undefined, undefined, unsampled), before = await f.owner.show(f.run.id)
    await f.owner.decideWithGrant(f.prepared.token, request())
    const next = await f.owner.show(f.run.id), data = (await f.owner.events(f.run.id)).at(-1)!.data as any
    const graph = compileLocalRun(before.yaml, DEFAULT_COMPILER_LIMITS)
    const guard = (record: typeof next, value: unknown, prior = before) => validateRunTransition(prior, record, 'approval-decided', value, graph, DEFAULT_COMPILER_LIMITS)
    guard(next, data)
    const without = structuredClone(data); delete without.segment
    expect(() => guard(next, without)).toThrow('conflict')
    const owner = structuredClone(data); delete owner.decision.delegation
    expect(() => guard(next, owner)).toThrow('conflict')
    const replaced = structuredClone(next), first = replaced.traceSegments![0]!
    first.trace.spanId = 'c'.repeat(16) as typeof first.trace.spanId
    expect(() => guard(replaced, data)).toThrow('conflict')
    const full = { ...before, traceSegments: Array.from({ length: 10000 }, () => before.traceSegments![0]!) }
    expect(() => guard({ ...next, traceSegments: [...full.traceSegments, data.segment] }, data, full)).toThrow('conflict')
  })
  it.each(['approve', 'reject'] as const)('settles %s with atomic derived attribution and metadata-only receipt', async action => {
    const f = await fixture(), selected = request(action), receipt = await f.owner.decideWithGrant(f.prepared.token, selected)
    expect(receipt).toEqual({ schemaVersion: 1, ...selected, runId: f.run.id, attemptId: f.scope.attemptId,
      revision: f.run.revision, at, status: action === 'approve' ? 'paused' : 'failed' })
    const events = await f.owner.events(f.run.id), decision = (events.find(e => e.kind === 'approval-decided')?.data as any).decision
    expect(decision).toEqual({ kind: 'action', action, actor: `grant:${f.prepared.id}`, at,
      delegation: { requestId: selected.requestId, grantId: f.prepared.id, scope: f.scope,
        deadline: '2026-10-03T00:00:00.000Z', pauseAfter: true } })
    const record = await f.owner.show(f.run.id)
    expect(record.state.status === 'failed' ? record.state.inspection?.approval : record.state.steps.find(s => s.nodeId === 'review')?.inspection?.approval).toEqual(decision)
    const publicEvidence = JSON.stringify(await f.owner.exportRun(f.run.id))
    for (const secret of [f.prepared.id, 'PRIVATE_REVIEW_INPUT', 'delegation', f.prepared.token, f.prepared.tokenSha256]) expect(publicEvidence).not.toContain(secret)
    const privateEvidence = JSON.stringify(await f.owner.exportRun(f.run.id, true))
    expect(privateEvidence).toContain(f.prepared.id); expect(privateEvidence).not.toContain(f.prepared.token)
    for (const key of ['yaml', 'input', 'state', 'steps', 'output', 'actor', 'scope', 'grantId', 'token', 'deadline']) expect(receipt).not.toHaveProperty(key)
  })
  it('continues once when requested, but identical receipt retries never resume a paused checkpoint', async () => {
    const f = await fixture(), selected = request(), first = await f.owner.decideWithGrant(f.prepared.token, selected)
    const events = await f.owner.events(f.run.id)
    expect(await f.owner.decideWithGrant(f.prepared.token, selected)).toEqual(first)
    expect(await f.owner.events(f.run.id)).toEqual(events)
    await f.owner.resume(f.run.id)
    expect((await f.owner.decideWithGrant(f.prepared.token, selected)).status).toBe('completed')
    const next = await fixture()
    expect((await next.owner.decideWithGrant(next.prepared.token, request('approve', false))).status).toBe('completed')
  })
  it('refuses changed retries, different grants and fresh requests after settlement', async () => {
    const f = await fixture(), other = await f.issue(), selected = request()
    await f.owner.decideWithGrant(f.prepared.token, selected)
    const events = await f.owner.events(f.run.id)
    await expect(f.owner.decideWithGrant(f.prepared.token, { ...selected, action: 'reject' })).rejects.toHaveProperty('code', 'conflict')
    await expect(f.owner.decideWithGrant(f.prepared.token, { ...selected, pauseAfter: false })).rejects.toHaveProperty('code', 'conflict')
    await expect(f.owner.decideWithGrant(other.token, selected)).rejects.toHaveProperty('code', 'not-found')
    await expect(f.owner.decideWithGrant(f.prepared.token, request())).rejects.toHaveProperty('code', 'not-found')
    expect(await f.owner.events(f.run.id)).toEqual(events)
  })
  it.each(['actor', 'runId', 'attemptId', 'revision', 'scope', 'authorization', 'delegation', 'unknown'])('refuses client %s before reading or mutating a target', async key => {
    const f = await fixture(), get = vi.spyOn(RunStore.prototype, 'get'), selected = request(), events = await f.owner.events(f.run.id)
    get.mockClear()
    await expect(f.owner.decideWithGrant(f.prepared.token, { ...selected, [key]: 'forged' })).rejects.toHaveProperty('code', 'invalid-command')
    expect(get).not.toHaveBeenCalled(); expect(await f.owner.events(f.run.id)).toEqual(events)
  })
  it.each(['malformed', 'owner-token', 'wrong-secret', 'revoked', 'expired', 'disallowed'] as const)('refuses %s before any private run load', async kind => {
    const f = await fixture(), get = vi.spyOn(RunStore.prototype, 'get')
    let token = f.prepared.token
    if (kind === 'malformed') token = 'jvg1.invalid'
    if (kind === 'owner-token') token = 'a'.repeat(64)
    if (kind === 'wrong-secret') token = prepareGrantToken(f.prepared.id).token
    if (kind === 'revoked') await f.owner.revokeGrant({ id: f.prepared.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
    if (kind === 'expired') vi.setSystemTime(expiresAt)
    if (kind === 'disallowed') token = (await f.issue(['reject'])).token
    get.mockClear()
    await expect(f.owner.decideWithGrant(token, request())).rejects.toHaveProperty('code', 'not-found')
    expect(get).not.toHaveBeenCalled()
  })
  it.each(['wait-expired', 'cancelled', 'owner-decided'] as const)('does not replace an actual %s checkpoint with a delegated decision', async kind => {
    const f = await fixture()
    if (kind === 'wait-expired') vi.setSystemTime('2026-10-03T00:00:00.000Z')
    if (kind === 'cancelled') f.owner.cancel(f.run.id, randomUUID(), 'owner:test')
    if (kind === 'owner-decided') await f.owner.decide(f.run.id, f.scope.attemptId, 'approve', 'owner:test', { pauseAfter: true })
    const events = await f.owner.events(f.run.id)
    await expect(f.owner.decideWithGrant(f.prepared.token, request())).rejects.toHaveProperty('code', 'not-found')
    expect(await f.owner.events(f.run.id)).toEqual(events)
  })
  it.each(['revoked', 'expired'] as const)('rechecks %s at writer admission after asynchronous model admission', async kind => {
    let held = false
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    const models: ModelCalls = { admit: vi.fn(async () => { if (held) { entered.resolve(); await gate.promise } }), execute: vi.fn(), verify: vi.fn() }
    const f = await fixture(approvalModel, undefined, models), events = await f.owner.events(f.run.id)
    held = true
    const pending = f.owner.decideWithGrant(f.prepared.token, request()), rejected = expect(pending).rejects.toHaveProperty('code', 'not-found')
    try { await entered.promise
      if (kind === 'revoked') await f.owner.revokeGrant({ id: f.prepared.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
      else vi.setSystemTime(expiresAt)
    } finally { gate.resolve() }
    await rejected; expect(await f.owner.events(f.run.id)).toEqual(events); expect(models.execute).not.toHaveBeenCalled()
  })
  it('rolls back both snapshot and event after an actual late SQLite event failure', async () => {
    const f = await fixture(approval, undefined, undefined, unsampled), selected = request(), before = await f.owner.show(f.run.id), events = await f.owner.events(f.run.id)
    const db = new DatabaseSync(join(f.state, 'runtime.sqlite'))
    try {
      db.exec("CREATE TRIGGER reviewer_event_failure BEFORE INSERT ON events WHEN NEW.kind='approval-decided' BEGIN SELECT RAISE(ABORT,'fixture reviewer event failure'); END")
      await expect(f.owner.decideWithGrant(f.prepared.token, selected)).rejects.toThrow('fixture reviewer event failure')
      expect(await f.owner.show(f.run.id)).toEqual(before); expect(await f.owner.events(f.run.id)).toEqual(events)
    } finally { db.exec('DROP TRIGGER reviewer_event_failure'); db.close() }
    expect((await f.owner.decideWithGrant(f.prepared.token, selected)).status).toBe('paused')
  })
  it('observes one actually committed decision after lost COMMIT acknowledgment and owner reopen', async () => {
    const f = await fixture(approval, undefined, undefined, unsampled), selected = request(), original = DatabaseSync.prototype.exec
    let armed = true
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql: string) {
      original.call(this, sql)
      if (armed && sql === 'COMMIT') { armed = false; throw Error('fixture reviewer lost commit acknowledgment') }
    })
    await expect(f.owner.decideWithGrant(f.prepared.token, selected)).rejects.toThrow('fixture reviewer lost commit acknowledgment')
    const events = await f.owner.events(f.run.id); expect(events.filter(e => e.kind === 'approval-decided')).toHaveLength(1)
    const saved = await f.owner.show(f.run.id)
    expect(saved.traceSegments).toHaveLength(2)
    expect((events.at(-1)!.data as any).segment).toEqual(saved.traceSegments!.at(-1))
    await f.owner.close()
    const reopened = await LocalRuntime.open({ dataDirectory: f.state }); owners.push(reopened)
    expect((await reopened.decideWithGrant(f.prepared.token, selected)).status).toBe('paused')
    expect(await reopened.events(f.run.id)).toEqual(events)
    expect(await reopened.show(f.run.id)).toEqual(saved)
  })
  it('reopens expired and revoked historical decisions without restoring authority or dispatch', async () => {
    const f = await fixture(), selected = request(); await f.owner.decideWithGrant(f.prepared.token, selected)
    const record = await f.owner.show(f.run.id), events = await f.owner.events(f.run.id)
    await f.owner.revokeGrant({ id: f.prepared.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
    await f.owner.close(); vi.setSystemTime(expiresAt)
    const owner = await LocalRuntime.open({ dataDirectory: f.state }); owners.push(owner)
    expect(await owner.show(f.run.id)).toEqual(record); expect(await owner.events(f.run.id)).toEqual(events)
    await expect(owner.decideWithGrant(f.prepared.token, selected)).rejects.toHaveProperty('code', 'not-found')
  })
  it.each(['actor', 'scope', 'request', 'deadline', 'missing-grant', 'event'] as const)('refuses jointly retained %s corruption without repair', async kind => {
    const f = await fixture(); await f.owner.decideWithGrant(f.prepared.token, request())
    await f.owner.close()
    const db = new DatabaseSync(join(f.state, 'runtime.sqlite'))
    try {
      const record = JSON.parse(db.prepare('SELECT record FROM runs WHERE id=?').get(f.run.id)!.record as string)
      const event = JSON.parse(db.prepare("SELECT data FROM events WHERE run_id=? AND kind='approval-decided'").get(f.run.id)!.data as string)
      const decision = record.state.steps.find((s: any) => s.nodeId === 'review').inspection.approval
      if (kind === 'actor') decision.actor = 'owner:forged'
      if (kind === 'scope') decision.delegation.scope.decisions = ['approve']
      if (kind === 'request') decision.delegation.requestId = 'invalid'
      if (kind === 'deadline') decision.delegation.deadline = expiresAt
      event.decision = structuredClone(decision)
      if (kind === 'event') delete event.decision.delegation
      db.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify(record), f.run.id)
      db.prepare("UPDATE events SET data=? WHERE run_id=? AND kind='approval-decided'").run(JSON.stringify(event), f.run.id)
      if (kind === 'missing-grant') { db.prepare('DELETE FROM access_grant_events WHERE grant_id=?').run(f.prepared.id); db.prepare('DELETE FROM access_grants WHERE id=?').run(f.prepared.id) }
    } finally { db.close() }
    await expect(LocalRuntime.open({ dataDirectory: f.state }).then(owner => { owners.push(owner); return owner })).rejects.toHaveProperty('code', 'corrupt')
  })
  it('requires a retained historical wait deadline; owner legacy settlement remains available', async () => {
    const f = await fixture(), db = new DatabaseSync(join(f.state, 'runtime.sqlite'))
    try { const event = JSON.parse(db.prepare("SELECT data FROM events WHERE run_id=? AND kind='approval-requested'").get(f.run.id)!.data as string)
      delete event.expiresAt; db.prepare("UPDATE events SET data=? WHERE run_id=? AND kind='approval-requested'").run(JSON.stringify(event), f.run.id)
    } finally { db.close() }
    await expect(f.owner.decideWithGrant(f.prepared.token, request())).rejects.toHaveProperty('code', 'not-found')
    expect((await f.owner.decide(f.run.id, f.scope.attemptId, 'approve', 'owner:test', { pauseAfter: true })).state.status).toBe('paused')
  })
  it('pins enclosing loop expiry and each attempt; old receipt observation never authorizes another iteration', async () => {
    const source = loop.replace('expiresAfter: 30m', 'expiresAfter: 2h')
    const f = await fixture(source, ['FIRST', 'SECOND']), selected = request('approve', false)
    expect((await f.owner.decideWithGrant(f.prepared.token, selected)).status).toBe('waiting')
    const run = await f.owner.show(f.run.id)
    if (run.state.status !== 'waiting') throw Error('expected second wait')
    expect(run.state.attempt.id).not.toBe(f.scope.attemptId)
    const event = (await f.owner.events(f.run.id)).find(e => e.kind === 'approval-decided')?.data as any
    expect(event.scope).toEqual({ loop: 'each', index: 0 })
    expect(event.decision.delegation.deadline).toBe(new Date(f.run.loopDeadlines.each!).toISOString())
    const events = await f.owner.events(f.run.id)
    expect((await f.owner.decideWithGrant(f.prepared.token, selected)).status).toBe('waiting')
    await expect(f.owner.decideWithGrant(f.prepared.token, request())).rejects.toHaveProperty('code', 'not-found')
    expect(await f.owner.events(f.run.id)).toEqual(events)
    const next = prepareGrantToken(randomUUID())
    await f.owner.issueGrant({ id: next.id, tokenSha256: next.tokenSha256, actor: 'owner:test', expiresAt,
      scope: { ...f.scope, attemptId: run.state.attempt.id } })
    vi.setSystemTime(f.run.loopDeadlines.each!)
    await expect(f.owner.decideWithGrant(next.token, request())).rejects.toHaveProperty('code', 'not-found')
  })
  it('refuses malformed request identities and closed runtime calls without mutation', async () => {
    const f = await fixture()
    for (const value of [{ action: 'approve' }, { ...request(), requestId: 'bad' }, { ...request(), action: 'bad action' }])
      await expect(f.owner.decideWithGrant(f.prepared.token, value as never)).rejects.toHaveProperty('code', 'invalid-command')
    await f.owner.close()
    await expect(f.owner.decideWithGrant('', {} as never)).rejects.toHaveProperty('code', 'closed')
  })
})
