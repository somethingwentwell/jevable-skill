import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createTlsFixture, fixturePort } from '../scripts/tls-fixture.mjs'
import { startRuntimeService, startPreviewGateway, RuntimeClient, RuntimeHttpError, type RuntimeOperation } from '../src/http/index.ts'
import { startPreviewFromCli } from '../src/cli/preview.ts'
import { PreviewSession } from '../src/preview/session.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'

const mocks = vi.hoisted(() => ({ read: vi.fn(), inspect: vi.fn() }))
vi.mock('../src/docker/index.ts', async original => ({ ...await original<typeof import('../src/docker/index.ts')>(),
  readDockerOwner: mocks.read, inspectDockerOwner: mocks.inspect }))
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const ownerToken = '1'.repeat(64), previewToken = '2'.repeat(64), containerId = '3'.repeat(64)
let tls: Awaited<ReturnType<typeof createTlsFixture>>
const cleanup: (() => Promise<unknown>)[] = []
beforeAll(async () => { tls = await createTlsFixture(await mkdtemp(join(tmpdir(), 'jevable-preview-gateway-tls-'))) }, 20000)
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.clearAllMocks() })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-preview-gateway-')), port = await fixturePort()
  const tokenFile = join(directory, 'owner-token'), previewFile = join(directory, 'preview-token')
  await writeFile(tokenFile, ownerToken, { mode: 0o600 }); await writeFile(previewFile, previewToken, { mode: 0o600 })
  const start = async () => {
    const service = await startRuntimeService({ runtime: { dataDirectory: join(directory, 'state') }, token: ownerToken, actor: 'fixture:backend', port,
      tls: { publicOrigin: `https://127.0.0.1:${port}`, bindAddress: '127.0.0.1', certificateFile: tls.cert, privateKeyFile: tls.key } })
    cleanup.push(() => service.close()); return service
  }
  const service = await start()
  const client = new RuntimeClient(service.url, ownerToken, 3000, 20_000_000, { ca: tls.ca, expectedInstanceId: service.instanceId })
  const call = async (command: RuntimeOperation, parent?: string) => (await client.operation(command, parent) as { result: any }).result
  mocks.read.mockResolvedValue({ fixture: 'owner' })
  mocks.inspect.mockResolvedValue({ containerId, status: 'running', resources: { endpoint: service.url }, service: { status: 'ready', instanceId: service.instanceId } })
  const values = { runtime: 'docker', 'owner-file': join(directory, 'owner.json'), 'owner-sha256': '4'.repeat(64),
    'container-id': containerId, 'token-file': tokenFile, 'ca-file': tls.cert, 'preview-token-file': previewFile, 'project-id': randomUUID() }
  return { directory, start, service, client, call, values }
}
async function connected(service: Awaited<ReturnType<typeof startPreviewGateway>>) {
  cleanup.push(() => service.close())
  const post = (path: string, command: unknown, token: string, headers: Record<string, string> = {}) => fetch(service.url + path, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Jevable-Protocol': PROTOCOL_VERSION, ...headers }, body: JSON.stringify(command) })
  const boot = await post('/v1/preview/bootstrap', {}, previewToken)
  expect(boot.status).toBe(200)
  const session = (await boot.json() as any).result
  const raw = (command: unknown, headers?: Record<string, string>) => post('/v1/preview/operations', command, session.token, headers)
  const operation = async (command: unknown) => { const response = await raw(command); expect(response.status).toBe(200); return (await response.json() as any).result }
  return { service, post, session, raw, operation }
}

describe('standalone selected-owner preview gateway — protocol, not browser qualification', () => {
  it('uses the verified HTTPS owner, distinct browser token and no local database or generic management proxy', async () => {
    const f = await fixture(), before = await readdir(f.directory), g = await connected(await startPreviewFromCli(echo, f.values))
    expect(await readdir(f.directory)).toEqual(before)
    const shell = await (await fetch(g.service.url)).text()
    expect(shell).not.toContain(ownerToken); expect(shell).not.toContain(previewToken); expect(shell).not.toContain(echo)
    expect(shell).toContain('never the management token')
    expect((await g.post('/v1/preview/bootstrap', {}, ownerToken)).status).toBe(401)
    expect((await g.post('/v1/operations', { operation: 'projects.list' }, previewToken)).status).toBe(404)
    expect((await g.post('/v1/operations', { operation: 'projects.list' }, g.session.token)).status).toBe(401)
    const caps = await new RuntimeClient(g.service.url, previewToken).capabilities() as any
    expect(caps.management).toBe(false); expect(caps.storage).toBe('none'); expect(caps.api.endpoints).not.toContain('/v1/operations')
    const view = await g.operation({ operation: 'view' })
    expect(view.project.id).toBe(f.values['project-id']); expect(view.execution).toBe('not-run')
    expect((await f.call({ operation: 'runs.list' })).runs).toEqual([])
    const id = randomUUID(), command = { operation: 'run', id, input: 'private gateway input' }, done = await g.operation(command)
    expect(done.output).toBe(command.input); expect(await g.operation(command)).toEqual(done)
    expect((await g.operation({ operation: 'runs' })).runs.map((run: any) => run.id)).toEqual([id])
    expect((await g.operation({ operation: 'inspect', id })).run.input).toBe(command.input)
    expect(JSON.stringify(await g.operation({ operation: 'evidence', id }))).not.toContain(command.input)
    await g.service.close()
    expect((await f.call({ operation: 'runs.show', id })).status).toBe('completed')
    expect((await f.call({ operation: 'projects.show', id: view.project.id })).changes[0].actor).toBe('fixture:backend')
  })

  it('scopes run reads, controls, tests and batches to exactly the retained project generation/revision', async () => {
    const f = await fixture(), g = await connected(await startPreviewFromCli(echo, f.values))
    const project = await f.call({ operation: 'projects.command', command: { operation: 'create', yaml: echo, title: 'Foreign' } })
    const id = randomUUID(), pin = { id: project.id, generation: 1, revision: project.acceptedRevision }
    await f.call({ operation: 'projects.run', id: pin.id, expectedGeneration: 1, revision: pin.revision, runId: id, input: 'secret', paused: true })
    for (const operation of ['show', 'inspect', 'evidence', 'approval']) expect((await g.raw({ operation, id })).status).toBe(404)
    expect((await g.raw({ operation: 'cancel', id, requestId: randomUUID() })).status).toBe(404)
    expect((await g.raw({ operation: 'advance', id, requestId: randomUUID(), mode: 'step', expectedCheckpointSha256: '0'.repeat(64) })).status).toBe(404)
    const batchId = randomUUID(), batch = await f.call({ operation: 'tests.generate', id: batchId, project: pin, limit: 1 })
    expect((await g.raw({ operation: 'tests.generation', id: batchId })).status).toBe(404)
    expect((await g.raw({ operation: 'tests.show', id: batch.snapshot.cases[0].id })).status).toBe(404)
    expect(await g.operation({ operation: 'tests.list' })).toEqual({ tests: [] })
    expect(await g.operation({ operation: 'runs' })).toEqual({ runs: [] })
    for (const extra of [{ actor: 'spoofed' }, { project: pin }]) expect((await g.raw({ operation: 'run', id: randomUUID(), input: 'x', ...extra })).status).toBe(400)
    expect((await f.call({ operation: 'runs.show', id })).status).toBe('paused')
  })

  it('preserves explicit saved-test review, historical inspection, approvals and guarded controls', async () => {
    const f = await fixture(), g = await connected(await startPreviewFromCli(approval, f.values))
    const generated = await g.operation({ operation: 'tests.generate', id: randomUUID(), limit: 1 })
    expect(generated.snapshot.execution).toBe('not-run')
    const caseId = randomUUID(), draft = await g.operation({ operation: 'tests.create', id: caseId, title: 'Review me', input: { message: 'review input' }, expectations: [{ kind: 'status', value: 'waiting' }] })
    expect((await g.raw({ operation: 'tests.run', test: { id: caseId, generation: 1, sha256: draft.sha256 }, runId: randomUUID() })).status).toBe(409)
    const accepted = await g.operation({ operation: 'tests.accept', id: caseId, expectedGeneration: 1, reviewedSha256: draft.sha256 })
    const id = randomUUID(), result = await g.operation({ operation: 'tests.run', test: { id: caseId, generation: accepted.generation, sha256: accepted.sha256 }, runId: id })
    expect(result).toMatchObject({ assessment: 'passed', terminal: false })
    const review = await g.operation({ operation: 'approval', id })
    expect(review.review.input.input).toBe('review input'); expect(review.actions).toContain('approve')
    const paused = await g.operation({ operation: 'decide', id, attemptId: review.attemptId, action: 'approve', pauseAfter: true })
    expect(paused.status).toBe('paused')
    const command = { operation: 'advance', id, requestId: randomUUID(), mode: 'continue', expectedCheckpointSha256: paused.checkpointSha256 }
    expect((await g.operation(command)).status).toBe('completed')
    expect((await g.operation(command)).status).toBe('completed')
    expect((await g.operation({ operation: 'tests.result', runId: id, inspect: true })).checks[0].actual).toBe('completed')
    expect(JSON.stringify(await g.operation({ operation: 'inspect', id }))).toContain('fixture:backend')
  })

  it('rejects a restarted backend before dispatch and never reconnects or creates another project implicitly', async () => {
    const f = await fixture(), g = await connected(await startPreviewFromCli(echo, f.values))
    await f.service.close(); const replacement = await f.start()
    const id = randomUUID(), refused = await g.raw({ operation: 'run', id, input: 'must not run' })
    expect(refused.status).toBe(409); expect((await refused.json() as any).code).toBe('instance-mismatch')
    const client = new RuntimeClient(replacement.url, ownerToken, 3000, 20_000_000, { ca: tls.ca })
    expect((await client.operation({ operation: 'runs.list' }) as any).result.runs).toEqual([])
    expect((await client.operation({ operation: 'projects.list' }) as any).result.projects).toHaveLength(1)
    await g.service.close(); expect((await client.health() as any).status).toBe('ready')
  })

  it('explicitly reattaches the same retained approval after backend replacement without creation or execution', async () => {
    const f = await fixture(), first = await connected(await startPreviewFromCli(approval, f.values))
    const view = await first.operation({ operation: 'view' }), id = randomUUID()
    const waiting = await first.operation({ operation: 'run', id, input: { message: 'retained synthetic approval' } })
    expect(waiting.status).toBe('waiting')
    const before = await f.call({ operation: 'runs.events', id })
    await first.service.close(); await f.service.close(); await f.service.closed
    const next = await f.start(), client = new RuntimeClient(next.url, ownerToken, 3000, 20_000_000, { ca: tls.ca, expectedInstanceId: next.instanceId })
    const call = vi.fn(async (command: RuntimeOperation) => (await client.operation(command) as { result: any }).result)
    const second = await connected(await startPreviewGateway({ source: approval, projectId: view.project.id, projectPin: view.project, token: previewToken }, { call }))
    expect(call.mock.calls.map(c => c[0].operation)).toEqual(['projects.show'])
    expect((await second.operation({ operation: 'runs' })).runs.map((r: any) => r.id)).toEqual([id])
    expect(await second.operation({ operation: 'show', id })).toEqual(waiting)
    expect(await call({ operation: 'runs.events', id })).toEqual(before)
    expect((await call({ operation: 'projects.list' })).projects).toHaveLength(1)
    const review = await second.operation({ operation: 'approval', id })
    expect((await second.operation({ operation: 'decide', id, attemptId: review.attemptId, action: 'approve' })).status).toBe('completed')
  })

  it('reads a reviewed existing-project file through the selected Docker CLI gateway and preserves its run', async () => {
    const f = await fixture(), project = await f.call({ operation: 'projects.command', command: { operation: 'create', yaml: echo, title: 'Existing' } })
    const id = randomUUID(), pin = { id: project.id, generation: project.generation, revision: project.acceptedRevision }
    const done = await f.call({ operation: 'projects.run', id: pin.id, expectedGeneration: pin.generation, revision: pin.revision, runId: id, input: 'existing result' })
    const pinFile = join(f.directory, 'reviewed-project.json'), bytes = JSON.stringify(pin)
    await writeFile(pinFile, bytes, { mode: 0o600 })
    const gateway = await connected(await startPreviewFromCli(echo, { ...f.values, 'project-id': undefined,
      'project-pin-file': pinFile, 'project-pin-sha256': createHash('sha256').update(bytes).digest('hex') }))
    expect(gateway.service.preview?.project).toEqual(pin)
    expect(await gateway.operation({ operation: 'show', id })).toEqual(done)
    expect((await f.call({ operation: 'projects.list' })).projects).toHaveLength(1)
    expect((await f.call({ operation: 'runs.list' })).runs).toHaveLength(1)
  })

  it('reopens a direct SQLite preview on retained state without creating a second project or replaying a run', async () => {
    const f = await fixture(), project = await f.call({ operation: 'projects.command', command: { operation: 'create', yaml: echo, title: 'Local retained' } })
    const id = randomUUID(), pin = { id: project.id, generation: project.generation, revision: project.acceptedRevision }
    const run = await f.call({ operation: 'projects.run', id: pin.id, expectedGeneration: pin.generation, revision: pin.revision, runId: id, input: 'retained local output' })
    const events = await f.call({ operation: 'runs.events', id }), file = join(f.directory, 'local-pin.json'), bytes = JSON.stringify(pin)
    await writeFile(file, bytes, { mode: 0o600 }); await f.service.close(); await f.service.closed
    const next = await connected(await startPreviewFromCli(echo, { 'token-file': f.values['preview-token-file'], 'data-dir': join(f.directory, 'state'),
      'project-pin-file': file, 'project-pin-sha256': createHash('sha256').update(bytes).digest('hex') }))
    expect(next.service.preview?.project).toEqual(pin)
    expect(await next.operation({ operation: 'show', id })).toEqual(run)
    const owner = new RuntimeClient(next.service.url, previewToken)
    expect((await owner.operation({ operation: 'projects.list' }) as any).result.projects).toHaveLength(1)
    expect((await owner.operation({ operation: 'runs.events', id }) as any).result).toEqual(events)
  })

  it('retains committed run identity after response loss without automatic replay or cancellation', async () => {
    const f = await fixture(), calls: string[] = [], g = await connected(await startPreviewGateway({ source: echo, projectId: randomUUID(), token: previewToken }, {
      async call(command, parent) { calls.push(command.operation); const result = await f.call(command, parent)
        if (command.operation === 'projects.run') throw new RuntimeHttpError('request-timeout')
        return result }
    }))
    const id = randomUUID(), failed = await g.raw({ operation: 'run', id, input: 'committed' })
    expect(failed.status).toBe(502); expect((await failed.json() as any).code).toBe('request-timeout')
    expect((await g.operation({ operation: 'show', id })).output).toBe('committed')
    expect(calls.filter(name => name === 'projects.run')).toHaveLength(1)
    await g.service.close(); expect((await f.call({ operation: 'runs.show', id })).status).toBe('completed')
  })

  it('preserves an explicitly retained project ID after uncertain startup; binding failures never create a project', async () => {
    const f = await fixture(), projectId = randomUUID(), port = await fixturePort()
    await expect(startPreviewGateway({ source: echo, projectId, token: previewToken, port }, { async call(command) {
      await f.call(command); throw new RuntimeHttpError('transport-uncertain')
    } })).rejects.toMatchObject({ code: 'transport-uncertain' })
    expect((await f.call({ operation: 'projects.show', id: projectId })).generation).toBe(1)
    await expect(startPreviewGateway({ source: echo, projectId, token: previewToken, port }, { call: f.call })).rejects.toMatchObject({ code: 'conflict' })
    const g = await connected(await startPreviewGateway({ source: echo, projectId: randomUUID(), token: previewToken, port }, { call: f.call }))
    const call = vi.fn(f.call)
    await expect(startPreviewGateway({ source: echo, projectId: randomUUID(), token: previewToken, port }, { call })).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(call).not.toHaveBeenCalled(); await g.service.close()
  })

  it('propagates admitted W3C parents but rejects invalid parents before touching the backend', async () => {
    const f = await fixture(), call = vi.fn(f.call), g = await connected(await startPreviewGateway({ source: echo, projectId: randomUUID(), token: previewToken }, { call }))
    call.mockClear()
    expect((await g.raw({ operation: 'run', id: randomUUID(), input: 'bad' }, { traceparent: 'invalid' })).status).toBe(400)
    expect(call).not.toHaveBeenCalled()
    const parent = '00-11111111111111111111111111111111-2222222222222222-01'
    expect((await g.raw({ operation: 'run', id: randomUUID(), input: 'traced' }, { traceparent: parent })).status).toBe(200)
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ operation: 'projects.run' }), parent)
    await g.operation({ operation: 'runs' })
    expect(call.mock.calls.at(-1)?.[1]).toBeUndefined()
  })

  it.each([
    { 'preview-token-file': undefined }, { 'project-id': undefined }, { 'project-id': 'invalid' },
    { 'data-dir': '/unused' }, { 'telemetry-file': '/unused' }, { runtime: 'local' }, { runtime: 'unknown' }, { port: '65536' },
  ])('rejects mixed or incomplete CLI choices before owner access: %j', async override => {
    const f = await fixture()
    await expect(startPreviewFromCli(echo, { ...f.values, ...override })).rejects.toThrow()
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.inspect).not.toHaveBeenCalled()
  })
  it('refuses reusing the management bearer as the browser bootstrap credential before owner access', async () => {
    const f = await fixture()
    await expect(startPreviewFromCli(echo, { ...f.values, 'preview-token-file': f.values['token-file'] })).rejects.toThrow(/distinct preview token/)
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('rejects malformed project receipts and nonadvancing, unordered or oversized list pages', async () => {
    const call = vi.fn().mockResolvedValue({ id: randomUUID(), generation: 1, acceptedRevision: '0'.repeat(64) })
    await expect(PreviewSession.create({ call }, echo, randomUUID())).rejects.toMatchObject({ code: 'corrupt' })
    const f = await fixture(), rows = { schemaVersion: 2, runs: [] as any[], nextCursor: randomUUID() }
    const session = await PreviewSession.create({ call: command => command.operation === 'runs.list' ? Promise.resolve(rows) : f.call(command) }, echo)
    await expect(session.operation({ operation: 'runs' })).rejects.toMatchObject({ code: 'corrupt' })
    const row = { id: randomUUID(), revision: session.pin.revision, project: { id: session.pin.id, generation: 1 } }
    rows.runs = [row, row]; rows.nextCursor = row.id
    await expect(session.operation({ operation: 'runs' })).rejects.toMatchObject({ code: 'corrupt' })
    rows.runs = Array.from({ length: 201 }, () => row)
    await expect(session.operation({ operation: 'runs' })).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('enumerates later pages before filtering and rejects pinned-project generation drift', async () => {
    const f = await fixture(), projectId = randomUUID(), revision = (await import('../src/preview/index.ts')).renderPreview(echo).data.revision!
    const ids = Array.from({ length: 3 }, () => randomUUID()).sort(), foreign = randomUUID()
    const pages = [
      { schemaVersion: 2, runs: [{ id: ids[0], project: { id: foreign, generation: 1 }, revision },
        { id: ids[1], project: { id: projectId, generation: 2 }, revision }], nextCursor: ids[1] },
      { schemaVersion: 2, runs: [{ id: ids[2], project: { id: projectId, generation: 1 }, revision }], nextCursor: null },
    ]
    const calls: RuntimeOperation[] = []
    const session = await PreviewSession.create({ call: async command => {
      calls.push(command); return command.operation === 'runs.list' ? pages.shift() : f.call(command)
    } }, echo, projectId)
    expect(await session.operation({ operation: 'runs' })).toEqual({ runs: [{ id: ids[2], project: { id: projectId, generation: 1 }, revision }] })
    expect(calls.at(-1)).toEqual({ operation: 'runs.list', page: { limit: 200, after: ids[1] } })
    const exposedPin = session.pin; exposedPin.id = foreign
    expect(session.pin.id).toBe(projectId)
  })

  it('drains admitted gateway calls without invoking a backend close or cancelling the retained run', async () => {
    const f = await fixture(), closeOwner = vi.fn()
    let release!: () => void, admitted!: () => void
    const waiting = new Promise<void>(resolve => { admitted = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const owner = { close: closeOwner, async call(command: RuntimeOperation) {
      const result = await f.call(command)
      if (command.operation === 'projects.run') { admitted(); await gate }
      return result
    } }
    const g = await connected(await startPreviewGateway({ source: echo, projectId: randomUUID(), token: previewToken }, owner))
    const id = randomUUID(), response = g.raw({ operation: 'run', id, input: 'not cancelled' })
    await waiting
    try { expect(await g.service.close(1)).toMatchObject({ status: 'draining' }); expect(closeOwner).not.toHaveBeenCalled() }
    finally { release() }
    expect((await response).status).toBe(200); await g.service.closed
    expect(closeOwner).not.toHaveBeenCalled()
    expect((await f.call({ operation: 'runs.show', id })).output).toBe('not cancelled')
  })
})
