import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime, type ModelCalls } from '../src/runtime/index.ts'
import { renderTemplate } from '../src/templates/index.ts'
import { RunStore } from '../src/runtime/store.ts'

const workspace = () => mkdtemp(join(tmpdir(), 'jevable-runtime-'))
const approval = () => readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const echo = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'echo', name: 'Echo' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    result: { type: 'output', config: { value: '${{ inputs }}' } } }, edges: [{ from: 'start', to: 'result' }] } })

describe('standalone workflow runtime', () => {
  it('retains exact results, revision and unique attempt evidence after closing and reopening', async () => {
    const dataDirectory = await workspace(), id = randomUUID()
    let runtime = await LocalRuntime.open({ dataDirectory })
    const run = await runtime.run(echo, 'real result', { id })
    expect(run.state).toMatchObject({ status: 'completed', output: 'real result' })
    const events = await runtime.events(id)
    expect(events.map(event => event.kind)).toEqual(['run-created', 'node-intent', 'node-result', 'node-intent', 'node-result'])
    await runtime.close()
    runtime = await LocalRuntime.open({ dataDirectory })
    expect(await runtime.show(id)).toEqual(run)
    expect(await runtime.run(echo, 'real result', { id })).toEqual(run)
    expect(await runtime.events(id)).toEqual(events)
    await expect(runtime.run(echo, 'different', { id })).rejects.toMatchObject({ code: 'conflict' })
    await runtime.close()
  })

  it('refuses competing writers while the owner has the data directory', async () => {
    const dataDirectory = await workspace()
    const owner = await LocalRuntime.open({ dataDirectory })
    await expect(LocalRuntime.open({ dataDirectory })).rejects.toMatchObject({ code: 'busy' })
    await owner.close()
    await (await LocalRuntime.open({ dataDirectory })).close()
  })

  it.each(['approve', 'reject'])('preserves a pending approval across restart and handles %s', async action => {
    const dataDirectory = await workspace()
    let runtime = await LocalRuntime.open({ dataDirectory })
    const run = await runtime.run(await approval(), { message: 'Please review' })
    expect(run.state.status).toBe('waiting')
    if (run.state.status !== 'waiting') throw Error('expected approval')
    const attemptId = run.state.attempt.id
    await runtime.close()
    runtime = await LocalRuntime.open({ dataDirectory })
    await expect(runtime.decide(run.id, randomUUID(), action, 'local:test')).rejects.toMatchObject({ code: 'conflict' })
    await expect(runtime.decide(run.id, attemptId, 'invented-action', 'local:test')).rejects.toMatchObject({ code: 'invalid-command' })
    const result = await runtime.decide(run.id, attemptId, action, 'local:test')
    expect(result.state).toMatchObject(action === 'approve' ? { status: 'completed', output: 'approve' }
      : { status: 'failed', code: 'approval-rejected' })
    await expect(runtime.decide(run.id, attemptId, action, 'local:test')).rejects.toMatchObject({ code: 'conflict' })
    expect(await runtime.events(run.id)).toContainEqual(expect.objectContaining({ kind: 'approval-decided', data: expect.objectContaining({
      decision: expect.objectContaining({ actor: 'local:test', action }),
    }) }))
    await runtime.close()
    await (await LocalRuntime.open({ dataDirectory })).close()
  })

  it('executes deterministic routing and scoped loops from the shared templates', async () => {
    const runtime = await LocalRuntime.open({ dataDirectory: await workspace() })
    try {
      const discount = JSON.stringify(renderTemplate('discount-approval'))
      const sample = (await import('../src/templates/index.ts')).listTemplates().find(template => template.id === 'discount-approval')!.sample
      const run = await runtime.run(discount, sample)
      expect(['waiting', 'completed']).toContain(run.state.status)
      const expense = JSON.stringify(renderTemplate('expense-check'))
      const input = (await import('../src/templates/index.ts')).listTemplates().find(template => template.id === 'expense-check')!.sample
      const loop = await runtime.run(expense, input)
      expect(['waiting', 'completed']).toContain(loop.state.status)
      expect(loop.state.steps.some(step => step.scope !== undefined)).toBe(true)
      await runtime.show(loop.id)
    } finally { await runtime.close() }
  })

  it('refuses invalid inputs and unconfigured model graphs before retaining any run', async () => {
    const runtime = await LocalRuntime.open({ dataDirectory: await workspace() })
    try {
      await expect(runtime.run(echo, 42)).rejects.toThrow()
      const source = await readFile(new URL('../examples/decision.yaml', import.meta.url), 'utf8')
      await expect(runtime.run(source, 'ticket')).rejects.toMatchObject({ code: 'invalid-command' })
      expect(runtime.list()).toEqual([])
    } finally { await runtime.close() }
  })

  it('never redispatches an uncertain model attempt after restart or duplicate request', async () => {
    const dataDirectory = await workspace(), id = randomUUID()
    let calls = 0
    const models: ModelCalls = { admit() {}, async execute() { calls++; throw Error('response lost') }, async verify() {} }
    const source = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'model', name: 'Model' },
      spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
        write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
          prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false },
          execution: { timeoutSeconds: 1, maxAttempts: 1 }, historyScope: 'none' } },
        end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } },
      edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
    let runtime = await LocalRuntime.open({ dataDirectory, models })
    await expect(runtime.run(source, 'message', { id })).rejects.toThrow('response lost')
    expect((await runtime.show(id)).state.status).toBe('executing')
    await runtime.close()
    runtime = await LocalRuntime.open({ dataDirectory, models })
    expect((await runtime.run(source, 'message', { id })).state.status).toBe('executing')
    await expect(runtime.resume(id)).rejects.toMatchObject({ code: 'conflict' })
    expect(calls).toBe(1)
    await runtime.close()
  })

  it('rejects altered persisted output without executing it', async () => {
    const dataDirectory = await workspace()
    const runtime = await LocalRuntime.open({ dataDirectory })
    const run = await runtime.run(echo, 'original')
    await runtime.close()
    const database = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'))
    const row = database.prepare('SELECT record FROM runs WHERE id=?').get(run.id) as { record: string }
    const record = JSON.parse(row.record)
    record.state.output = 'tampered'
    database.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify(record), run.id)
    database.close()
    await expect(LocalRuntime.open({ dataDirectory })).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('keeps intent uncertain when settlement storage fails instead of rerunning it', async () => {
    const dataDirectory = await workspace(), id = randomUUID()
    let runtime = await LocalRuntime.open({ dataDirectory })
    const save = RunStore.prototype.save
    const spy = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function (this: RunStore, record, kind, data) {
      if (kind === 'node-result') throw Error('disk write failed')
      return save.call(this, record, kind, data)
    })
    try { await expect(runtime.run(echo, 'saved intent', { id })).rejects.toThrow('disk write failed') }
    finally { spy.mockRestore(); await runtime.close() }
    runtime = await LocalRuntime.open({ dataDirectory })
    try {
      expect((await runtime.show(id)).state.status).toBe('executing')
      expect((await runtime.events(id)).map(event => event.kind)).toEqual(['run-created', 'node-intent'])
      await expect(runtime.resume(id)).rejects.toMatchObject({ code: 'conflict' })
    } finally { await runtime.close() }
  })

  it('records an expired approval instead of applying a late action', async () => {
    const runtime = await LocalRuntime.open({ dataDirectory: await workspace() })
    try {
      const run = await runtime.run(await approval(), { message: 'Expired review' })
      if (run.state.status !== 'waiting') throw Error('expected approval')
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.parse(run.state.expiresAt) + 1)
      const settled = await runtime.decide(run.id, run.state.attempt.id, 'approve', 'local:test')
      expect(settled.state).toMatchObject({ status: 'failed', code: 'approval-expired',
        inspection: { approval: { kind: 'expired' } } })
    } finally { vi.useRealTimers(); await runtime.close() }
  })

  it('never lets an expiry-only closure become a timely approval', async () => {
    const runtime = await LocalRuntime.open({ dataDirectory: await workspace() })
    try {
      const run = await runtime.run(await approval(), { message: 'Only close after expiry' })
      if (run.state.status !== 'waiting') throw Error('expected approval')
      const before = await runtime.events(run.id)
      await expect(runtime.decide(run.id, run.state.attempt.id, 'approve', 'local:test', { expireOnly: true }))
        .rejects.toMatchObject({ code: 'conflict' })
      expect((await runtime.show(run.id)).state.status).toBe('waiting')
      expect(await runtime.events(run.id)).toEqual(before)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.parse(run.state.expiresAt) + 1)
      const expired = await runtime.decide(run.id, run.state.attempt.id, 'approve', 'local:test', { expireOnly: true })
      expect(expired.state).toMatchObject({ status: 'failed', code: 'approval-expired' })
      expect(expired.state.steps.map(step => step.nodeId)).toEqual(['start'])
      expect((await runtime.events(run.id)).filter(event => event.kind === 'approval-decided')).toHaveLength(1)
    } finally { vi.useRealTimers(); await runtime.close() }
  })
})
