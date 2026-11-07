import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:https'
import { createTlsFixture, fixturePort } from '../scripts/tls-fixture.mjs'
import { startRuntimeService, RuntimeClient } from '../src/http/index.ts'
import { capabilities, PROTOCOL_VERSION } from '../src/capabilities.ts'
import { operationCapabilities } from '../src/http/operation-host.ts'
import { main } from '../src/cli.ts'
import { openCliOperations, operationSelection } from '../src/cli/operations.ts'
import { startPreviewFromCli } from '../src/cli/preview.ts'

const foreign = vi.hoisted(() => ({ inspect: vi.fn(), read: vi.fn(), local: vi.fn() }))
vi.mock('../src/docker/index.ts', async original => ({ ...await original<typeof import('../src/docker/index.ts')>(),
  inspectDockerOwner: foreign.inspect, readDockerOwner: foreign.read }))
vi.mock('../src/cli/runtime.ts', async original => ({ ...await original<typeof import('../src/cli/runtime.ts')>(), openCliRuntime: foreign.local }))
const token = 'a'.repeat(64), previewToken = 'b'.repeat(64)
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
let tls: Awaited<ReturnType<typeof createTlsFixture>>
const cleanup: (() => Promise<unknown>)[] = []
beforeAll(async () => { tls = await createTlsFixture(await mkdtemp(join(tmpdir(), 'jevable-remote-tls-'))) }, 20000)
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  expect(foreign.inspect).not.toHaveBeenCalled(); expect(foreign.read).not.toHaveBeenCalled(); expect(foreign.local).not.toHaveBeenCalled()
  vi.clearAllMocks()
})
async function cli(...args: string[]) {
  let out = '', err = ''
  const exit = await main(args, { out: text => { out += text }, err: text => { err += text } })
  return { exit, result: out ? JSON.parse(out) : undefined, error: err ? JSON.parse(err) : undefined }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-remote-')), port = await fixturePort(), tokenFile = join(directory, 'token')
  await writeFile(tokenFile, token, { mode: 0o600 })
  const start = async () => {
    const service = await startRuntimeService({ runtime: { dataDirectory: join(directory, 'server-state') }, token, actor: 'remote:fixture', port,
      tls: { publicOrigin: `https://127.0.0.1:${port}`, bindAddress: '127.0.0.1', certificateFile: tls.cert, privateKeyFile: tls.key } })
    cleanup.push(async () => { await service.close(); await service.closed }); return service
  }
  const service = await start(), source = join(directory, 'workflow.yaml'), input = join(directory, 'input.json')
  await writeFile(source, echo); await writeFile(input, '"private remote fixture"')
  const flags = ['--endpoint', service.url, '--token-file', tokenFile, '--ca-file', tls.cert]
  const values = { endpoint: service.url, 'token-file': tokenFile, 'ca-file': tls.cert }
  const client = new RuntimeClient(service.url, token, 3000, 20_000_000, { ca: tls.ca })
  const call = async (command: Parameters<RuntimeClient['operation']>[0]) => (await client.operation(command) as { result: any }).result
  return { directory, tokenFile, source, input, start, service, flags, values, client, call }
}

