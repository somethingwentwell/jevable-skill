import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { main } from '../src/cli.ts'
import { startRuntimeService, RuntimeClient } from '../src/http/index.ts'
import { LocalRuntime } from '../src/runtime/index.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import * as secretFiles from '../src/providers/secret-input.ts'
import * as serviceProcess from '../src/http/process.ts'
import { ServerResponse } from 'node:http'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { asyncRunRequestSchema, asyncReleasePinSchema, asyncRunPolicySchema } from '../src/http/async-runs.ts'
import { httpRateLimitsSchema } from '../src/http/rate-limits.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const token = 'a'.repeat(64), cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function invoke(args: string[]) {
  let out = '', err = ''
  const code = await main([...args, '--json'], { out: value => { out += value }, err: value => { err += value } })
  return { code, out, err, result: out ? JSON.parse(out) : undefined, error: err ? JSON.parse(err) : undefined }
}
async function fixture(enabled = true, releaseMode = false) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-async-cli-')), dataDirectory = join(directory, 'state')
  const tokenFile = join(directory, 'token'), file = join(directory, 'retained-start.json'), pinFile = join(directory, 'reviewed-release.json')
  await writeFile(tokenFile, token, { mode: 0o600 })
  const runtime = await LocalRuntime.open({ dataDirectory })
  const project = runtime.editProject({ operation: 'create', title: 'Async CLI', yaml: echo, actor: 'fixture:owner' })
  const release = runtime.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
    version: '1.0.0', actor: 'fixture:owner', runtime: { version: CORE_VERSION, sha256: 'b'.repeat(64) } })
  await runtime.close()
  const pin = { id: release.snapshot.id, sha256: release.sha256, revision: release.snapshot.workflow.revision }
  await writeFile(pinFile, JSON.stringify(pin), { mode: 0o600 })
  const service = await startRuntimeService({ runtime: { dataDirectory }, token, actor: 'fixture:owner',
    ...(enabled ? { asyncRuns: { maxConcurrentRuns: 1 } } : {}), ...(releaseMode ? { release: { snapshot: release.snapshot } } : {}) })
  cleanup.push(async () => { await service.close(); await service.closed })
  const flags = ['--endpoint', service.url, '--token-file', tokenFile, '--instance-id', service.instanceId]
  const owner = new RuntimeClient(service.url, token)
  return { directory, dataDirectory, tokenFile, file, pinFile, pin, project, release, service, flags, owner }
}

