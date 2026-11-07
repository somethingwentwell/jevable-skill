import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalRuntime } from '../src/runtime/local.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { reviewAutomaticApprovalPolicy } from '../src/notifications/automatic-policy.ts'
import { notificationSha256 } from '../src/notifications/schema.ts'
import { automaticDiagnostic, automaticDiagnosticPage, inspectAutomaticDiagnosticPage, automaticDiagnosticStatusSchema } from '../src/notifications/automatic-diagnostics.ts'
import { dispatchOperation } from '../src/http/operations.ts'
import { ReleaseSession } from '../src/releases/service-session.ts'
import { startRuntimeService } from '../src/http/service.ts'
import { RuntimeClient } from '../src/http/client.ts'
import { ReleaseClient } from '../src/releases/client.ts'
import { PreviewSession } from '../src/preview/session.ts'
import { runReleaseApp, type ReleaseBackend } from '../src/releases/app.ts'
import { main } from '../src/cli.ts'
import { createTlsFixture, fixturePort } from '../scripts/tls-fixture.mjs'

const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function cli(...args: string[]) {
  let out = '', err = ''
  const exit = await main(args, { out: value => { out += value }, err: value => { err += value } })
  return { exit, result: out ? JSON.parse(out) : undefined, error: err ? JSON.parse(err) : undefined }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-auto-diagnostics-')), dataDirectory = join(directory, 'state'), received: string[] = []
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    received.push(Buffer.concat(chunks).toString('utf8')); response.writeHead(202); response.end()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('fixture port')
  const endpoint = { id: 'review', url: `http://127.0.0.1:${address.port}/PRIVATE_DESTINATION`, credentialRef: 'private/key', timeoutMs: 1000 }
  let owner = await LocalRuntime.open({ dataDirectory })
  const releases = ['1.0.0', '2.0.0'].map(version => {
    const project = owner.editProject({ operation: 'create', title: 'PRIVATE_TITLE', yaml, actor: 'PRIVATE_ACTOR' })
    return owner.createRelease({ projectId: project.id, expectedGeneration: project.generation, revision: project.acceptedRevision,
      version, runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) }, actor: 'PRIVATE_CREATOR' })
  })
  await owner.setCredential(endpoint.credentialRef, 'whsec_' + randomBytes(32).toString('base64'), 0, 'PRIVATE_ACTOR')
  await owner.close()
  const review = reviewAutomaticApprovalPolicy({ format: 'jevable.ai/automatic-approval-policy/v1', routes: releases.map(release => ({
    scope: { kind: 'release', id: release.snapshot.id, sha256: release.sha256, revision: release.snapshot.workflow.revision },
    endpointId: endpoint.id, endpointSha256: notificationSha256(endpoint), eventKinds: ['requested'],
  })) })
  const notifications = { endpoints: [endpoint], automatic: { policy: review.policy, reviewedPolicySha256: review.policySha256 } }
  owner = await LocalRuntime.open({ dataDirectory, notifications })
  for (let index = 0; index < 3; index++) for (const release of releases) await owner.runRelease(release.snapshot, { message: 'PRIVATE_REVIEW' })
  await owner.close()
  owner = await LocalRuntime.open({ dataDirectory }); cleanup.push(() => owner.close())
  const raw = (await owner.automaticApprovalAdmissions()).records
  expect(raw).toHaveLength(6); expect(received).toHaveLength(6)
  const own = releases[0]!, foreign = releases[1]!, scope = { id: own.snapshot.id, sha256: own.sha256, revision: own.snapshot.workflow.revision }
  const reader = { get: (id: string) => owner.automaticApprovalAdmission(id), page: (page: any) => owner.automaticApprovalAdmissions(page) }
  const history = async () => Promise.all(owner.list().map(async run => ({ run: await owner.show(run.id), events: await owner.events(run.id) })))
  return { directory, dataDirectory, owner, raw, received, own, foreign, scope, reader, history, notifications }
}

