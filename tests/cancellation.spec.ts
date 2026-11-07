import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime, type ModelCalls } from '../src/runtime/index.ts'
import { runReceipt } from '../src/runtime/receipts.ts'
import { main } from '../src/cli.ts'
import { setImmediate as tick } from 'node:timers/promises'
import { listTemplates, renderTemplate } from '../src/templates/index.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const approvalInput = { message: 'review input' }
const model = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'cancel', name: 'Cancel fixture' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false },
      execution: { timeoutSeconds: 60, maxAttempts: 1 }, historyScope: 'none' } },
    end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } },
  edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
const owners: LocalRuntime[] = []
afterEach(async () => { for (const owner of owners.splice(0)) await owner.close() })
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function fixture(models?: ModelCalls) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-cancel-'))
  const runtime = await LocalRuntime.open({ dataDirectory: directory, ...(models ? { models } : {}) }); owners.push(runtime)
  return { runtime, directory }
}
async function reopen(directory: string, models?: ModelCalls) {
  const runtime = await LocalRuntime.open({ dataDirectory: directory, ...(models ? { models } : {}) }); owners.push(runtime); return runtime
}

describe('durable explicit cancellation', () => {
  it('stops at a scoped loop checkpoint and verifies that exact checkpoint after restart', async () => {
    const { runtime, directory } = await fixture(), id = randomUUID()
    const source = JSON.stringify(renderTemplate('expense-check')), input = listTemplates().find(item => item.id === 'expense-check')!.sample
    const running = runtime.run(source, input, { id })
    let scoped = false
    for (let index = 0; index < 100; index++) {
      const state = (await runtime.show(id)).state
      if ('scope' in state && state.scope) { scoped = true; runtime.cancel(id, randomUUID(), 'local:owner'); break }
      if (state.status === 'completed' || state.status === 'waiting' || state.status === 'failed') break
      await tick()
    }
    const stopped = await running
    expect(scoped).toBe(true); expect(stopped.state).toMatchObject({ status: 'cancelled', scope: expect.any(Object) })
    await runtime.close(); const owner = await reopen(directory)
    expect(await owner.show(id)).toEqual(stopped)
  })

  it('yields before dispatch so an immediate request stops deterministic execution', async () => {
    const { runtime } = await fixture(), id = randomUUID(), request = randomUUID()
    const running = runtime.run(echo, 'private input', { id })
    const requested = runtime.cancel(id, request, 'local:owner')
    expect(runReceipt(requested).cancellation?.status).toBe('requested')
    const result = await running
    expect(result.state).toMatchObject({ status: 'cancelled', previousStatus: 'paused', steps: [] })
    expect((await runtime.events(id)).some(event => event.kind === 'node-intent')).toBe(false)
    expect(JSON.stringify(runReceipt(result))).not.toContain('private input')
    expect(runtime.cancel(id, request, 'local:retry')).toEqual(result)
  })

  it('cancels an approval wait without a decision, survives restart and refuses continuation', async () => {
    const { runtime, directory } = await fixture(), waiting = await runtime.run(approval, approvalInput), request = randomUUID()
    expect(waiting.state.status).toBe('waiting')
    const stopped = runtime.cancel(waiting.id, request, 'local:owner')
    expect(stopped.state).toMatchObject({ status: 'cancelled', previousStatus: 'waiting', steps: waiting.state.steps })
    expect((await runtime.events(waiting.id)).some(event => event.kind === 'approval-decided')).toBe(false)
    await runtime.close(); const owner = await reopen(directory)
    expect(await owner.show(waiting.id)).toEqual(stopped)
    expect(owner.cancel(waiting.id, request, 'local:retry')).toEqual(stopped)
    expect(() => owner.cancel(waiting.id, randomUUID(), 'local:owner')).toThrow('conflict')
    await expect(owner.resume(waiting.id)).rejects.toMatchObject({ code: 'conflict' })
    await expect(owner.decide(waiting.id, randomUUID(), 'approve', 'local:owner')).rejects.toMatchObject({ code: 'conflict' })
    expect(await owner.run(approval, approvalInput, { id: waiting.id })).toEqual(stopped)
  })

  it('signals a cooperative adapter only after request persistence and retains unsettled attempt evidence', async () => {
    const entered = gate(); let dispatches = 0, persisted = false
    let runtime!: LocalRuntime, directory!: string
    const models: ModelCalls = { admit() {}, async verify() {}, async execute(_node, _input, _attempt, signal) {
      dispatches++; entered.resolve()
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => {
        const db = new DatabaseSync(join(directory, 'runtime.sqlite'))
        const row = db.prepare("SELECT count(*) AS count FROM events WHERE kind='cancellation-requested'").get()
        persisted = row?.count === 1; db.close()
        reject(new Error('provider private error'))
      }, { once: true }))
      throw new Error('unreachable')
    } }
    const f = await fixture(models); runtime = f.runtime; directory = f.directory
    const id = randomUUID(), request = randomUUID(), running = runtime.run(model, 'private prompt', { id })
    await entered.promise
    const pending = runtime.cancel(id, request, 'local:owner')
    expect(pending.state.status).toBe('executing')
    expect(pending.cancellation?.id).toBe(request)
    const stopped = await running
    expect(persisted).toBe(true); expect(dispatches).toBe(1)
    expect(stopped.state).toMatchObject({ status: 'cancelled', previousStatus: 'executing', next: 'write' })
    expect(runReceipt(stopped).recovery).toContain('does not prove')
    expect((await runtime.events(id)).filter(event => event.kind === 'cancellation-requested')).toHaveLength(1)
    await runtime.close(); const owner = await reopen(f.directory, models)
    expect(await owner.run(model, 'private prompt', { id })).toEqual(stopped)
    expect(dispatches).toBe(1)
  })

  it('waits for an adapter ignoring abort, preserves its settled result and stops before the next node', async () => {
    const entered = gate(), release = gate()
    const models: ModelCalls = { admit() {}, async verify() {}, async execute() {
      entered.resolve(); await release.promise; return { output: 'settled output', usage: { tries: 1 } }
    } }
    const { runtime } = await fixture(models), id = randomUUID(), running = runtime.run(model, 'input', { id })
    await entered.promise
    runtime.cancel(id, randomUUID(), 'local:owner')
    expect(runReceipt(await runtime.show(id)).cancellation?.status).toBe('requested')
    await expect(runtime.close()).rejects.toMatchObject({ code: 'busy' })
    release.resolve(); const stopped = await running
    expect(stopped.state).toMatchObject({ status: 'cancelled', previousStatus: 'paused', next: 'end' })
    expect(stopped.state.steps.at(-1)).toMatchObject({ nodeId: 'write', output: 'settled output' })
    expect((await runtime.events(id)).filter(event => event.kind === 'node-intent')).toHaveLength(2)
  })

  it('does not lose cancellation while an approval operation awaits historical model verification', async () => {
    const entered = gate(), release = gate(); let block = false
    const models: ModelCalls = { admit() {}, async execute() { return { output: 'review me', usage: { tries: 1 } } },
      async verify() { if (block) { entered.resolve(); await release.promise } } }
    const document = JSON.parse(model)
    document.spec.nodes.review = { type: 'humanApproval', config: { title: 'Review', input: '${{ nodes.write.output }}',
      inputSchema: { type: 'string' }, actions: ['approve', 'reject'], expiresAfter: '1h', onReject: 'cancelled', onTimeout: 'expired' } }
    document.spec.edges = [{ from: 'start', to: 'write' }, { from: 'write', to: 'review' }, { from: 'review', to: 'end', port: 'approve' }]
    const { runtime } = await fixture(models), waiting = await runtime.run(JSON.stringify(document), 'input')
    if (waiting.state.status !== 'waiting') throw Error('Expected approval')
    block = true
    const deciding = runtime.decide(waiting.id, waiting.state.attempt.id, 'approve', 'local:reviewer')
    await entered.promise
    runtime.cancel(waiting.id, randomUUID(), 'local:owner')
    release.resolve()
    expect((await deciding).state.status).toBe('cancelled')
    expect((await runtime.events(waiting.id)).some(event => event.kind === 'approval-decided')).toBe(false)
  })

  it('does not signal or stop when the request transaction fails', async () => {
    const entered = gate(), release = gate(); let aborted = false
    const models: ModelCalls = { admit() {}, async verify() {}, async execute(_n, _i, _a, signal) {
      signal!.addEventListener('abort', () => { aborted = true }); entered.resolve(); await release.promise
      return { output: 'done', usage: { tries: 1 } }
    } }
    const { runtime, directory } = await fixture(models), id = randomUUID(), running = runtime.run(model, 'input', { id })
    await entered.promise
    const db = new DatabaseSync(join(directory, 'runtime.sqlite'))
    db.exec("CREATE TRIGGER refuse_cancel BEFORE INSERT ON events WHEN NEW.kind='cancellation-requested' BEGIN SELECT RAISE(ABORT,'fixture'); END;")
    expect(() => runtime.cancel(id, randomUUID(), 'local:owner')).toThrow()
    expect((await runtime.show(id)).cancellation).toBeUndefined(); expect(aborted).toBe(false)
    db.exec('DROP TRIGGER refuse_cancel'); db.close(); release.resolve()
    expect((await running).state.status).toBe('completed')
  })

  it('retains a pending request after stop-commit failure; reopen is read-only and explicit retry finishes it', async () => {
    const { runtime, directory } = await fixture(), waiting = await runtime.run(approval, approvalInput), id = randomUUID()
    const db = new DatabaseSync(join(directory, 'runtime.sqlite'))
    db.exec("CREATE TRIGGER refuse_stop BEFORE INSERT ON events WHEN NEW.kind='run-cancelled' BEGIN SELECT RAISE(ABORT,'fixture'); END;")
    expect(() => runtime.cancel(waiting.id, id, 'local:owner')).toThrow()
    expect((await runtime.show(waiting.id)).state.status).toBe('waiting')
    db.exec('DROP TRIGGER refuse_stop'); db.close(); await runtime.close()
    const owner = await reopen(directory), retained = await owner.show(waiting.id)
    expect(retained.state.status).toBe('waiting'); expect(retained.cancellation?.id).toBe(id)
    expect(owner.cancel(waiting.id, id, 'local:retry').state.status).toBe('cancelled')
  })

  it('can stop an orphaned uncertain attempt without redispatch or claiming external rollback', async () => {
    let calls = 0
    const models: ModelCalls = { admit() {}, async verify() {}, async execute() { calls++; throw new Error('lost response') } }
    const { runtime } = await fixture(models), id = randomUUID()
    await expect(runtime.run(model, 'input', { id })).rejects.toThrow('lost response')
    expect(runtime.cancel(id, randomUUID(), 'local:owner').state).toMatchObject({ status: 'cancelled', previousStatus: 'executing' })
    expect(calls).toBe(1)
  })

  it('rejects completed targets and invalid request identities without changing evidence', async () => {
    const { runtime } = await fixture(), run = await runtime.run(echo, 'input')
    const before = await runtime.events(run.id)
    expect(() => runtime.cancel(run.id, randomUUID(), 'local:owner')).toThrow('conflict')
    expect(() => runtime.cancel(run.id, 'invalid', 'local:owner')).toThrow('invalid-command')
    expect(() => runtime.cancel(run.id, randomUUID(), '')).toThrow('invalid-command')
    expect(await runtime.events(run.id)).toEqual(before)
  })

  it('treats a cancelled test as terminal without confusing it with workflow failure', async () => {
    const { runtime } = await fixture(), project = runtime.editProject({ operation: 'create', yaml: approval, title: 'Approval', actor: 'local:owner' })
    const draft = runtime.editTest({ operation: 'create', actor: 'local:owner', definition: { title: 'Stop',
      project: { id: project.id, generation: 1, revision: project.acceptedRevision }, input: approvalInput, expectations: [{ kind: 'status', value: 'cancelled' }] } })
    const accepted = runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: 1, reviewedSha256: draft.sha256, actor: 'local:owner' })
    const result = await runtime.runTest({ id: accepted.id, generation: 2, sha256: accepted.sha256 }, randomUUID())
    runtime.cancel(result.run.id, randomUUID(), 'local:owner')
    expect(await runtime.testResult(result.run.id)).toMatchObject({ assessment: 'passed', workflowStatus: 'cancelled', terminal: true })
  })

  it('rejects removal of cancellation provenance on reopen', async () => {
    const { runtime, directory } = await fixture(), waiting = await runtime.run(approval, approvalInput)
    runtime.cancel(waiting.id, randomUUID(), 'local:owner'); await runtime.close()
    const db = new DatabaseSync(join(directory, 'runtime.sqlite'))
    const row = db.prepare('SELECT record FROM runs WHERE id=?').get(waiting.id) as { record: string }, record = JSON.parse(row.record)
    delete record.cancellation
    db.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify(record), waiting.id); db.close()
    await expect(LocalRuntime.open({ dataDirectory: directory })).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('detects a changed stopped checkpoint even when its workflow path still replays', async () => {
    const { runtime, directory } = await fixture(), waiting = await runtime.run(approval, approvalInput)
    runtime.cancel(waiting.id, randomUUID(), 'local:owner'); await runtime.close()
    const db = new DatabaseSync(join(directory, 'runtime.sqlite'))
    const row = db.prepare('SELECT record FROM runs WHERE id=?').get(waiting.id) as { record: string }, record = JSON.parse(row.record)
    record.state.expiresAt = '2099-01-01T00:00:00.000Z'
    db.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify(record), waiting.id); db.close()
    await expect(LocalRuntime.open({ dataDirectory: directory })).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('supports CLI cancellation and preserves schema-9 evidence during migration', async () => {
    const { runtime, directory } = await fixture(), waiting = await runtime.run(approval, approvalInput); await runtime.close()
    const db = new DatabaseSync(join(directory, 'runtime.sqlite')); db.exec('PRAGMA user_version=9'); db.close()
    let output = ''
    expect(await main(['runs', 'cancel', waiting.id, '--request-id', randomUUID(), '--data-dir', directory],
      { out: value => { output += value }, err: () => {} })).toBe(0)
    expect(JSON.parse(output)).toMatchObject({ status: 'cancelled', cancellation: { status: 'stopped' } })
    const owner = await reopen(directory)
    expect((await owner.show(waiting.id)).state.steps).toEqual(waiting.state.steps)
  })
})