describe('explicit owner async CLI submission/observation', () => {
  it('recovers a dropped acknowledged creation response only by its retained UUID, without replay or a replacement identity', async () => {
    const f = await fixture(), id = randomUUID()
    await writeFile(f.file, JSON.stringify({ kind: 'workflow', id, yaml: echo, input: 'PRIVATE_INPUT', paused: true }))
    const end = ServerResponse.prototype.end
    let dropped = 0
    const drop = vi.spyOn(ServerResponse.prototype, 'end').mockImplementation(function(this: ServerResponse, ...args: any[]) {
      // writeHead's direct headers need not populate getHeader(); this isolated fixture has one creation response.
      if (this.statusCode === 202) { dropped++; this.destroy(); return this }
      return end.apply(this, args as never)
    })
    const response = await invoke(['runtime', 'submit', f.file, ...f.flags])
    expect(response.code).toBe(1); expect(response.error.code).toBe('transport-uncertain'); expect(dropped).toBe(1)
    drop.mockRestore()
    const before = await f.owner.operation({ operation: 'runs.events', id }) as any
    expect(before.result.events.map((event: any) => event.kind)).toEqual(['run-created'])
    expect((await invoke(['runtime', 'observe', id, ...f.flags])).result).toMatchObject({ observation: 'read', run: { id, status: 'paused' } })
    expect((await invoke(['runtime', 'submit', f.file, ...f.flags])).result).toMatchObject({ observation: 'retained' })
    expect(await f.owner.operation({ operation: 'runs.events', id })).toEqual(before)
  })

  it('reports an approval wait as a successful metadata read, not workflow completion or approval authority', async () => {
    const f = await fixture(), id = randomUUID(), approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
    await writeFile(f.file, JSON.stringify({ kind: 'workflow', id, yaml: approval, input: { message: 'PRIVATE_REVIEW' } }))
    expect((await invoke(['runtime', 'submit', f.file, ...f.flags])).code).toBe(0)
    const response = await invoke(['runtime', 'observe', id, ...f.flags])
    expect(response.code).toBe(0); expect(response.result.run.status).toBe('waiting'); expect(response.out).not.toContain('PRIVATE_REVIEW')
    const before = await f.owner.operation({ operation: 'runs.events', id })
    await invoke(['runtime', 'observe', id, ...f.flags])
    expect(await f.owner.operation({ operation: 'runs.events', id })).toEqual(before)
  })
  it('submits a retained strict file, observes paused metadata and retries without a direct owner, handshake or execution replay', async () => {
    const f = await fixture(), id = randomUUID(), request = { kind: 'workflow', id, yaml: echo, input: 'PRIVATE_INPUT', paused: true }
    await writeFile(f.file, JSON.stringify(request), { mode: 0o600 })
    const submitted = await invoke(['runtime', 'submit', f.file, ...f.flags])
    expect(submitted.code).toBe(0); expect(submitted.result).toMatchObject({ observation: 'created', instanceId: f.service.instanceId,
      run: { id, status: 'paused', startedPaused: true } })
    expect(submitted.out).not.toMatch(/PRIVATE_|yaml|completion|steps|output/u)
    const before = await f.owner.operation({ operation: 'runs.events', id })
    const observed = await invoke(['runtime', 'observe', id, ...f.flags])
    expect(observed.code).toBe(0); expect(observed.result).toMatchObject({ observation: 'read', run: { id, status: 'paused' } })
    expect((await invoke(['runtime', 'submit', f.file, ...f.flags])).result).toMatchObject({ observation: 'retained' })
    expect(await f.owner.operation({ operation: 'runs.events', id })).toEqual(before)
  })

  it('admits a reviewed project pin without inventing a run identity or refreshing a stale generation', async () => {
    const f = await fixture(), id = randomUUID(), request = { kind: 'project', id, input: 'PRIVATE_INPUT', paused: true,
      project: { id: f.project.id, generation: 1, revision: f.project.acceptedRevision } }
    await writeFile(f.file, JSON.stringify({ ...request, project: { ...request.project, generation: 2 } }))
    expect((await invoke(['runtime', 'submit', f.file, ...f.flags])).error).toHaveProperty('code', 'conflict')
    await writeFile(f.file, JSON.stringify(request))
    expect((await invoke(['runtime', 'submit', f.file, ...f.flags])).result).toMatchObject({ run: { id, project: { id: f.project.id, generation: 1 } } })
  })

  it('uses an independently reviewed release pin for exact-release submit/read without owner-wide fallback', async () => {
    const f = await fixture(true, true), id = randomUUID()
    await writeFile(f.file, JSON.stringify({ kind: 'release', id, release: f.pin, input: 'PRIVATE_INPUT', paused: true }))
    const flags = [...f.flags, '--release-pin-file', f.pinFile]
    expect((await invoke(['runtime', 'submit', f.file, ...flags])).result).toMatchObject({ observation: 'created', run: { release: { id: f.pin.id } } })
    expect((await invoke(['runtime', 'observe', id, ...flags])).result).toMatchObject({ observation: 'read', run: { id, status: 'paused' } })
    const noHash = await invoke(['runtime', 'observe', id, ...f.flags])
    expect(noHash.code).toBe(1); expect(noHash.error.code).toBe('release-required')
    await writeFile(f.file, JSON.stringify({ kind: 'workflow', id: randomUUID(), yaml: echo, input: 'PRIVATE_INPUT' }))
    const secret = vi.spyOn(secretFiles, 'readSecretFile')
    expect((await invoke(['runtime', 'submit', f.file, ...flags])).error.code).toBe('invalid-command')
    expect(secret).not.toHaveBeenCalled()
  })

  it('refuses a stale instance before dispatch and never adopts the replacement from discovery', async () => {
    const f = await fixture(), id = randomUUID()
    await writeFile(f.file, JSON.stringify({ kind: 'workflow', id, yaml: echo, input: 'PRIVATE_INPUT' }))
    const response = await invoke(['runtime', 'submit', f.file, '--endpoint', f.service.url, '--token-file', f.tokenFile, '--instance-id', randomUUID()])
    expect(response.code).toBe(1); expect(response.error.code).toBe('instance-mismatch')
    expect(await f.owner.operation({ operation: 'runs.list' })).toMatchObject({ result: { runs: [] } })
  })

  it('reports disabled ingress instead of falling back to synchronous execution', async () => {
    const f = await fixture(false)
    await writeFile(f.file, JSON.stringify({ kind: 'workflow', id: randomUUID(), yaml: echo, input: 'PRIVATE_INPUT' }))
    expect((await invoke(['runtime', 'submit', f.file, ...f.flags])).error.code).toBe('not-found')
    expect(await f.owner.operation({ operation: 'runs.list' })).toMatchObject({ result: { runs: [] } })
  })

  it('validates the command and optional release file before opening credentials or contacting a service', async () => {
    const f = await fixture(), secret = vi.spyOn(secretFiles, 'readSecretFile')
    for (const request of [{}, { kind: 'workflow', id: 'bad', yaml: echo, input: 'PRIVATE_INPUT' },
      { kind: 'workflow', id: randomUUID(), yaml: echo, input: 'PRIVATE_INPUT', actor: 'forged' }]) {
      await writeFile(f.file, JSON.stringify(request))
      expect((await invoke(['runtime', 'submit', f.file, ...f.flags])).error.code).toBe('invalid-command')
    }
    await writeFile(f.pinFile, '{}')
    expect((await invoke(['runtime', 'observe', randomUUID(), ...f.flags, '--release-pin-file', f.pinFile])).error.code).toBe('invalid-command')
    expect(secret).not.toHaveBeenCalled()
  })

  it.each(['--data-dir', '--storage', '--runtime', '--telemetry-file', '--owner-file'])('refuses mixed owner option %s before files or credentials', async flag => {
    const secret = vi.spyOn(secretFiles, 'readSecretFile')
    const result = await invoke(['runtime', 'submit', '/missing/retained.json', '--endpoint', 'http://127.0.0.1:54321',
      '--token-file', '/missing/private-token', '--instance-id', randomUUID(), flag, 'forbidden'])
    expect(result.code).toBe(2); expect(secret).not.toHaveBeenCalled()
  })

  it('requires an explicit instance and validates observation UUID/timeout before I/O', async () => {
    const secret = vi.spyOn(secretFiles, 'readSecretFile'), flags = ['--endpoint', 'http://127.0.0.1:54321', '--token-file', '/missing/private-token']
    expect((await invoke(['runtime', 'submit', '/missing/input', ...flags])).code).toBe(2)
    expect((await invoke(['runtime', 'observe', '../health', ...flags, '--instance-id', randomUUID()])).code).toBe(2)
    expect((await invoke(['runtime', 'observe', randomUUID(), ...flags, '--instance-id', randomUUID(), '--timeout-ms', '01'])).code).toBe(2)
    expect(secret).not.toHaveBeenCalled()
  })

  it('discovers both commands, exact required flags and the async startup bound without opening an owner', async () => {
    const secret = vi.spyOn(secretFiles, 'readSecretFile')
    for (const action of ['submit', 'observe']) {
      const result = await invoke(['runtime', action, '--help'])
      expect(result.code).toBe(0); expect(result.result.variants[0].options).toMatchObject({ endpoint: 'string', 'instance-id': 'string', 'release-pin-file': 'string' })
      expect(result.result.variants[0].requirements.rules).toContainEqual({ kind: 'required', flags: ['endpoint', 'token-file', 'instance-id'] })
    }
    const serve = await invoke(['runtime', 'serve', '--help'])
    expect(serve.result.variants[0].requirements.rules).toContainEqual({ kind: 'integer', flag: 'async-concurrency', minimum: 1, maximum: 64, encoding: 'canonical-unsigned-decimal' })
    const start = await invoke(['runtime', 'start', '--help'])
    expect(start.result.variants[0].options['async-concurrency']).toBe('string')
    expect(start.result.variants[1].options['async-concurrency']).toBe('string')
    expect(start.result.variants[1].requirements.rules).toContainEqual({ kind: 'integer', flag: 'async-concurrency', minimum: 1, maximum: 64, encoding: 'canonical-unsigned-decimal' })
    expect(secret).not.toHaveBeenCalled()
  })

  it('discovers deterministic bounded input contracts from the actual consuming schemas in context-specific JSON help', async () => {
    const secret = vi.spyOn(secretFiles, 'readSecretFile'), ajv = new Ajv2020({ strict: false, validateFormats: false })
    const contracts = new Map<string, z.ZodType>([['async-run-start', asyncRunRequestSchema], ['async-release-pin', asyncReleasePinSchema], ['async-run-policy', asyncRunPolicySchema], ['http-rate-limits', httpRateLimitsSchema]])
    for (const action of ['submit', 'observe', 'serve', 'start']) {
      const a = await invoke(['runtime', action, '--help']), b = await invoke(['runtime', action, '--help'])
      expect(a.code).toBe(0); expect(a.result.inputContracts).toEqual(b.result.inputContracts)
      for (const entry of a.result.inputContracts) {
        expect(entry.schema).toEqual(z.toJSONSchema(contracts.get(entry.id)!, { io: 'input', target: 'draft-2020-12', unrepresentable: 'throw' }))
        expect(entry.sha256).toBe(createHash('sha256').update(JSON.stringify(entry.schema)).digest('hex'))
        expect(entry.validation).toBe('structural-input-projection-only')
        expect(entry.references).toEqual([entry.id === 'http-rate-limits' ? 'references/rate-limits.md' : 'references/async-runs.md'])
        const check = ajv.compile(entry.schema); expect(check(undefined)).toBe(false)
        const value = entry.id === 'async-run-start' ? { kind: 'workflow', id: randomUUID(), yaml: 'source', input: {}, paused: true }
          : entry.id === 'async-release-pin' ? { id: randomUUID(), revision: 'b'.repeat(64), sha256: 'a'.repeat(64) }
            : entry.id === 'http-rate-limits' ? { requests: { capacity: 2, refillTokens: 1, refillIntervalMs: 1000 }, controls: { capacity: 1, refillTokens: 1, refillIntervalMs: 1000 } } : { maxConcurrentRuns: 1 }
        expect(check(value)).toBe(true); expect(check({ ...value, actor: 'forged' })).toBe(false)
      }
    }
    expect(secret).not.toHaveBeenCalled()
  })

  it.each(['0', '65', '01', '1e1', '-1', '9007199254740992'])('refuses noncanonical/out-of-range startup capacity %s before credential access', async capacity => {
    const secret = vi.spyOn(secretFiles, 'readSecretFile')
    const result = await invoke(['runtime', 'serve', '--token-file', '/not-read', '--async-concurrency', capacity])
    expect(result.code).toBe(2); expect(secret).not.toHaveBeenCalled()
  })

  it.each(['serve', 'start'])('enables bounded admission only through an explicit local %s startup flag; startup performs no execution', async action => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-async-cli-start-')), tokenFile = join(directory, 'token')
    await writeFile(tokenFile, token, { mode: 0o600 })
    let capabilities: any, runs: any
    vi.spyOn(serviceProcess, 'runServiceProcess').mockImplementation(async start => {
      const server = await start(), client = new RuntimeClient(server.url, token)
      try { capabilities = await client.capabilities(); runs = await client.operation({ operation: 'runs.list' }) }
      finally { await server.close(); await server.closed }
      return 0
    })
    const result = await invoke(['runtime', action, '--token-file', tokenFile, '--data-dir', join(directory, 'state'), '--async-concurrency', '2'])
    expect(result.code).toBe(0); expect(capabilities.api.asyncRuns.maxConcurrentRuns).toBe(2); expect(runs.result.runs).toEqual([])
  })
})