describe('public automatic diagnostic projection and bounded release pages', () => {
  it('excludes full policy, foreign routes, destinations and review data from exact-release reads', async () => {
    const f = await fixture(), before = await f.history(), page = await automaticDiagnosticPage(f.reader, { limit: 2 }, f.scope)
    expect(page.admissions).toHaveLength(2); expect(page.nextCursor).toBe(page.admissions[1]!.request.requestId)
    const tail = await automaticDiagnosticPage(f.reader, { after: page.nextCursor!, limit: 2 }, f.scope)
    expect(tail.admissions).toHaveLength(1); expect(tail.nextCursor).toBeNull()
    for (const value of [page, tail]) {
      const encoded = JSON.stringify(value)
      expect(encoded).not.toMatch(/PRIVATE_|whsec_|credentialRef|"routes"|"destinations"|"event"/)
      expect(encoded).not.toContain(f.foreign.snapshot.id)
      expect(inspectAutomaticDiagnosticPage(value, { limit: 2 })).toEqual(value)
    }
    expect(await f.history()).toEqual(before); expect(f.received).toHaveLength(6)
  })
  it('refuses foreign cursors and exact release lookups without returning their policy metadata', async () => {
    const f = await fixture(), other = f.raw.find(record => record.event.data.release?.id === f.foreign.snapshot.id)!
    await expect(automaticDiagnosticPage(f.reader, { after: other.request.requestId }, f.scope)).rejects.toHaveProperty('code', 'not-found')
    const session = new ReleaseSession({ storage: 'sqlite', runtime: f.owner }, f.own.snapshot, 'fixture')
    await expect(session.operation({ operation: 'notifications.automatic-show', requestId: other.request.requestId,
      releaseSha256: f.own.sha256 })).rejects.toHaveProperty('code', 'not-found')
    expect(f.received).toHaveLength(6)
  })
  it('returns detached metadata and refuses forged selected-owner pages', async () => {
    const f = await fixture(), expected = automaticDiagnostic(f.raw[0]!), page = await automaticDiagnosticPage(f.reader, { limit: 2 })
    const changed = structuredClone(expected); changed.request.runId = randomUUID()
    expect(automaticDiagnostic(f.raw[0]!)).toEqual(expected)
    for (const mutate of [
      (p: any) => { p.admissions.push(p.admissions[0]) },
      (p: any) => { p.nextCursor = randomUUID() },
      (p: any) => { p.admissions[0].policy = f.raw[0]!.policy },
      (p: any) => { p.admissions[0].request.url = 'PRIVATE_SUBSTITUTION' },
      (p: any) => { p.admissions[0].request.redeliverOf = randomUUID() },
    ]) {
      const value = structuredClone(page); mutate(value); expect(() => inspectAutomaticDiagnosticPage(value, { limit: 2 })).toThrow()
    }
  })
  it.each(['unordered', 'duplicate', 'missing-cursor', 'wrong-cursor'] as const)('refuses corrupt %s backend batches', async damage => {
    const f = await fixture(), records = structuredClone(f.raw), page: any = { records, nextCursor: null }
    if (damage === 'unordered') records.reverse()
    if (damage === 'duplicate') records.push(records.at(-1)!)
    if (damage === 'missing-cursor') delete page.nextCursor
    if (damage === 'wrong-cursor') page.nextCursor = randomUUID()
    await expect(automaticDiagnosticPage({ ...f.reader, page: async () => page }, {})).rejects.toHaveProperty('code', 'corrupt')
  })
})

