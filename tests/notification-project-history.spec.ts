import { afterEach, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime } from '../src/runtime/index.ts'
import { RuntimeClient, startRuntimeService } from '../src/http/index.ts'
import { runtimeOperationSchema } from '../src/http/operations.ts'
import { ReleaseSession } from '../src/releases/service-session.ts'
import { operationCapabilities } from '../src/http/operation-host.ts'
import { SQLiteNotificationStore, initializeNotificationTables } from '../src/notifications/sqlite-store.ts'
import { inspectNotificationRecord, notificationSha256, type NotificationRecord } from '../src/notifications/schema.ts'
import { notificationPage, inspectNotificationPage } from '../src/notifications/history.ts'
import { projectNotificationRecords, inspectProjectNotificationPage, type NotificationProjectScope } from '../src/notifications/project-history.ts'
import { main } from '../src/cli.ts'

const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const identity = (i: number) => i.toString(16).padStart(8, '0') + '-0000-4000-8000-000000000000'
function record(i: number, project?: NotificationProjectScope): NotificationRecord {
  const pin = { runId: randomUUID(), revision: project?.revision ?? 'a'.repeat(64), attemptId: randomUUID() }
  const core = { source: 'urn:jevable:workflow-runtime', type: 'ai.jevable.approval.requested', time: '2026-10-01T00:00:00.000Z',
    data: { ...pin, nodeId: 'PRIVATE_REVIEW', expiresAt: '2026-10-02T00:00:00.000Z',
      ...(project ? { project: { id: project.id, generation: project.generation } } : {}) } }
  const event = { specversion: '1.0', id: notificationSha256(core), source: core.source, type: core.type,
    time: core.time, datacontenttype: 'application/json', data: core.data }
  return inspectNotificationRecord({ schemaVersion: 1, request: { ...pin, requestId: identity(i), endpointId: 'review',
    endpointSha256: 'b'.repeat(64), eventSha256: notificationSha256(event) }, event, actor: 'PRIVATE_ACTOR',
    createdAt: '2026-10-01T01:00:00.000Z', credentialGeneration: 1, outcome: { status: 'pending' } })
}
async function cli(...args: string[]) {
  let out = '', err = ''
  const exit = await main(args, { out: text => { out += text }, err: text => { err += text } })
  return { exit, result: out ? JSON.parse(out) : undefined, error: err ? JSON.parse(err) : undefined }
}

