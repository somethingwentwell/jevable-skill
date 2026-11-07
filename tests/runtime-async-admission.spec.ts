import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LocalRuntime, type AsyncRunOptions, type ModelCalls } from '../src/runtime/index.ts'
import { admitAsyncRun } from '../src/runtime/async-run.ts'
import { RunStore } from '../src/runtime/store.ts'
import { capabilities, CORE_VERSION } from '../src/capabilities.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const api = await readFile(new URL('../examples/api-echo.yaml', import.meta.url), 'utf8')
const model = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'model', name: 'Model' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false },
      execution: { timeoutSeconds: 1, maxAttempts: 1 }, historyScope: 'none' } },
    end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } },
    edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
const directory = () => mkdtemp(join(tmpdir(), 'jevable-async-admission-'))
const releaseIdentity = { version: CORE_VERSION, sha256: '1'.repeat(64) } // Snapshot pin fixture, not executable runtime proof.

describe('durable owner SDK asynchronous admission', () => {
  it('discovers SDK and opt-in HTTP admission with explicit CLI/foreground startup boundaries', () => {
    expect(capabilities().workflowRuntime.asyncAdmission).toMatchObject({
      sdkMethods: ['runAsync', 'runProjectAsync', 'runReleaseAsync'], storageBackends: ['sqlite', 'postgres'], http202: true,
      http: { startup: 'explicit-sdk-asyncRuns.maxConcurrentRuns; disabled-by-default', cli: ['runtime submit', 'runtime observe'],
        startupFlag: '--async-concurrency 1..64', releaseAppCommands: ['submit', 'observe'] }, automaticResume: false,
    })
  })
  it('captures the first acknowledged checkpoint while the original execution remains pending and protected', async () => {
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), id = randomUUID()
    const execute = vi.fn(async () => { entered.resolve(); await gate.promise; throw new Error('response lost') })
    const models: ModelCalls = { admit() {}, execute, async verify() {} }
    const runtime = await LocalRuntime.open({ dataDirectory: await directory(), models })
    let completion: Promise<unknown> | undefined
    try {
      const admitted = await runtime.runAsync(model, 'private input', { id })
      completion = admitted.completion.catch(error => error)
      expect(admitted.observation).toBe('created')
      expect(admitted.run).toMatchObject({ id, input: 'private input', state: { status: 'paused', steps: [] } })
      expect(admitted.run.startedPaused).toBeUndefined()
      await entered.promise
      expect((await runtime.show(id)).state.status).toBe('executing')
      await expect(runtime.close()).rejects.toHaveProperty('code', 'busy')
      expect(() => runtime.setCredential('fixture/key', 'rotation', 0, 'local:test')).toThrow('busy')
      await expect(runtime.runAsync(model, 'private input', { id })).rejects.toHaveProperty('code', 'busy')
      admitted.run.input = 'edited snapshot'
      expect((await runtime.show(id)).input).toBe('private input')
      gate.resolve()
      expect(await completion).toMatchObject({ message: 'response lost' })
      expect(execute).toHaveBeenCalledTimes(1)
      expect((await runtime.show(id)).state.status).toBe('executing')
    } finally { gate.resolve(); await completion; await runtime.close() }
  })

  it('waits for model readiness and rejects before creation when admission fails', async () => {
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), failure = new Error('admission refused')
    const execute = vi.fn(), models: ModelCalls = { async admit() { entered.resolve(); await gate.promise; throw failure }, execute, async verify() {} }
    const runtime = await LocalRuntime.open({ dataDirectory: await directory(), models })
    const pending = runtime.runAsync(model, 'input', { id: randomUUID() })
    const failed = pending.catch(error => error)
    try {
      await entered.promise
      expect(runtime.list()).toEqual([])
      await expect(runtime.close()).rejects.toHaveProperty('code', 'busy')
      gate.resolve(); expect(await failed).toBe(failure)
      expect(runtime.list()).toEqual([]); expect(execute).not.toHaveBeenCalled()
    } finally { gate.resolve(); await failed; await runtime.close() }
  })

  it('returns a creation snapshot for a fast workflow, then observes the retained result without replay', async () => {
    const path = await directory(), id = randomUUID()
    let runtime = await LocalRuntime.open({ dataDirectory: path })
    try {
      const admission = await runtime.runAsync(echo, 'result', { id })
      expect(admission).toMatchObject({ observation: 'created', run: { state: { status: 'paused', steps: [] } } })
      const result = await admission.completion, events = await runtime.events(id)
      expect(result.state).toMatchObject({ status: 'completed', output: 'result' })
      expect(admission.run.state.status).toBe('paused')
      await runtime.close(); runtime = await LocalRuntime.open({ dataDirectory: path })
      const retry = await runtime.runAsync(echo, 'result', { id })
      expect(retry).toMatchObject({ observation: 'retained', run: result })
      expect(await retry.completion).toEqual(result); expect(await runtime.events(id)).toEqual(events)
      await expect(runtime.runAsync(echo, 'changed', { id })).rejects.toHaveProperty('code', 'conflict')
    } finally { await runtime.close() }
  })

  it('keeps explicit pause durable across reopen and only advances on a reviewed control request', async () => {
    const path = await directory(), id = randomUUID()
    let runtime = await LocalRuntime.open({ dataDirectory: path })
    try {
      const admission = await runtime.runAsync(echo, 'result', { id, paused: true })
      const paused = await admission.completion
      expect(paused).toEqual(admission.run); expect(paused.startedPaused).toBe(true)
      expect((await runtime.events(id)).map(event => event.kind)).toEqual(['run-created'])
      await runtime.close(); runtime = await LocalRuntime.open({ dataDirectory: path })
      const retry = await runtime.runAsync(echo, 'result', { id, paused: true })
      expect(retry.observation).toBe('retained'); expect(await retry.completion).toEqual(paused)
      await expect(runtime.runAsync(echo, 'result', { id })).rejects.toHaveProperty('code', 'conflict')
      const { executionCheckpointHash } = await import('../src/runtime/index.ts')
      const result = await runtime.advance(id, { requestId: randomUUID(), expectedCheckpointSha256: executionCheckpointHash(paused), mode: 'continue' }, 'local:test')
      expect(result.state.status).toBe('completed')
    } finally { await runtime.close() }
  })

  it('preserves uncertain intent after reopen without redispatch or implicit resume', async () => {
    const path = await directory(), id = randomUUID(), execute = vi.fn(async () => { throw new Error('uncertain response') })
    const models: ModelCalls = { admit() {}, execute, async verify() {} }
    let runtime = await LocalRuntime.open({ dataDirectory: path, models })
    try {
      const admission = await runtime.runAsync(model, 'input', { id })
      await expect(admission.completion).rejects.toThrow('uncertain response')
      const events = await runtime.events(id)
      await runtime.close(); runtime = await LocalRuntime.open({ dataDirectory: path, models })
      const retry = await runtime.runAsync(model, 'input', { id })
      expect(retry).toMatchObject({ observation: 'retained', run: { state: { status: 'executing' } } })
      expect((await retry.completion).state.status).toBe('executing')
      await expect(runtime.resume(id)).rejects.toHaveProperty('code', 'conflict')
      expect(execute).toHaveBeenCalledTimes(1); expect(await runtime.events(id)).toEqual(events)
    } finally { await runtime.close() }
  })

  it('rejects uncertain creation acknowledgement, keeps its UUID inspectable, and never dispatches', async () => {
    const runtime = await LocalRuntime.open({ dataDirectory: await directory() }), id = randomUUID()
    const original = RunStore.prototype.save, failure = new Error('creation acknowledgement lost')
    const save = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function (this: RunStore, ...args) {
      original.apply(this, args)
      if (args[1] === 'run-created') throw failure
    })
    try {
      await expect(runtime.runAsync(echo, 'input', { id })).rejects.toBe(failure)
      expect((await runtime.show(id)).state.status).toBe('paused')
      expect((await runtime.events(id)).map(event => event.kind)).toEqual(['run-created'])
      save.mockRestore()
      const retry = await runtime.runAsync(echo, 'input', { id })
      expect(retry.observation).toBe('retained'); expect((await retry.completion).state.status).toBe('paused')
    } finally { save.mockRestore(); await runtime.close() }
  })

  it.each([{}, { id: 'invalid' }, { id: randomUUID(), paused: 'true' }, { id: randomUUID(), triggerMode: 'manual' },
    { id: randomUUID(), project: { id: randomUUID(), generation: 1 } }, { id: randomUUID(), onAdmitted: () => {} },
    { id: randomUUID(), release: {} }, { id: randomUUID(), test: {} }])('refuses non-public asynchronous start options before writes: %j', async options => {
    const runtime = await LocalRuntime.open({ dataDirectory: await directory() })
    try {
      await expect(runtime.runAsync(echo, 'input', options as AsyncRunOptions)).rejects.toHaveProperty('code', 'invalid-command')
      expect(runtime.list()).toEqual([])
    } finally { await runtime.close() }
  })

  it('pins project review and preserves historical retries after project edits', async () => {
    const runtime = await LocalRuntime.open({ dataDirectory: await directory() }), id = randomUUID()
    try {
      const project = runtime.editProject({ operation: 'create', yaml: echo, title: 'Reviewed', actor: 'local:test' })
      await expect(runtime.runProjectAsync(project.id, 2, project.acceptedRevision, 'input', { id })).rejects.toHaveProperty('code', 'conflict')
      const admission = await runtime.runProjectAsync(project.id, 1, project.acceptedRevision, 'input', { id })
      expect(admission.run.project).toEqual({ id: project.id, generation: 1 })
      const result = await admission.completion, events = await runtime.events(id)
      runtime.editProject({ operation: 'rename', id: project.id, expectedGeneration: 1, title: 'Changed', actor: 'local:test' })
      const retry = await runtime.runProjectAsync(project.id, 1, project.acceptedRevision, 'input', { id })
      expect(retry.observation).toBe('retained'); expect(await retry.completion).toEqual(result)
      expect(await runtime.events(id)).toEqual(events)
      await expect(runtime.runProjectAsync(project.id, 1, project.acceptedRevision, 'input', { id: randomUUID() })).rejects.toHaveProperty('code', 'conflict')
    } finally { await runtime.close() }
  })

  it('rechecks project guards after asynchronous model admission, before returning a durable receipt', async () => {
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), execute = vi.fn()
    const models: ModelCalls = { async admit() { entered.resolve(); await gate.promise }, execute, async verify() {} }
    const runtime = await LocalRuntime.open({ dataDirectory: await directory(), models })
    const project = runtime.editProject({ operation: 'create', yaml: model, title: 'Reviewed model', actor: 'local:test' })
    const failed = runtime.runProjectAsync(project.id, 1, project.acceptedRevision, 'input', { id: randomUUID() }).catch(error => error)
    try {
      await entered.promise
      runtime.editProject({ operation: 'archive', id: project.id, expectedGeneration: 1, archived: true, actor: 'local:test' })
      gate.resolve(); expect(await failed).toHaveProperty('code', 'conflict')
      expect(runtime.list()).toEqual([]); expect(execute).not.toHaveBeenCalled()
    } finally { gate.resolve(); await failed; await runtime.close() }
  })

  it('admits immutable releases independently of the originating project store', async () => {
    const origin = await LocalRuntime.open({ dataDirectory: await directory() })
    const project = origin.editProject({ operation: 'create', yaml: echo, title: 'Release', actor: 'local:test' })
    const release = origin.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
      version: '1.0.0', runtime: releaseIdentity, actor: 'local:test' })
    await origin.close()
    const target = await LocalRuntime.open({ dataDirectory: await directory() }), id = randomUUID()
    try {
      const admitted = await target.runReleaseAsync(release.snapshot, 'independent', { id })
      expect(admitted.run.release).toEqual({ id: release.snapshot.id, sha256: release.sha256 }); expect(target.projects()).toEqual([])
      const result = await admitted.completion
      expect(result.state).toMatchObject({ status: 'completed', output: 'independent' })
      expect((await target.runReleaseAsync(release.snapshot, 'independent', { id })).observation).toBe('retained')
      await expect(target.runAsync(echo, 'independent', { id })).rejects.toHaveProperty('code', 'conflict')
    } finally { await target.close() }
  })

  it('returns real approval waits without deciding or pretending that execution has completed', async () => {
    const runtime = await LocalRuntime.open({ dataDirectory: await directory() })
    try {
      const admitted = await runtime.runAsync(approval, { message: 'synthetic review' }, { id: randomUUID() })
      const waiting = await admitted.completion
      expect(waiting.state.status).toBe('waiting')
      expect((await runtime.events(waiting.id)).some(event => event.kind === 'approval-decided')).toBe(false)
    } finally { await runtime.close() }
  })

  it('retains explicit API entry identity without provisioning ingress or inferring it on retry', async () => {
    const runtime = await LocalRuntime.open({ dataDirectory: await directory() }), id = randomUUID()
    try {
      await expect(runtime.runAsync(api, 'input', { id })).rejects.toHaveProperty('code', 'invalid-command')
      expect(runtime.list()).toEqual([])
      const admitted = await runtime.runAsync(api, 'input', { id, triggerMode: 'api' })
      expect(admitted.run.triggerMode).toBe('api')
      expect((await admitted.completion).state).toMatchObject({ status: 'completed', output: 'input' })
      expect((await runtime.events(id))[0]!.data).toMatchObject({ triggerMode: 'api' })
      await expect(runtime.runAsync(api, 'input', { id })).rejects.toHaveProperty('code', 'invalid-command')
      expect((await runtime.runAsync(api, 'input', { id, triggerMode: 'api' })).observation).toBe('retained')
    } finally { await runtime.close() }
  })

  it('keeps cancellation an explicit durable request while asynchronous execution is in flight', async () => {
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), id = randomUUID()
    const models: ModelCalls = { admit() {}, async verify() {}, async execute() {
      entered.resolve(); await gate.promise; return { output: 'model result', usage: { tries: 1 } }
    } }
    const runtime = await LocalRuntime.open({ dataDirectory: await directory(), models })
    let completion: Promise<unknown> | undefined
    try {
      const admitted = await runtime.runAsync(model, 'input', { id }); completion = admitted.completion.catch(error => error)
      await entered.promise
      const requestId = randomUUID(), receipt = runtime.cancel(id, requestId, 'local:test')
      expect(receipt.cancellation?.id).toBe(requestId)
      gate.resolve()
      const result = await completion
      expect(result).toMatchObject({ id, cancellation: { id: requestId }, state: { status: 'cancelled' } })
      const events = await runtime.events(id)
      expect(events.filter(event => event.kind === 'cancellation-requested')).toHaveLength(1)
      expect(events.filter(event => event.kind === 'run-cancelled')).toHaveLength(1)
      expect(events.some(event => event.kind === 'node-intent' && JSON.stringify(event.data).includes('end'))).toBe(false)
    } finally { gate.resolve(); await completion; await runtime.close() }
  })

  it('prioritizes closed-owner admission for every new entrypoint', async () => {
    const runtime = await LocalRuntime.open({ dataDirectory: await directory() })
    await runtime.close()
    const invalid = {} as AsyncRunOptions
    for (const call of [() => runtime.runAsync(echo, 'input', invalid), () => runtime.runProjectAsync('bad', 0, '', 'input', invalid),
      () => runtime.runReleaseAsync({}, 'input', invalid)]) await expect(call()).rejects.toHaveProperty('code', 'closed')
  })

  it('the internal adapter reports synchronous throws and retained observation without false creation', async () => {
    const failure = new Error('sync failure')
    await expect(admitAsyncRun(() => { throw failure })).rejects.toBe(failure)
    const runtime = await LocalRuntime.open({ dataDirectory: await directory() })
    try {
      const retained = await runtime.run(echo, 'input')
      const observed = await admitAsyncRun(async () => retained)
      expect(observed.observation).toBe('retained'); expect(await observed.completion).toEqual(retained)
      observed.run.input = 'mutated'; expect(retained.input).toBe('input')
    } finally { await runtime.close() }
  })
})
