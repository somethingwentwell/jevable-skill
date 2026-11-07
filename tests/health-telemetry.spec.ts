import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { startRuntimeService } from '../src/http/service.ts'
import { RuntimeClient } from '../src/http/client.ts'
import { ReleaseClient } from '../src/releases/client.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { CORE_VERSION } from '../src/capabilities.ts'

const yaml = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
it.each([['management', false], ['management', true], ['release', false], ['release', true]] as const)(
  '%s SQLite health reports private exporter metadata with telemetry=%s without execution or flush authority', async (role, enabled) => {
    let requests = 0
    const receiver = createServer((_req, res) => { requests++; res.writeHead(503); res.end('PRIVATE_COLLECTOR_ERROR') })
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve, reject) => { receiver.close(error => error ? reject(error) : resolve()); receiver.closeAllConnections() }))
    const endpoint = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/v1/traces`
    const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-health-telemetry-'))
    const author = await LocalRuntime.open({ dataDirectory })
    let release
    try {
      if (enabled) await author.setCredential('otel/private-health-key', 'PRIVATE_EXPORTER_KEY', 0, 'fixture:author')
      if (role === 'release') {
        const p = author.editProject({ operation: 'create', yaml, title: 'Health fixture', actor: 'fixture:author' })
        release = author.createRelease({ projectId: p.id, expectedGeneration: 1, revision: p.acceptedRevision,
          version: '1.0.0', actor: 'fixture:author', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
      }
    } finally { await author.close() }
    const token = randomBytes(32).toString('hex')
    const service = await startRuntimeService({ runtime: { dataDirectory, ...(enabled ? { telemetry: {
      endpoint, metricsEndpoint: endpoint.replace('traces', 'metrics'), logsEndpoint: endpoint.replace('traces', 'logs'),
      authentication: { kind: 'bearer' as const, credentialRef: 'otel/private-health-key' }, intervalMs: 20, timeoutMs: 100, flushTimeoutMs: 200,
    } } : {}) }, token, actor: 'fixture:owner', ...(release ? { release: { snapshot: release.snapshot } } : {}) })
    cleanup.push(() => service.close())
    const client = release ? new ReleaseClient(service.url, token, release.sha256) : new RuntimeClient(service.url, token)
    const call = async (command: any) => (await client.operation(command) as { result: any }).result
    expect((await fetch(service.url + '/v1/health')).status).toBe(401)
    const first: any = await client.health()
    expect(first).toMatchObject({ status: 'ready', runtime: { storage: 'sqlite', telemetry: { enabled } } })
    if (!enabled) expect(first.runtime.telemetry).toEqual({ enabled: false, signals: [] })
    expect((await call({ operation: 'runs.list' })).runs).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 60)); expect(requests).toBe(0)
    const id = randomUUID(), result = await call({ operation: 'runs.start', id, input: 'PRIVATE_WORKFLOW_PAYLOAD', ...(release ? {} : { yaml }) })
    const events = await call({ operation: 'runs.events', id })
    if (enabled) await vi.waitFor(async () => {
      const status: any = await client.health()
      for (const signal of [status.runtime.telemetry, status.runtime.telemetry.metrics, status.runtime.telemetry.logs]) {
        expect(signal.failedBatches).toBeGreaterThan(0); expect(signal.lastFailure).toBe('response')
      }
    })
    for (let n = 0; n < 3; n++) {
      const status = await client.health(), text = JSON.stringify(status)
      for (const secret of ['PRIVATE_', endpoint, 'otel/private-health-key', token, dataDirectory]) expect(text).not.toContain(secret)
      expect(status).toMatchObject({ status: 'ready' })
    }
    expect(await call({ operation: 'runs.show', id })).toEqual(result)
    expect(await call({ operation: 'runs.events', id })).toEqual(events)
    if (release) {
      await expect(call({ operation: 'telemetry.flush' })).rejects.toMatchObject({ code: 'invalid-command' })
      await expect(call({ operation: 'telemetry.probe' })).rejects.toMatchObject({ code: 'invalid-command' })
    }
  })