describe('exact historical project notification history', () => {
  it('filters sparse SQLite keysets without writes, foreign cursors or private bodies', async () => {
    const db = new DatabaseSync(':memory:'); initializeNotificationTables(db)
    const store = new SQLiteNotificationStore(db, { maxDeliveries: 1000, maxEvents: 2000 })
    const scope = { id: randomUUID(), generation: 2, revision: 'a'.repeat(64) }, selected: NotificationRecord[] = []
    try {
      for (let i = 0; i < 407; i++) {
        const r = record(i, [0, 203, 406].includes(i) ? scope : i % 2 ? { ...scope, generation: 1 } : undefined)
        store.createIntent(r); if ([0, 203, 406].includes(i)) selected.push(r)
      }
      const before = db.prepare('SELECT total_changes() AS n').get()
      const first = await projectNotificationRecords(store, scope, { limit: 2 })
      expect(first).toEqual({ records: selected.slice(0, 2), nextCursor: selected[1]!.request.requestId })
      expect(await projectNotificationRecords(store, scope, { after: first.nextCursor!, limit: 2 }))
        .toEqual({ records: selected.slice(2), nextCursor: null })
      for (const other of [{ ...scope, id: randomUUID() }, { ...scope, generation: 3 }, { ...scope, revision: 'c'.repeat(64) }])
        expect(await projectNotificationRecords(store, other, {})).toEqual({ records: [], nextCursor: null })
      for (const after of [identity(1), identity(2), randomUUID()])
        await expect(projectNotificationRecords(store, scope, { after })).rejects.toHaveProperty('code', 'not-found')
      const page = { ...notificationPage(first.records, first.nextCursor, { limit: 2 }), project: scope }
      expect(inspectProjectNotificationPage(page, scope, { limit: 2 })).toEqual(page)
      expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|credentialGeneration|actor|event"/)
      expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
    } finally { db.close() }
  })

  it.each([{ id: 'bad', generation: 1, revision: 'a'.repeat(64) },
    { id: randomUUID(), generation: 0, revision: 'a'.repeat(64) },
    { id: randomUUID(), generation: 1.5, revision: 'a'.repeat(64) },
    { id: randomUUID(), generation: Number.MAX_SAFE_INTEGER + 1, revision: 'a'.repeat(64) },
    { id: randomUUID(), generation: 1, revision: 'bad' },
    { id: randomUUID(), generation: 1, revision: 'a'.repeat(64), actor: 'override' }])('refuses malformed scope before storage %#', async scope => {
    let reads = 0
    const reader = { get: () => { reads++; return undefined }, page: () => { reads++; return { records: [], nextCursor: null } } }
    await expect(projectNotificationRecords(reader, scope, {})).rejects.toHaveProperty('code', 'invalid-command')
    expect(reads).toBe(0)
  })

  it('detaches scope/page before the first asynchronous read and refuses mismatched cursor identities', async () => {
    const scope = { id: randomUUID(), generation: 1, revision: 'a'.repeat(64) }, expected = structuredClone(scope)
    const options = { after: identity(0), limit: 1 }, r = record(0, scope), next = record(1, scope)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const reader = { get: async () => { entered.resolve(); await release.promise; return r },
      page: () => ({ records: [next], nextCursor: null }) }
    const pending = projectNotificationRecords(reader, scope, options)
    await entered.promise; scope.generation = 2; options.limit = 200; options.after = randomUUID(); release.resolve()
    expect(await pending).toEqual({ records: [next], nextCursor: null })
    await expect(projectNotificationRecords({ ...reader, get: () => next }, expected, { after: identity(0) }))
      .rejects.toHaveProperty('code', 'corrupt')
  })

  it.each(['scope', 'private', 'order', 'cursor'])('rejects a malformed scoped remote receipt: %s', damage => {
    const scope = { id: randomUUID(), generation: 1, revision: 'a'.repeat(64) }
    const page = { ...notificationPage([record(0, scope), record(1, scope)], null, { limit: 2 }), project: scope }
    const bad = structuredClone(page)
    if (damage === 'scope') bad.project.generation++
    if (damage === 'private') Object.assign(bad.deliveries[0]!, { actor: 'private' })
    if (damage === 'order') bad.deliveries.reverse()
    if (damage === 'cursor') bad.nextCursor = randomUUID()
    expect(() => inspectProjectNotificationPage(bad, scope, { limit: 2 })).toThrow()
  })

  it('requires strict API scope/page, advertises both backends, and does not expand release authority', async () => {
    const project = { id: randomUUID(), generation: 1, revision: 'a'.repeat(64) }
    const operation = { operation: 'notifications.project-list', project, page: {} }
    expect(runtimeOperationSchema.safeParse(operation).success).toBe(true)
    for (const bad of [{ operation: operation.operation, page: {} }, { ...operation, page: undefined },
      { ...operation, actor: 'override' }, { ...operation, project: { ...project, releaseId: randomUUID() } }])
      expect(runtimeOperationSchema.safeParse(bad).success).toBe(false)
    await expect(ReleaseSession.prototype.operation.call({ pin: { sha256: 'b'.repeat(64) } } as unknown as ReleaseSession,
      { ...operation, releaseSha256: 'b'.repeat(64) })).rejects.toHaveProperty('code', 'invalid-command')
    for (const storage of ['sqlite', 'postgres'] as const)
      expect(operationCapabilities(storage).approvalNotifications.projectHistory.operation).toBe(operation.operation)
  })

  it.each([['--project-id', randomUUID()], ['--generation', '1'], ['--revision', 'a'.repeat(64)],
    ['--project-id', randomUUID(), '--generation', '01', '--revision', 'a'.repeat(64)],
    ['--project-id', randomUUID(), '--generation', '9007199254740992', '--revision', 'a'.repeat(64)]].map(flags => ({ flags })))
    ('refuses partial or noncanonical CLI scope before opening unavailable storage %#', async ({ flags }) => {
      expect((await cli('approvals', 'notify', 'list', '--page', ...flags, '--data-dir', '/unavailable/project-notification-state', '--json')).exit).toBe(2)
    })

  it('reads original project provenance through SDK, reopened CLI and real HTTP without delivery or workflow mutations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-project-notification-')), dataDirectory = join(directory, 'state')
    let received = 0
    const receiver = createServer((request, reply) => { received++; request.resume(); reply.writeHead(202); reply.end() })
    await new Promise<void>((resolve, reject) => { receiver.once('error', reject); receiver.listen(0, '127.0.0.1', resolve) })
    cleanup.push(() => new Promise<void>(resolve => { receiver.closeAllConnections(); receiver.close(() => resolve()) }))
    const address = receiver.address(); if (!address || typeof address === 'string') throw Error('missing receiver')
    const endpoint = { id: 'review', url: `http://127.0.0.1:${address.port}`, credentialRef: 'review/key', timeoutMs: 1000 }
    let runtime = await LocalRuntime.open({ dataDirectory, notifications: { endpoints: [endpoint] } })
    cleanup.push(() => runtime.close())
    runtime.setCredential(endpoint.credentialRef, 'whsec_' + randomBytes(32).toString('base64'), 0, 'operator')
    const projects = [runtime.editProject({ operation: 'create', id: randomUUID(), title: 'Original', yaml, actor: 'operator' }),
      runtime.editProject({ operation: 'create', id: randomUUID(), title: 'Foreign', yaml, actor: 'operator' })]
    const requests: string[] = [], runs = []
    for (const project of projects) {
      const run = await runtime.runProject(project.id, project.generation, project.acceptedRevision, { message: 'PRIVATE_REVIEW' })
      if (run.state.status !== 'waiting') throw Error('missing approval')
      const { event: _event, delivery: _delivery, ...pin } = await runtime.prepareApprovalNotification({ runId: run.id,
        revision: run.revision, attemptId: run.state.attempt.id }, endpoint.id)
      const requestId = randomUUID(); await runtime.sendApprovalNotification({ ...pin, requestId }, 'operator')
      requests.push(requestId); runs.push(run)
    }
    const original = projects[0]!, project = { id: original.id, generation: original.generation, revision: original.acceptedRevision }
    runtime.editProject({ operation: 'rename', id: original.id, expectedGeneration: original.generation, title: 'Renamed', actor: 'operator' })
    const before = await Promise.all(runs.map(run => runtime.events(run.id))), sends = received
    const page = await runtime.listProjectApprovalNotifications(project, { limit: 1 })
    expect(page.project).toEqual(project); expect(page.deliveries.map(x => x.request.requestId)).toEqual([requests[0]])
    expect(page.nextCursor).toBeNull()
    await expect(runtime.listProjectApprovalNotifications(project, { after: requests[1]! })).rejects.toHaveProperty('code', 'not-found')
    expect((await runtime.listProjectApprovalNotifications({ ...project, generation: 2 }, {})).deliveries).toEqual([])
    expect(await Promise.all(runs.map(run => runtime.events(run.id)))).toEqual(before)
    await runtime.close()
    const result = await cli('approvals', 'notify', 'list', '--page', '--project-id', project.id, '--generation', String(project.generation),
      '--revision', project.revision, '--limit', '1', '--data-dir', dataDirectory, '--json')
    expect(result.exit).toBe(0); expect(result.result).toEqual(page)
    const token = randomBytes(32).toString('hex')
    const service = await startRuntimeService({ runtime: { dataDirectory }, token, actor: 'test-host' })
    cleanup.push(() => service.close())
    const client = new RuntimeClient(service.url, token)
    const call = async (command: Parameters<typeof client.operation>[0]) => (await client.operation(command) as { result: unknown }).result
    expect(await call({ operation: 'notifications.project-list', project, page: { limit: 1 } })).toEqual(page)
    expect(inspectNotificationPage(await call({ operation: 'notifications.list', page: {} }), {}).deliveries).toHaveLength(2)
    for (const [i, run] of runs.entries()) expect(await call({ operation: 'runs.events', id: run.id }))
      .toMatchObject({ events: before[i]!.map(({ sequence, kind, at }) => ({ sequence, kind, at })) })
    expect(received).toBe(sends)
    await service.close()
    runtime = await LocalRuntime.open({ dataDirectory })
    expect(await Promise.all(runs.map(run => runtime.show(run.id)))).toEqual(runs)
  })
})