describe('explicit HTTPS management endpoint without local or Docker ownership', () => {
  it('attaches a reviewed existing project through verified remote HTTPS without creating or running', async () => {
    const f = await fixture(), project = await f.call({ operation: 'projects.command', command: { operation: 'create', yaml: echo, title: 'Retained remote' } })
    const pin = { id: project.id, generation: project.generation, revision: project.acceptedRevision }, file = join(f.directory, 'pin.json')
    const bytes = JSON.stringify(pin), previewFile = join(f.directory, 'preview-token')
    await writeFile(file, bytes, { mode: 0o600 }); await writeFile(previewFile, previewToken, { mode: 0o600 })
    const gateway = await startPreviewFromCli(echo, { ...f.values, 'instance-id': f.service.instanceId, 'preview-token-file': previewFile,
      'project-pin-file': file, 'project-pin-sha256': createHash('sha256').update(bytes).digest('hex') })
    cleanup.push(async () => { await gateway.close(); await gateway.closed })
    expect(gateway.preview?.project).toEqual(pin)
    expect((await f.call({ operation: 'projects.list' })).projects).toHaveLength(1)
    expect((await f.call({ operation: 'runs.list' })).runs).toEqual([])
    const shell = await (await fetch(gateway.url)).text()
    expect(shell).not.toContain(token); expect(shell).not.toContain(previewToken); expect(shell).not.toContain(echo)
  })
  it.each(['http://127.0.0.1:9000', 'http://remote.invalid', 'https://user:secret@remote.invalid', 'https://remote.invalid/path',
    'https://remote.invalid/?token=secret', 'https://remote.invalid/#fragment', 'https://remote.invalid:0', 'not-a-url'])('rejects unsafe endpoint %s before I/O', endpoint => {
    expect(() => operationSelection({ endpoint, 'token-file': '/missing-private-token' })).toThrow()
  })
  it.each(['runtime', 'owner-file', 'owner-sha256', 'container-id', 'storage', 'database-file', 'data-dir', 'telemetry-file'])('rejects mixed %s before I/O', key => {
    expect(() => operationSelection({ endpoint: 'https://remote.invalid', 'token-file': '/missing', [key]: key === 'runtime' ? 'local' : 'mixed' })).toThrow()
  })
  it.each([{ 'token-file': undefined }, { 'instance-id': 'bad' }, { 'timeout-ms': '0' }, { 'timeout-ms': '3600001' }])('rejects incomplete/invalid selection %j', extra => {
    expect(() => operationSelection({ endpoint: 'https://remote.invalid', 'token-file': '/missing', ...extra })).toThrow()
  })
  it('handshakes read-only, verifies private TLS and preserves explicit run identity without local state', async () => {
    const f = await fixture(), before = await readdir(f.directory), host = await openCliOperations(f.values)
    expect(host.storage).toBe('sqlite'); expect((await f.call({ operation: 'runs.list' })).runs).toEqual([])
    expect((await cli('run', f.source, '--input', f.input, ...f.flags)).exit).toBe(2)
    const id = randomUUID(), run = await cli('run', f.source, '--input', f.input, '--id', id, ...f.flags)
    expect(run.exit).toBe(0); expect(run.result.output).toBe('private remote fixture')
    expect((await cli('run', f.source, '--input', f.input, '--id', id, ...f.flags)).result).toEqual(run.result)
    expect((await cli('runs', 'show', id, '--instance-id', f.service.instanceId, ...f.flags)).result).toEqual(run.result)
    expect((await cli('runs', 'list', '--endpoint', f.service.url, '--token-file', f.tokenFile)).exit).toBe(1)
    expect((await cli('runs', 'list', '--instance-id', randomUUID(), ...f.flags)).error.code).toBe('instance-mismatch')
    expect(await readdir(f.directory)).toEqual(before)
    await host.close(); expect((await f.client.health() as any).status).toBe('ready')
  })
  it('runs reviewed project/tests, explicit approvals and evidence through the selected management API', async () => {
    const f = await fixture(); await writeFile(f.source, approval); await writeFile(f.input, '{"message":"private review"}')
    const project = (await cli('projects', 'create', f.source, '--title', 'Remote approval', ...f.flags)).result
    const testFile = join(f.directory, 'test.json')
    await writeFile(testFile, JSON.stringify({ title: 'Approval checkpoint', project: { id: project.id, generation: 1, revision: project.acceptedRevision },
      input: { message: 'private review' }, expectations: [{ kind: 'status', value: 'waiting' }] }))
    const draft = (await cli('tests', 'create', testFile, ...f.flags)).result
    const accepted = (await cli('tests', 'accept', draft.id, '--expected-generation', '1', '--sha256', draft.sha256, ...f.flags)).result
    const selection = join(f.directory, 'suite-selection.json'), manifest = join(f.directory, 'suite.json')
    await writeFile(selection, JSON.stringify({ title: 'Remote suite', failurePolicy: 'stop', tests: [{ id: accepted.id, generation: accepted.generation, sha256: accepted.sha256 }] }))
    const suite = (await cli('tests', 'suite', 'create', selection, '--output', manifest)).result
    expect((await cli('tests', 'suite', 'result', manifest, '--instance-id', randomUUID(), ...f.flags)).error.code).toBe('instance-mismatch')
    expect((await cli('tests', 'suite', 'run', manifest, '--suite-sha256', suite.sha256, '--instance-id', f.service.instanceId, ...f.flags)).exit).toBe(3)
    const id = randomUUID(), result = await cli('tests', 'run', accepted.id, '--expected-generation', '2', '--sha256', accepted.sha256, '--id', id, ...f.flags)
    expect(result.exit).toBe(3); expect(result.result.assessment).toBe('passed')
    const review = (await cli('approvals', 'show', id, ...f.flags)).result
    expect((await cli('approvals', 'decide', id, '--attempt', review.attemptId, '--action', 'approve', ...f.flags)).result.status).toBe('completed')
    expect(JSON.stringify(await f.call({ operation: 'runs.inspect', id }))).toContain('remote:fixture')
    const output = join(f.directory, 'evidence.json')
    expect((await cli('runs', 'export', id, '--output', output, ...f.flags)).exit).toBe(0)
    expect(await readFile(output, 'utf8')).not.toContain('private review')
    expect((await cli('releases', 'create', project.id, '--expected-generation', '1', '--revision', project.acceptedRevision, '--version', '1.0.0', ...f.flags)).exit).toBe(2)
    // Actual runtime bundles live in the built distribution, not src/. The independent package
    // verifier creates/exports and executes a real release through this endpoint selector.
  })
  it('pins operations across restart and never silently reconnects a retained client', async () => {
    const f = await fixture(), host = await openCliOperations(f.values)
    await f.service.close(); await f.service.closed; await f.start()
    await expect(host.call({ operation: 'runs.start', id: randomUUID(), yaml: echo, input: 'must not run' })).rejects.toMatchObject({ code: 'instance-mismatch' })
    expect((await f.call({ operation: 'runs.list' })).runs).toEqual([])
    await host.close()
  })
  it('serves a separate scoped preview gateway with no management token in HTML or backend ownership', async () => {
    const f = await fixture(), previewFile = join(f.directory, 'preview-token'), projectId = randomUUID()
    await writeFile(previewFile, previewToken, { mode: 0o600 })
    const gateway = await startPreviewFromCli(echo, { ...f.values, 'project-id': projectId, 'preview-token-file': previewFile })
    cleanup.push(async () => { await gateway.close(); await gateway.closed })
    const html = await (await fetch(gateway.url)).text(); expect(html).not.toContain(token); expect(html).not.toContain(previewToken)
    const raw = async (path: string, body: unknown, credential: string) => fetch(gateway.url + path, { method: 'POST',
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'X-Jevable-Protocol': PROTOCOL_VERSION }, body: JSON.stringify(body) })
    expect((await raw('/v1/preview/bootstrap', {}, token)).status).toBe(401)
    const boot = await (await raw('/v1/preview/bootstrap', {}, previewToken)).json() as any
    const id = randomUUID(), response = await raw('/v1/preview/operations', { operation: 'run', id, input: 'remote preview' }, boot.result.token)
    expect(response.status).toBe(200); expect(((await response.json()) as any).result.output).toBe('remote preview')
    expect((await raw('/v1/operations', { operation: 'projects.list' }, boot.result.token)).status).toBe(401)
    await gateway.close(); expect((await f.call({ operation: 'runs.show', id })).project.id).toBe(projectId)
    expect((await f.client.health() as any).status).toBe('ready')
  })
  it.each(['release', 'version', 'backend', 'guard', 'health', 'instance', 'postgres'])('validates %s capabilities/health before dispatch', async fault => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-remote-cap-')), tokenFile = join(directory, 'token'), instanceId = randomUUID(), methods: string[] = []
    await writeFile(tokenFile, token, { mode: 0o600 })
    const storage = fault === 'postgres' ? 'postgres' : 'sqlite'
    const caps: any = { ...capabilities(), instanceId, remoteAccess: true, workflowRuntime: { storage }, api: { transport: 'direct-https', servesHtml: false,
      instanceGuard: 'x-jevable-instance', operations: operationCapabilities(storage) } }
    if (fault === 'release') delete caps.api.operations
    if (fault === 'version') caps.version = 'unsupported-version'
    if (fault === 'backend') caps.api.operations.storage = 'postgres'
    if (fault === 'guard') delete caps.api.instanceGuard
    const server = createServer({ cert: tls.ca, key: await readFile(tls.key) }, (req, res) => {
      methods.push(req.method!); res.setHeader('x-jevable-protocol', PROTOCOL_VERSION); res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(req.url === '/v1/capabilities' ? caps : { instanceId, status: fault === 'health' ? 'draining' : 'ready',
        runtime: { storage, ...(storage === 'postgres' ? { database: 'reachable', state: 'open' } : {}) } }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
    const endpoint = `https://127.0.0.1:${(server.address() as { port: number }).port}`
    const values = { endpoint, 'token-file': tokenFile, 'ca-file': tls.cert, ...(fault === 'instance' ? { 'instance-id': randomUUID() } : {}) }
    if (fault === 'postgres') {
      const host = await openCliOperations(values); expect(host.storage).toBe('postgres')
      await expect(host.call({ operation: 'runs.list' })).rejects.toThrow('--page'); await host.close()
    } else await expect(openCliOperations(values)).rejects.toThrow()
    expect(methods.every(method => method === 'GET')).toBe(true)
  })
})