describe('actual source CLI and authenticated HTTP diagnostics', () => {
  it('source workflow-app reads are scoped, policy-free and never resend', async () => {
    const f = await fixture(), before = await f.history(); await f.owner.close()
    const open = vi.fn(() => LocalRuntime.open({ dataDirectory: f.dataDirectory }))
    const backend: ReleaseBackend = { storage: 'sqlite', open, serve: async () => { throw Error('unexpected server') } }
    const commandFile = join(f.directory, 'diagnostic-command.json')
    const invoke = async (command: object) => {
      await writeFile(commandFile, JSON.stringify(command))
      let out = '', err = ''
      const exit = await runReleaseApp(backend, f.own.snapshot, ['notify', commandFile], f.directory,
        { out: value => { out += value }, err: value => { err += value } })
      return { exit, result: out ? JSON.parse(out) : undefined, error: err ? JSON.parse(err) : undefined }
    }
    expect(await invoke({ operation: 'notifications.automatic-status' })).toMatchObject({ exit: 0,
      result: { schemaVersion: 1, configured: false, live: null } })
    const page = await invoke({ operation: 'notifications.automatic-list', page: { limit: 2 } })
    expect(page.exit).toBe(0); expect(page.result.admissions).toHaveLength(2)
    expect(JSON.stringify(page.result)).not.toContain(f.foreign.snapshot.id)
    const shown = await invoke({ operation: 'notifications.automatic-show', requestId: page.result.admissions[0].request.requestId })
    expect(shown.exit).toBe(0); expect(shown.result).toEqual(page.result.admissions[0])
    const foreign = f.raw.find(record => record.event.data.release?.id === f.foreign.snapshot.id)!
    expect(await invoke({ operation: 'notifications.automatic-show', requestId: foreign.request.requestId }))
      .toMatchObject({ exit: 1, error: { code: 'not-found' } })
    expect(open).toHaveBeenCalledTimes(4)
    const owner = await LocalRuntime.open({ dataDirectory: f.dataDirectory }); cleanup.push(() => owner.close())
    expect(await Promise.all(owner.list().map(async run => ({ run: await owner.show(run.id), events: await owner.events(run.id) })))).toEqual(before)
    expect(f.received).toHaveLength(6)
  })
  it('source workflow-app refuses diagnostic configuration before opening an owner', async () => {
    const f = await fixture(), open = vi.fn(), serve = vi.fn()
    const commandFile = join(f.directory, 'diagnostic-command.json')
    await writeFile(commandFile, JSON.stringify({ operation: 'notifications.automatic-status' }))
    let err = ''
    const exit = await runReleaseApp({ storage: 'sqlite', open, serve }, f.own.snapshot,
      ['notify', commandFile, '--notifications-file', '/not/read.json'], f.directory,
      { out: () => { throw Error('unexpected output') }, err: value => { err += value } })
    expect(exit).toBe(2); expect(JSON.parse(err)).toMatchObject({ code: 'invalid-command' })
    expect(open).not.toHaveBeenCalled(); expect(serve).not.toHaveBeenCalled(); expect(f.received).toHaveLength(6)
  })
  it('reads retained admissions through the actual local CLI with no configuration or sends', async () => {
    const f = await fixture(); await f.owner.close()
    const status = await cli('approvals', 'notify', 'automatic-status', '--data-dir', f.dataDirectory)
    expect(status.exit).toBe(0); expect(status.result).toEqual({ schemaVersion: 1, configured: false, live: null })
    const page = await cli('approvals', 'notify', 'automatic-list', '--page', '--limit', '2', '--data-dir', f.dataDirectory)
    expect(page.exit).toBe(0); expect(page.result.admissions).toHaveLength(2)
    const shown = await cli('approvals', 'notify', 'automatic-show', page.result.admissions[0].request.requestId, '--data-dir', f.dataDirectory)
    expect(shown.exit).toBe(0); expect(shown.result).toEqual(page.result.admissions[0]); expect(f.received).toHaveLength(6)
  })
  it('actual management and exact-release HTTP pages preserve scope and do not resend', async () => {
    const f = await fixture(), before = await f.history(); await f.owner.close()
    const token = randomBytes(32).toString('hex'), options = { token, actor: 'fixture', runtime: { dataDirectory: f.dataDirectory } }
    const tls = await createTlsFixture(f.directory), port = await fixturePort()
    const management = await startRuntimeService({ ...options, runtime: { ...options.runtime, notifications: f.notifications }, port,
      tls: { publicOrigin: `https://127.0.0.1:${port}`, bindAddress: '127.0.0.1', certificateFile: tls.cert, privateKeyFile: tls.key } }); cleanup.push(() => management.close())
    const client = new RuntimeClient(management.url, token, 3000, 20_000_000, { ca: tls.ca })
    const page: any = (await client.operation({ operation: 'notifications.automatic-list', page: { limit: 2 } }) as any).result
    expect(page.admissions).toHaveLength(2)
    const status: any = (await client.operation({ operation: 'notifications.automatic-status' }) as any).result
    expect(automaticDiagnosticStatusSchema.parse(status).configured).toBe(true)
    expect((await client.capabilities() as any).api.operations.approvalNotifications.automaticDelivery).toBe(true)
    const tokenFile = join(f.directory, 'owner-token'); await writeFile(tokenFile, token, { mode: 0o600 })
    const selected = ['--endpoint', management.url, '--token-file', tokenFile, '--instance-id', management.instanceId, '--ca-file', tls.cert]
    const remote = await cli('approvals', 'notify', 'automatic-list', '--page', '--limit', '2', ...selected)
    expect(remote.exit).toBe(0); expect(remote.result).toEqual(page)
    const live = await cli('approvals', 'notify', 'automatic-status', ...selected)
    expect(live.exit).toBe(0); expect(live.result.configured).toBe(true)
    await management.close()
    const service = await startRuntimeService({ ...options, release: { snapshot: f.own.snapshot } }); cleanup.push(() => service.close())
    const scoped = new ReleaseClient(service.url, token, f.own.sha256)
    const own: any = (await scoped.operation({ operation: 'notifications.automatic-list', page: {} }) as any).result
    expect(own.admissions).toHaveLength(3)
    expect(JSON.stringify(own)).not.toContain(f.foreign.snapshot.id)
    const other = f.raw.find(record => record.event.data.release?.id === f.foreign.snapshot.id)!
    await expect(scoped.operation({ operation: 'notifications.automatic-show', requestId: other.request.requestId })).rejects.toHaveProperty('code', 'not-found')
    await service.close()
    const owner = await LocalRuntime.open({ dataDirectory: f.dataDirectory }); cleanup.push(() => owner.close())
    expect(await Promise.all(owner.list().map(async run => ({ run: await owner.show(run.id), events: await owner.events(run.id) })))).toEqual(before)
    expect(f.received).toHaveLength(6)
  })
  it.each([
    ['automatic-list'], ['automatic-show', 'not-a-uuid'], ['automatic-status', '--notifications-file', '/not/read.json'],
    ['automatic-list', '--page', '--limit', '201'], ['automatic-status', '--send'],
  ].map(args => ({ args })))('CLI refuses malformed diagnostic admission before state/configuration I/O: $args', async ({ args }) => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-auto-diagnostic-refusal-')), dataDirectory = join(directory, 'unopened')
    const result = await cli('approvals', 'notify', ...args, '--data-dir', dataDirectory)
    expect(result.exit).toBe(2); await expect(stat(dataDirectory)).rejects.toHaveProperty('code', 'ENOENT')
  })
  it('preview does not gain automatic diagnostics and strict API bodies cannot configure or dispatch', async () => {
    const f = await fixture(), call = vi.fn((command: any) => dispatchOperation({ storage: 'sqlite', runtime: f.owner }, command, 'fixture'))
    const preview = await PreviewSession.create({ call }, yaml)
    call.mockClear()
    for (const operation of ['notifications.automatic-status', 'notifications.automatic-show', 'notifications.automatic-list']) {
      await expect(preview.operation({ operation })).rejects.toHaveProperty('code', 'invalid-command')
      await expect(dispatchOperation({ storage: 'sqlite', runtime: {} as never }, { operation, actor: 'spoof', policy: {} }, 'fixture'))
        .rejects.toHaveProperty('code', 'invalid-command')
    }
    expect(call).not.toHaveBeenCalled(); expect(f.received).toHaveLength(6)
  })
})
