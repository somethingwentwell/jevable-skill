import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { LocalRuntime } from '../src/runtime/local.ts'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'

const yaml = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const telemetry = { endpoint: 'http://127.0.0.1:9/v1/traces', authentication: { kind: 'none' as const }, intervalMs: 60000 }
afterEach(() => vi.restoreAllMocks())

describe('runtime operation lifecycle', () => {
  it('closes admission before telemetry shutdown and makes repeated close await the same cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-runtime-close-'))
    const owner = await LocalRuntime.open({ dataDirectory: directory, telemetry })
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const original = RuntimeTelemetry.prototype.close
    const close = vi.spyOn(RuntimeTelemetry.prototype, 'close').mockImplementation(async function (this: RuntimeTelemetry) {
      entered.resolve(); await gate.promise; return original.call(this)
    })
    let finished = false
    const pending = owner.close(), repeated = owner.close().then(() => { finished = true })
    try {
      await entered.promise
      expect(finished).toBe(false); expect(close).toHaveBeenCalledTimes(1)
      await expect(owner.run(yaml, 'must not run')).rejects.toMatchObject({ code: 'closed' })
      await expect(owner.check(yaml)).rejects.toMatchObject({ code: 'closed' })
      expect(() => owner.editProject({ operation: 'create', title: 'must not write', yaml, actor: 'local:test' })).toThrow('closed')
      expect(() => owner.setCredential('fixture/key', 'must not write', 0, 'local:test')).toThrow('closed')
      await expect(LocalRuntime.open({ dataDirectory: directory })).rejects.toMatchObject({ code: 'busy' })
    } finally { gate.resolve(); await Promise.all([pending, repeated]) }
    expect(finished).toBe(true)
    const replacement = await LocalRuntime.open({ dataDirectory: directory })
    try { expect(replacement.list()).toEqual([]); expect(replacement.projects()).toEqual([]) }
    finally { await replacement.close() }
    await owner.close(); expect(close).toHaveBeenCalledTimes(1)
    expect(owner.telemetryStatus()).toMatchObject({ closed: true })
  })

  it('releases storage ownership even when telemetry shutdown fails and preserves that close result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-runtime-close-error-'))
    const owner = await LocalRuntime.open({ dataDirectory: directory, telemetry })
    const original = RuntimeTelemetry.prototype.close, failure = new Error('fixture shutdown failure')
    const close = vi.spyOn(RuntimeTelemetry.prototype, 'close').mockImplementation(async function (this: RuntimeTelemetry) {
      await original.call(this); throw failure
    })
    await expect(owner.close()).rejects.toBe(failure)
    await expect(owner.close()).rejects.toBe(failure)
    expect(close).toHaveBeenCalledTimes(1)
    expect(() => owner.projects()).toThrow('closed')
    const replacement = await LocalRuntime.open({ dataDirectory: directory })
    await replacement.close()
  })

  it('blocks credential rotation during explicit flush and joins it during close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-runtime-flush-'))
    const owner = await LocalRuntime.open({ dataDirectory: directory, telemetry })
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const original = RuntimeTelemetry.prototype.flush
    vi.spyOn(RuntimeTelemetry.prototype, 'flush').mockImplementation(async function (this: RuntimeTelemetry) {
      entered.resolve(); await gate.promise; return original.call(this)
    })
    const flushing = owner.telemetryFlush()
    let closing: Promise<void> | undefined, closed = false
    try {
      await entered.promise
      expect(() => owner.setCredential('otel/key', 'replacement', 0, 'local:test')).toThrow('busy')
      closing = owner.close().then(() => { closed = true })
      await expect(owner.telemetryFlush()).rejects.toMatchObject({ code: 'closed' })
      expect(closed).toBe(false)
    } finally { gate.resolve(); await flushing; await closing; await owner.close() }
    expect(closed).toBe(true)
  })

  it('refuses closed SDK operations consistently before validation or model admission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-runtime-closed-api-'))
    const admit = vi.fn(), execute = vi.fn(), verify = vi.fn()
    const owner = await LocalRuntime.open({ dataDirectory: directory, models: { admit, execute, verify } })
    await owner.close()
    const id = randomUUID(), hash = '0'.repeat(64), actor = 'local:test'
    const sync = [() => owner.list(), () => owner.connections(), () => owner.configureConnection({}, 0, actor),
      () => owner.credentialStatus('fixture/key'), () => owner.setCredential('fixture/key', 'value', 0, actor), () => owner.providerAudit(),
      () => owner.withTraceParent(undefined, () => { throw new Error('must not call callback') }),
      () => owner.projects(), () => owner.project(id), () => owner.editProject({ operation: 'create', title: 'x', yaml, actor }),
      () => owner.diffProject(id, hash, hash), () => owner.projectDeletions(), () => owner.exportProject(id, 1, hash),
      () => owner.inspectProjectImport('{}'), () => owner.importProject('{}', hash, actor), () => owner.deleteProject(id, 1, actor),
      () => owner.testCases(), () => owner.testCase(id), () => owner.testHistory(id), () => owner.testGeneration(id), () => owner.testGenerations(),
      () => owner.generateTests({ id, project: { id, generation: 1, revision: hash }, actor }),
      () => owner.editTest({ operation: 'accept', id, expectedGeneration: 1, reviewedSha256: hash, actor }),
      () => owner.createRelease({ projectId: id, expectedGeneration: 1, revision: hash, version: '1.0.0', runtime: { version: '0.1.0-alpha.1', sha256: hash }, actor }),
      () => owner.releases(), () => owner.release(id), () => owner.cancel(id, randomUUID(), actor)]
    for (const operation of sync) expect(operation).toThrow('closed')
    const async = [() => owner.show(id), () => owner.check(yaml), () => owner.telemetryFlush(), () => owner.testResult(id),
      () => owner.runTest({ id, generation: 1, sha256: hash }, randomUUID()), () => owner.runRelease({}, 'input'),
      () => owner.runProject(id, 1, hash, 'input'), () => owner.events(id), () => owner.exportRun(id), () => owner.run(yaml, 'input'),
      () => owner.advance(id, { requestId: randomUUID(), expectedCheckpointSha256: hash, mode: 'step' }, actor),
      () => owner.resume(id), () => owner.decide(id, id, 'approve', actor)]
    for (const operation of async) await expect(operation()).rejects.toMatchObject({ code: 'closed' })
    expect(admit).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled()
    expect(owner.telemetryStatus()).toEqual({ enabled: false, signals: [] })
  })
})
