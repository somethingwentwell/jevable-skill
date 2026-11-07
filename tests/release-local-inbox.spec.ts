import { afterEach, describe, expect, it, vi } from 'vitest'
import { access, chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CORE_VERSION } from '../src/capabilities.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { runReleaseApp, type ReleaseBackend } from '../src/releases/app.ts'
import { sqliteReleaseBackend } from '../src/releases/entry.ts'
import { acquireReleaseLocalInboxLock, loadReleaseLocalInbox } from '../src/releases/local-inbox.ts'
import { releaseMessageRunId } from '../src/releases/messages.ts'
import { traceRecords } from '../scripts/check-postgres-telemetry.mjs'
import { logRecords } from '../scripts/check-telemetry-package.mjs'

const execute = promisify(execFile)
const api = await readFile(new URL('../examples/api-echo.yaml', import.meta.url), 'utf8')
const approval = (await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')).replace('modes: [manual]', 'modes: [api]')
afterEach(() => vi.restoreAllMocks())
const capture = () => {
  let out = '', err = ''
  return { io: { out: (value: string) => { out += value }, err: (value: string) => { err += value } },
    out: () => out ? JSON.parse(out) : undefined, err: () => err ? JSON.parse(err) : undefined }
}
async function fixture(yaml = api) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-local-inbox-')), author = await LocalRuntime.open({ dataDirectory: join(directory, 'author') })
  let release
  try {
    const project = author.editProject({ operation: 'create', yaml, title: 'Private local inbox fixture', actor: 'fixture:author' })
    release = author.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
      version: '1.0.0', actor: 'fixture:author', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  } finally { await author.close() }
  // The scheduler spawns <directory>/app.mjs for each delivery; this wrapper is the
  // source-test stand-in for the exported launcher and runs the same release entry.
  await writeFile(join(directory, 'app.mjs'), `import { readFileSync } from 'node:fs'
import { releaseMain } from '${new URL('../src/releases/entry.ts', import.meta.url).href}'
const release = JSON.parse(readFileSync(new URL('release.json', import.meta.url), 'utf8')).snapshot
process.exitCode = await releaseMain(release, process.argv.slice(2), new URL('.', import.meta.url).pathname)
`, { mode: 0o600 })
  await writeFile(join(directory, 'release.json'), JSON.stringify({ snapshot: release.snapshot }), { mode: 0o600 })
  const event = { format: 'jevable.ai/local-release-event', version: 1,
    release: { id: release.snapshot.id, sha256: release.sha256, revision: release.snapshot.workflow.revision },
    source: 'local/orders', messageId: 'PRIVATE_INBOX_001', input: 'PRIVATE_INPUT' }
  const path = join(directory, 'event.json'), state = join(directory, 'state'), inbox = join(directory, 'inbox')
  const save = async (value: unknown) => { const bytes = JSON.stringify(value); await writeFile(path, bytes, { mode: 0o600 }); return createHash('sha256').update(bytes).digest('hex') }
  const sha256 = await save(event)
  const invoke = async (args: string[], backend: ReleaseBackend = sqliteReleaseBackend) => {
    const result = capture(), code = await runReleaseApp(backend, release.snapshot, args, directory, result.io)
    return { code, out: result.out(), err: result.err() }
  }
  return { directory, release, event, path, state, inbox, sha256, save, invoke,
    flags: ['--data-dir', state], expectedId: releaseMessageRunId({ release: event.release, source: event.source, messageId: event.messageId }) }
}

