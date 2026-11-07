import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { LocalRuntime } from '../src/runtime/index.ts'
import { startRuntimeService, AsyncRunClient } from '../src/http/index.ts'
import { runReleaseApp, type ReleaseBackend } from '../src/releases/app.ts'
import { releaseCommandReference, releaseCommandStrings } from '../src/releases/commands.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import * as secretFiles from '../src/providers/secret-input.ts'
import * as serviceProcess from '../src/http/process.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8'), token = 'a'.repeat(64)
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-app-async-')), dataDirectory = join(directory, 'state')
  const runtime = await LocalRuntime.open({ dataDirectory })
  const project = runtime.editProject({ operation: 'create', yaml: echo, title: 'App', actor: 'fixture:owner' })
  const release = runtime.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
    version: '1.0.0', actor: 'fixture:owner', runtime: { version: CORE_VERSION, sha256: 'b'.repeat(64) } })
  await runtime.close()
  const tokenFile = join(directory, 'token'), file = join(directory, 'retained-start.json')
  await writeFile(tokenFile, token, { mode: 0o600 })
  const pin = { id: release.snapshot.id, sha256: release.sha256, revision: release.snapshot.workflow.revision }
  const service = await startRuntimeService({ runtime: { dataDirectory }, token, actor: 'fixture:owner', release: { snapshot: release.snapshot }, asyncRuns: { maxConcurrentRuns: 1 } })
  cleanup.push(async () => { await service.close(); await service.closed })
  const open = vi.fn(async () => { throw Error('App transport must not open storage') })
  const serve = vi.fn(async (_values, _directory, options) => startRuntimeService({ ...options, runtime: { dataDirectory: join(directory, 'served') } }))
  const backend: ReleaseBackend = { storage: 'sqlite', open, serve }
  const flags = ['--endpoint', service.url, '--token-file', tokenFile, '--instance-id', service.instanceId]
  return { directory, tokenFile, file, pin, release, service, backend, open, serve, flags }
}
async function app(f: Awaited<ReturnType<typeof fixture>>, args: string[]) {
  let out = '', err = ''
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(acknowledgeCliWrite(value => { out += value }))
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(acknowledgeCliWrite(value => { err += value }))
  try {
    const code = await runReleaseApp(f.backend, f.release.snapshot, args, f.directory)
    return { code, out, err, result: out ? JSON.parse(out) : undefined, error: err ? JSON.parse(err) : undefined }
  } finally { stdout.mockRestore(); stderr.mockRestore() }
}

describe('exact workflow app async command adapters (not built app qualification)', () => {
  it.each(['sqlite', 'postgres'] as const)('uses only pinned remote metadata for %s command grammar, never a direct backend', async storage => {
    const f = await fixture(), id = randomUUID(); f.backend.storage = storage
    await writeFile(f.file, JSON.stringify({ kind: 'release', id, release: f.pin, input: 'PRIVATE_INPUT', paused: true }))
    const created = await app(f, ['submit', f.file, ...f.flags])
    expect(created.code).toBe(0); expect(created.result).toMatchObject({ observation: 'created', run: { id, startedPaused: true, release: { id: f.pin.id } } })
    expect(created.out).not.toMatch(/PRIVATE_|yaml|completion|steps|output/u)
    const observed = await app(f, ['observe', id, ...f.flags])
    expect(observed.code).toBe(0); expect(observed.result).toMatchObject({ observation: 'read', run: { id, status: 'paused' } })
    expect((await app(f, ['submit', f.file, ...f.flags])).result).toMatchObject({ observation: 'retained' })
    expect(f.open).not.toHaveBeenCalled(); expect(f.serve).not.toHaveBeenCalled()
  })

  it('refuses management source, foreign release/input pin and mixed state options before credentials or backend access', async () => {
    const f = await fixture(), secret = vi.spyOn(secretFiles, 'readSecretFile')
    for (const request of [{ kind: 'workflow', id: randomUUID(), yaml: echo, input: {} },
      { kind: 'release', id: randomUUID(), release: { ...f.pin, sha256: 'c'.repeat(64) }, input: 'PRIVATE_INPUT' }]) {
      await writeFile(f.file, JSON.stringify(request))
      const result = await app(f, ['submit', f.file, ...f.flags])
      expect(result.code).toBe(2); expect(result.error.code).toBe('invalid-command')
    }
    expect((await app(f, ['observe', randomUUID(), ...f.flags, '--data-dir', 'not-opened'])).code).toBe(2)
    expect(secret).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled()
  })

  it('exposes source-free async commands and no storage flags in both app command references', () => {
    for (const storage of ['sqlite', 'postgres'] as const) {
      for (const action of ['submit', 'observe']) {
        expect(releaseCommandStrings(action, storage)).not.toContain('data-dir')
        expect(releaseCommandStrings(action, storage)).not.toContain('database-file')
        expect(releaseCommandStrings(action, storage)).not.toContain('telemetry-file')
      }
      expect(releaseCommandReference(storage)).toContain('node app.mjs submit <retained-start.json>')
      expect(releaseCommandReference(storage)).toContain('--async-concurrency')
    }
  })

  it('forwards the explicit async startup bound to the owned service without execution', async () => {
    const f = await fixture()
    let read: any
    vi.spyOn(serviceProcess, 'runServiceProcess').mockImplementation(async start => {
      const server = await start()
      try {
        const client = new AsyncRunClient(server.url, token, server.instanceId, { release: f.pin })
        await expect(client.show(randomUUID())).rejects.toHaveProperty('code', 'not-found')
        read = f.serve.mock.calls.at(-1)![2]
      } finally { await server.close(); await server.closed }
      return 0
    })
    const result = await app(f, ['serve', '--token-file', f.tokenFile, '--async-concurrency', '2'])
    expect(result.code).toBe(0); expect(read.asyncRuns).toEqual({ maxConcurrentRuns: 2 }); expect(f.open).not.toHaveBeenCalled()
  })

  it.each(['0', '65', '01', '1e1', '-1', '9007199254740992'])('refuses malformed app startup capacity %s before credentials or backend access', async value => {
    const f = await fixture(), secret = vi.spyOn(secretFiles, 'readSecretFile')
    const result = await app(f, ['serve', '--token-file', '/not-read', '--async-concurrency', value])
    expect(result.code).toBe(2); expect(result.error.code).toBe('invalid-command')
    expect(secret).not.toHaveBeenCalled(); expect(f.serve).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled()
  })
})
import { acknowledgeCliWrite } from './helpers/cli-write.ts'