describe('durable local event inbox and drain-once scheduler', () => {
  it('queues an admitted event idempotently without opening storage and keeps the command stateless', async () => {
    const f = await fixture(), open = vi.fn(), serve = vi.fn()
    const backend = { storage: 'sqlite', open, serve } as unknown as ReleaseBackend
    const queued = await f.invoke(['event-inbox', f.path, '--inbox', f.inbox], backend)
    expect(queued).toMatchObject({ code: 0, out: { status: 'queued', eventSha256: f.sha256, runId: f.expectedId, state: 'pending', attempts: 0, execution: 'not-started' } })
    expect(await f.invoke(['event-inbox', f.path, '--inbox', f.inbox], backend)).toMatchObject({ code: 0, out: { status: 'already-queued', state: 'pending', attempts: 0 } })
    expect((await f.invoke(['event-inbox', f.path, '--inbox', f.inbox, ...f.flags], backend)).code).toBe(2)
    expect((await f.invoke(['event-inbox', f.path], backend)).code).toBe(2)
    await f.save({ ...f.event, version: 2 })
    expect((await f.invoke(['event-inbox', f.path, '--inbox', f.inbox], backend)).code).toBe(2)
    await f.save(f.event)
    expect(open).not.toHaveBeenCalled(); expect(serve).not.toHaveBeenCalled()
    const { entries } = await loadReleaseLocalInbox(f.inbox)
    expect(entries).toHaveLength(1); expect(entries[0]!.record.state).toBe('pending')
  })

  it('drains one echo event through a real child process, acks it and exits after the pass', async () => {
    const f = await fixture()
    await f.invoke(['event-inbox', f.path, '--inbox', f.inbox])
    const drained = await f.invoke(['scheduler', '--inbox', f.inbox, ...f.flags])
    expect(drained).toMatchObject({ code: 0, out: { status: 'drained', counts: { entries: 1, acked: 1, observed: 0, replayable: 0, terminal: 0 },
      entries: [{ eventSha256: f.sha256, runId: f.expectedId, state: 'acked', attempts: 1, status: 'completed' }] } })
    const owner = await LocalRuntime.open({ dataDirectory: f.state })
    try { expect(owner.list()).toHaveLength(1); expect((await owner.show(f.expectedId)).state.status).toBe('completed') }
    finally { await owner.close() }
    const again = await f.invoke(['scheduler', '--inbox', f.inbox, ...f.flags])
    expect(again.out.entries[0]).toMatchObject({ state: 'acked', attempts: 1 })
    const reopened = await LocalRuntime.open({ dataDirectory: f.state })
    try { expect(reopened.list()).toHaveLength(1) } finally { await reopened.close() }
  }, 60_000)

  it('re-observes a waiting approval after its authorized decision and acks the settled terminal state', async () => {
    const f = await fixture(approval), sha256 = await f.save({ ...f.event, input: { message: 'PRIVATE_REVIEW' } })
    await f.invoke(['event-inbox', f.path, '--inbox', f.inbox])
    const waiting = await f.invoke(['scheduler', '--inbox', f.inbox, ...f.flags])
    expect(waiting).toMatchObject({ code: 0, out: { counts: { observed: 1, acked: 0 }, entries: [{ runId: f.expectedId, state: 'observed', status: 'waiting' }] } })
    const owner = await LocalRuntime.open({ dataDirectory: f.state })
    let attemptId: string
    try {
      const state = (await owner.show(f.expectedId)).state
      if (state.status !== 'waiting') throw Error('expected waiting approval')
      attemptId = state.attempt.id
    } finally { await owner.close() }
    await f.invoke(['decide', f.expectedId, '--attempt', attemptId, '--action', 'approve', ...f.flags])
    const settled = await f.invoke(['scheduler', '--inbox', f.inbox, ...f.flags])
    expect(settled.out.entries[0]).toMatchObject({ state: 'acked', status: 'completed' })
    const final = await LocalRuntime.open({ dataDirectory: f.state })
    try {
      expect(final.list()).toHaveLength(1)
      expect((await final.events(f.expectedId)).filter(event => event.kind === 'approval-decided')).toHaveLength(1)
    } finally { await final.close() }
  }, 60_000)

  it('replays an inbox entry after scheduler loss without creating a second run', async () => {
    const f = await fixture()
    await f.invoke(['event-inbox', f.path, '--inbox', f.inbox])
    // Model a scheduler crash after its child delivered but before any record write.
    expect((await f.invoke(['event', f.path, '--event-sha256', f.sha256, ...f.flags])).code).toBe(0)
    const replay = await f.invoke(['scheduler', '--inbox', f.inbox, ...f.flags])
    expect(replay.out.entries[0]).toMatchObject({ state: 'acked', status: 'completed' })
    const owner = await LocalRuntime.open({ dataDirectory: f.state })
    try {
      expect(owner.list()).toHaveLength(1)
      expect((await owner.events(f.expectedId)).filter(event => event.kind === 'run-created')).toHaveLength(1)
    } finally { await owner.close() }
  }, 60_000)

  it('keeps a timed-out delivery replayable under its original identity and acks on the next pass', async () => {
    const f = await fixture()
    await f.invoke(['event-inbox', f.path, '--inbox', f.inbox])
    const timedOut = await f.invoke(['scheduler', '--inbox', f.inbox, '--event-timeout-ms', '1', ...f.flags])
    expect(timedOut.out.entries[0]).toMatchObject({ state: 'pending', attempts: 1, code: 'timeout-uncertain' })
    expect(timedOut.out.counts).toMatchObject({ replayable: 1, acked: 0 })
    const recovered = await f.invoke(['scheduler', '--inbox', f.inbox, ...f.flags])
    expect(recovered.out.entries[0]).toMatchObject({ state: 'acked', status: 'completed' })
    const owner = await LocalRuntime.open({ dataDirectory: f.state })
    try { expect(owner.list()).toHaveLength(1) } finally { await owner.close() }
  }, 60_000)

  it('records a busy child as a replayable attempt instead of competing for the owner', async () => {
    const f = await fixture()
    await f.invoke(['event-inbox', f.path, '--inbox', f.inbox])
    const owner = await LocalRuntime.open({ dataDirectory: f.state })
    let busy
    try { busy = await f.invoke(['scheduler', '--inbox', f.inbox, ...f.flags]) }
    finally { await owner.close() }
    expect(busy).toMatchObject({ code: 0, out: { counts: { replayable: 1 } } })
    expect(busy.out.entries[0]).toMatchObject({ state: 'pending', code: 'busy' })
    const drained = await f.invoke(['scheduler', '--inbox', f.inbox, ...f.flags])
    expect(drained.out.entries[0]).toMatchObject({ state: 'acked', status: 'completed' })
  }, 60_000)

  it('refuses a second live scheduler through the cooperative inbox lock and reclaims a dead owner', async () => {
    const f = await fixture()
    await f.invoke(['event-inbox', f.path, '--inbox', f.inbox])
    const release = await acquireReleaseLocalInboxLock(f.inbox)
    try {
      expect(await f.invoke(['scheduler', '--inbox', f.inbox, ...f.flags])).toMatchObject({ code: 1, err: { code: 'busy' } })
    } finally { await release() }
    // A provably exited lock owner is replaced: write a dead pid lock directly.
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['-e', ''])
    const pid = child.pid!
    await new Promise(resolveExit => child.on('exit', resolveExit))
    await writeFile(join(f.inbox, 'scheduler.lock'), JSON.stringify({ schemaVersion: 1, kind: 'JevableLocalInboxLock', pid, startedAt: new Date().toISOString() }) + '\n', { mode: 0o600 })
    const reclaimed = await f.invoke(['scheduler', '--inbox', f.inbox, ...f.flags])
    expect(reclaimed.out.entries[0]).toMatchObject({ state: 'acked', status: 'completed' })
  }, 60_000)

  it('refuses tampered inbox bytes and public inbox records before any delivery', async () => {
    const f = await fixture()
    await f.invoke(['event-inbox', f.path, '--inbox', f.inbox])
    const entry = join(f.inbox, f.sha256 + '.event')
    await writeFile(entry, JSON.stringify({ ...f.event, input: 'TAMPERED' }), { mode: 0o600 })
    expect(await f.invoke(['scheduler', '--inbox', f.inbox, ...f.flags])).toMatchObject({ code: 1, err: { code: 'corrupt' } })
    await writeFile(entry, JSON.stringify(f.event), { mode: 0o600 })
    await chmod(join(f.inbox, f.sha256 + '.json'), 0o644)
    expect(await f.invoke(['scheduler', '--inbox', f.inbox, ...f.flags])).toMatchObject({ code: 2, err: { code: 'invalid-command' } })
    await chmod(join(f.inbox, f.sha256 + '.json'), 0o600)
  }, 60_000)

  it('drains interval-mode passes and stops on SIGINT with a draining receipt and a released lock', async () => {
    const f = await fixture()
    await f.invoke(['event-inbox', f.path, '--inbox', f.inbox])
    const child = spawn(process.execPath, ['--experimental-transform-types', join(f.directory, 'app.mjs'),
      'scheduler', '--inbox', f.inbox, ...f.flags, '--interval-seconds', '1'],
      { env: { PATH: '', TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', TZ: 'UTC' } })
    let out = '', err = ''
    child.stdout.on('data', bytes => { out += bytes }); child.stderr.on('data', bytes => { err += bytes })
    await new Promise((resolveReceipt, rejectReceipt) => {
      const started = Date.now()
      const poll = setInterval(() => {
        if (out.includes('"status": "drained"')) { clearInterval(poll); resolveReceipt(undefined) }
        else if (Date.now() - started > 30_000 || child.exitCode !== null) { clearInterval(poll); rejectReceipt(Error('no drained receipt: ' + out + err)) }
      }, 50)
    })
    await new Promise(resolvePause => setTimeout(resolvePause, 300))
    child.kill('SIGINT')
    const code = await new Promise<number | null>(resolveExit => child.on('close', (exitCode, signal) => resolveExit(signal === null ? exitCode : -1)))
    expect(code).toBe(130)
    expect(err).toContain('draining')
    await expect(access(join(f.inbox, 'scheduler.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    const drained = await f.invoke(['scheduler', '--inbox', f.inbox, ...f.flags])
    expect(drained.out.entries[0]).toMatchObject({ state: 'acked', status: 'completed' })
    const owner = await LocalRuntime.open({ dataDirectory: f.state })
    try { expect(owner.list()).toHaveLength(1) } finally { await owner.close() }
  }, 60_000)

  it('converges after an injected SIGKILL during a drain without duplicating the run', async () => {
    const f = await fixture()
    await f.invoke(['event-inbox', f.path, '--inbox', f.inbox])
    const child = spawn(process.execPath, ['--experimental-transform-types', join(f.directory, 'app.mjs'),
      'scheduler', '--inbox', f.inbox, ...f.flags, '--interval-seconds', '1'],
      { env: { PATH: '', TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', TZ: 'UTC' } })
    // Kill mid-first-pass: before, during or just after the delivery child/record write.
    await new Promise(resolveKill => setTimeout(resolveKill, 200))
    child.kill('SIGKILL')
    await new Promise(resolveExit => child.on('close', resolveExit))
    await new Promise(resolveOrphans => setTimeout(resolveOrphans, 1500))
    let drained: Awaited<ReturnType<typeof f.invoke>> | undefined
    for (let pass = 0; pass < 3; pass++) {
      drained = await f.invoke(['scheduler', '--inbox', f.inbox, ...f.flags])
      if (drained.out?.entries[0]?.state === 'acked') break
      await new Promise(resolveRetry => setTimeout(resolveRetry, 200))
    }
    expect(drained!.out.entries[0]).toMatchObject({ state: 'acked', status: 'completed' })
    const owner = await LocalRuntime.open({ dataDirectory: f.state })
    try {
      expect(owner.list()).toHaveLength(1)
      expect((await owner.events(f.expectedId)).filter(event => event.kind === 'run-created')).toHaveLength(1)
    } finally { await owner.close() }
  }, 60_000)

  it('converges when a direct event job races a scheduler pass outside the inbox lock', async () => {
    const f = await fixture()
    await f.invoke(['event-inbox', f.path, '--inbox', f.inbox])
    const [schedulerRun, direct] = await Promise.all([
      f.invoke(['scheduler', '--inbox', f.inbox, ...f.flags]),
      f.invoke(['event', f.path, '--event-sha256', f.sha256, ...f.flags]),
    ])
    expect(direct.code === 0 || direct.err?.code === 'busy').toBe(true)
    let drained = schedulerRun
    for (let pass = 0; pass < 3 && drained.out?.entries[0]?.state !== 'acked'; pass++) {
      await new Promise(resolveRetry => setTimeout(resolveRetry, 200))
      drained = await f.invoke(['scheduler', '--inbox', f.inbox, ...f.flags])
    }
    expect(drained.out.entries[0]).toMatchObject({ state: 'acked', status: 'completed' })
    const owner = await LocalRuntime.open({ dataDirectory: f.state })
    try {
      expect(owner.list()).toHaveLength(1)
      expect((await owner.events(f.expectedId)).filter(event => event.kind === 'run-created')).toHaveLength(1)
    } finally { await owner.close() }
  }, 60_000)

  it('exports received OTLP traces and logs joined to the run from scheduler children', async () => {
    const f = await fixture()
    const packets: { path: string; bytes: Buffer }[] = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk)
      packets.push({ path: request.url!, bytes: Buffer.concat(chunks) })
      response.writeHead(200, { 'content-type': 'application/x-protobuf' }); response.end()
    })
    await new Promise<void>((ready, failed) => { server.once('error', failed); server.listen(0, '127.0.0.1', ready) })
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw Error('listener')
      const telemetryFile = join(f.directory, 'telemetry.json')
      await writeFile(telemetryFile, JSON.stringify({ endpoint: `http://127.0.0.1:${address.port}/v1/traces`,
        logsEndpoint: `http://127.0.0.1:${address.port}/v1/logs`, authentication: { kind: 'none' },
        intervalMs: 200, timeoutMs: 2000, flushTimeoutMs: 5000 }), { mode: 0o600 })
      await f.invoke(['event-inbox', f.path, '--inbox', f.inbox])
      const drained = await f.invoke(['scheduler', '--inbox', f.inbox, '--telemetry-file', telemetryFile, ...f.flags])
      expect(drained.out.entries[0]).toMatchObject({ state: 'acked', status: 'completed' })
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && (!packets.some(packet => packet.path === '/v1/traces') || !packets.some(packet => packet.path === '/v1/logs')))
        await new Promise(resolveTick => setTimeout(resolveTick, 200))
      const spans = packets.filter(packet => packet.path === '/v1/traces').flatMap(packet => traceRecords(packet.bytes))
      const logs = packets.filter(packet => packet.path === '/v1/logs').flatMap(packet => logRecords(packet.bytes))
      expect(spans.length).toBeGreaterThan(0)
      expect(logs.length).toBeGreaterThan(0)
      expect(JSON.stringify({ spans, logs })).toContain(f.expectedId)
    } finally { server.close(); server.closeAllConnections() }
  }, 60_000)
})
