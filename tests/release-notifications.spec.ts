import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, userInfo } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isBuiltin } from 'node:module'
import { build } from 'esbuild'
import { LocalRuntime } from '../src/runtime/local.ts'
import { startRuntimeService } from '../src/http/service.ts'
import { ReleaseClient } from '../src/releases/client.ts'
import { ReleaseSession } from '../src/releases/service-session.ts'
import { CORE_VERSION } from '../src/capabilities.ts'

const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-release-notification-')), dataDirectory = join(directory, 'state')
  const key = 'whsec_' + randomBytes(32).toString('base64'), received: any[] = []
  let held: (() => void) | undefined, hold = false
  const receiver = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString(), expected = 'v1,' + createHmac('sha256', Buffer.from(key.slice(6), 'base64'))
      .update(req.headers['webhook-id'] + '.' + req.headers['webhook-timestamp'] + '.' + body).digest('base64')
    if (expected !== req.headers['webhook-signature']) { res.writeHead(400); res.end(); return }
    received.push(JSON.parse(body))
    if (hold) held = () => { held = undefined; res.writeHead(202); res.end() }; else { res.writeHead(202); res.end() }
  })
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => { held?.(); receiver.close(e => e ? reject(e) : resolve()); receiver.closeIdleConnections() }))
  const notifications = { endpoints: [{ id: 'review', url: `http://127.0.0.1:${(receiver.address() as { port: number }).port}/fixture`,
    credentialRef: 'review/key', timeoutMs: 2000 }] }
  const runtime = await LocalRuntime.open({ dataDirectory, notifications })
  cleanup.push(() => runtime.close())
  await runtime.setCredential('review/key', key, 0, 'fixture')
  const release = (version: string) => {
    const p = runtime.editProject({ operation: 'create', yaml, title: 'Fixture', actor: 'fixture' })
    return runtime.createRelease({ projectId: p.id, expectedGeneration: 1, revision: p.acceptedRevision, version, actor: 'fixture',
      runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  }
  const selected = release('1.0.0'), foreign = release('2.0.0'), actor = `local:${userInfo().username}`
  const session = new ReleaseSession({ storage: 'sqlite', runtime }, selected.snapshot, actor)
  const own = await runtime.runRelease(selected.snapshot, { message: 'PRIVATE_OWN' })
  const other = await runtime.runRelease(foreign.snapshot, { message: 'PRIVATE_OTHER' })
  const ordinary = await runtime.run(yaml, { message: 'PRIVATE_ORDINARY' })
  const prepare = async (run: typeof own) => {
    if (run.state.status !== 'waiting') throw Error('Expected wait')
    const { event: _event, delivery: _delivery, ...request } = await runtime.prepareApprovalNotification(
      { runId: run.id, revision: run.revision, attemptId: run.state.attempt.id }, 'review')
    return { ...request, requestId: randomUUID() }
  }
  const call = (body: object) => session.operation({ releaseSha256: selected.sha256, ...body }) as Promise<any>
  return { directory, dataDirectory, runtime, selected, foreign, own, other, ordinary, prepare, call, actor, notifications, received,
    hold: () => { hold = true }, finish: () => { hold = false; held?.() } }
}

describe('exact-release notification boundary', () => {
  it('filters actual retained receipts without leaking foreign cursors or changing execution', async () => {
    const f = await fixture(), own = await f.prepare(f.own), foreign = await f.prepare(f.other)
    const selected = await f.call({ operation: 'notifications.send', request: own })
    await f.runtime.sendApprovalNotification(foreign, f.actor)
    const before = [f.runtime.show(f.own.id), f.runtime.events(f.own.id), f.runtime.show(f.other.id), f.runtime.events(f.other.id)]
    const filter = { outcome: 'accepted', eventKind: 'requested', createdFrom: selected.createdAt,
      createdBefore: new Date(Date.parse(selected.createdAt) + 1).toISOString() }
    const page = await f.call({ operation: 'notifications.list', page: { filter, limit: 1 } })
    expect(page.filter).toEqual(filter)
    expect(page.deliveries.map((r: any) => r.request.requestId)).toEqual([own.requestId])
    expect(page.nextCursor).toBeNull()
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|credentialGeneration|actor|"event"/)
    await expect(f.call({ operation: 'notifications.list', page: { filter: { outcome: 'accepted' }, after: foreign.requestId } }))
      .rejects.toHaveProperty('code', 'not-found')
    expect((await f.call({ operation: 'notifications.list', page: { filter: { outcome: 'pending' } } })).deliveries).toEqual([])
    expect((await f.call({ operation: 'notifications.list', page: { filter: { createdBefore: selected.createdAt } } })).deliveries).toEqual([])
    await expect(f.call({ operation: 'notifications.list', page: { filter: {} } })).rejects.toHaveProperty('code', 'invalid-command')
    expect([f.runtime.show(f.own.id), f.runtime.events(f.own.id), f.runtime.show(f.other.id), f.runtime.events(f.other.id)]).toEqual(before)
    expect(f.received).toHaveLength(2)
  })

  it.each(['decided', 'cancelled'] as const)('permits explicit retained %s events only for the selected release', async eventKind => {
    const f = await fixture(), pin = { runId: f.own.id, revision: f.own.revision, attemptId: (f.own.state as any).attempt.id, eventKind }
    if (eventKind === 'decided') await f.runtime.decide(f.own.id, pin.attemptId, 'approve', 'PRIVATE_DECISION_ACTOR')
    else f.runtime.cancel(f.own.id, randomUUID(), 'PRIVATE_CANCEL_ACTOR')
    const before = f.runtime.events(f.own.id)
    const { event, delivery: _delivery, ...pins } = await f.call({ operation: 'notifications.prepare', pin, endpointId: 'review' })
    expect(f.received).toEqual([])
    const request = { ...pins, requestId: randomUUID() }
    const sent = await f.call({ operation: 'notifications.send', request })
    expect(sent.event.type).toBe(`ai.jevable.approval.${eventKind}`)
    expect(event.data.release).toEqual({ id: f.selected.snapshot.id, sha256: f.selected.sha256 })
    expect(JSON.stringify(sent)).not.toContain('PRIVATE_')
    expect(await f.call({ operation: 'notifications.send', request })).toEqual(sent)
    expect(f.received).toHaveLength(1); expect(f.runtime.events(f.own.id)).toEqual(before)
    await expect(f.call({ operation: 'notifications.prepare', pin: { ...pin, runId: f.other.id }, endpointId: 'review' }))
      .rejects.toHaveProperty('code', 'not-found')
  })

  it('refuses a live foreign abort before signalling, while permitting abort for the exact selected release', async () => {
    const f = await fixture(), foreign = await f.prepare(f.other), own = await f.prepare(f.own), safety = new AbortController()
    f.hold()
    const foreignSending = f.runtime.sendApprovalNotification(foreign, f.actor, { signal: safety.signal })
    try {
      await expect.poll(() => f.received.length).toBe(1)
      await expect(f.call({ operation: 'notifications.abort', requestId: foreign.requestId })).rejects.toHaveProperty('code', 'not-found')
      expect((await f.runtime.inspectApprovalNotification(foreign.requestId)).outcome.status).toBe('pending')
      f.finish(); expect((await foreignSending).outcome).toMatchObject({ result: { status: 'accepted' } })
      f.hold(); const sending = f.call({ operation: 'notifications.send', request: own })
      try {
        await expect.poll(() => f.received.length).toBe(2)
        const result = await f.call({ operation: 'notifications.abort', requestId: own.requestId })
        expect(result).toMatchObject({ status: 'abort-requested', requestId: own.requestId })
        expect((await sending).outcome).toMatchObject({ result: { status: 'uncertain', reason: 'aborted' } })
        expect((await f.runtime.show(f.own.id)).state.status).toBe('waiting')
      } finally { f.finish(); await sending.catch(() => {}) }
    } finally { safety.abort(); f.finish(); await foreignSending.catch(() => {}) }
  })

  it('rejects foreign runs, delivery identities, predecessors and cursors without dispatch or workflow changes', async () => {
    const f = await fixture(), own = await f.prepare(f.own)
    for (const run of [f.other, f.ordinary]) {
      const request = await f.prepare(run), foreign = await f.runtime.sendApprovalNotification(request, f.actor)
      const before = f.received.length, events = f.runtime.events(run.id)
      for (const command of [
        { operation: 'notifications.prepare', pin: { runId: run.id, revision: request.revision, attemptId: request.attemptId }, endpointId: 'review' },
        { operation: 'notifications.send', request }, { operation: 'notifications.show', requestId: request.requestId },
        { operation: 'notifications.abort', requestId: request.requestId },
        { operation: 'notifications.list', page: { after: request.requestId } },
        { operation: 'notifications.send', request: { ...own, requestId: request.requestId } },
        { operation: 'notifications.send', request: { ...own, requestId: randomUUID(), redeliverOf: foreign.request.requestId } },
      ]) await expect(f.call(command)).rejects.toHaveProperty('code', 'not-found')
      expect(f.received.length).toBe(before); expect(f.runtime.events(run.id)).toEqual(events)
    }
    expect(await f.call({ operation: 'notifications.list', page: {} })).toMatchObject({ deliveries: [], nextCursor: null })
  })

  it('keeps public receipts, history and duplicate sends after decision/reopen without configuration or redelivery', async () => {
    const f = await fixture(), request = await f.prepare(f.own), before = f.runtime.events(f.own.id)
    const receipt = await f.call({ operation: 'notifications.send', request })
    expect(receipt.outcome.result.status).toBe('accepted'); expect(receipt.actor).toBeUndefined()
    expect(receipt.event.data.release).toEqual({ id: f.selected.snapshot.id, sha256: f.selected.sha256 })
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_'); expect(f.runtime.events(f.own.id)).toEqual(before)
    await f.runtime.decide(f.own.id, request.attemptId, 'approve', f.actor); await f.runtime.close()
    const reopened = await LocalRuntime.open({ dataDirectory: f.dataDirectory }); cleanup.push(() => reopened.close())
    const session = new ReleaseSession({ storage: 'sqlite', runtime: reopened }, f.selected.snapshot, f.actor)
    for (const command of [{ operation: 'notifications.show', requestId: request.requestId }, { operation: 'notifications.send', request }])
      expect(await session.operation({ ...command, releaseSha256: f.selected.sha256 })).toEqual(receipt)
    const page: any = await session.operation({ operation: 'notifications.list', page: {}, releaseSha256: f.selected.sha256 })
    expect(page.deliveries).toHaveLength(1); expect(page.deliveries[0].request).toEqual(request); expect(f.received).toHaveLength(1)
  })

  it('requires exact pins, explicit pagination and immutable caller authority', async () => {
    const f = await fixture(), request = await f.prepare(f.own)
    for (const command of [{ operation: 'notifications.send', request, actor: 'spoof' },
      { operation: 'notifications.send', request: { ...request, url: 'https://foreign.invalid' } },
      { operation: 'notifications.abort', requestId: request.requestId, actor: 'spoof' },
      { operation: 'notifications.list' }, { operation: 'notifications.list', page: { limit: 201 } }])
      await expect(f.call(command)).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.call({ operation: 'notifications.send', request, releaseSha256: 'b'.repeat(64) }))
      .rejects.toHaveProperty('code', 'conflict')
    expect(f.received).toHaveLength(0)
  })

  it('serves authenticated release notifications and drains a real admitted send without automatic startup delivery', async () => {
    const f = await fixture(), request = await f.prepare(f.own); await f.runtime.close()
    const token = randomBytes(32).toString('hex'), service = await startRuntimeService({ runtime: { dataDirectory: f.dataDirectory,
      notifications: f.notifications }, token, actor: f.actor, release: { snapshot: f.selected.snapshot } })
    cleanup.push(() => service.close())
    const client = new ReleaseClient(service.url, token, f.selected.sha256)
    expect((await client.capabilities() as any).approvalNotifications.scope).toBe('exact-release')
    await expect(new ReleaseClient(service.url, '0'.repeat(64), f.selected.sha256)
      .operation({ operation: 'notifications.send', request })).rejects.toHaveProperty('code', 'unauthorized')
    expect(f.received).toHaveLength(0); f.hold()
    const pending = client.operation({ operation: 'notifications.send', request })
    try {
      await expect.poll(() => f.received.length).toBe(1)
      expect((await client.operation({ operation: 'notifications.show', requestId: request.requestId }) as any).result.outcome.status).toBe('pending')
      let closed = false; const draining = service.close().then(() => { closed = true })
      await new Promise(r => setTimeout(r, 25)); expect(closed).toBe(false)
      f.finish(); expect((await pending as any).result.outcome.result.status).toBe('accepted'); await draining
    } finally { f.finish(); await pending.catch(() => {}) }
    expect(f.received).toHaveLength(1)
  })

  it('runs notify from the standalone release entry and refuses non-notification commands', async () => {
    const f = await fixture(), request = await f.prepare(f.own); await f.runtime.close()
    const releaseFile = join(f.directory, 'release.json'), commandFile = join(f.directory, 'command.json'), configFile = join(f.directory, 'config.json')
    await writeFile(releaseFile, JSON.stringify(f.selected.snapshot)); await writeFile(configFile, JSON.stringify(f.notifications), { mode: 0o600 })
    // Exercise the distributed artifact form, not five independent TypeScript
    // transpilation graphs. Build current source here; never use stale checkout dist.
    const bundledEntry = join(f.directory, 'release-runtime.mjs')
    const bundle = await build({ absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
      entryPoints: ['src/releases/entry.ts'], outfile: bundledEntry,
      bundle: true, platform: 'node', format: 'esm', target: 'node22.19', metafile: true, legalComments: 'eof',
      banner: { js: 'import { createRequire as __jevableCreateRequire } from "node:module"; const require = __jevableCreateRequire(import.meta.url);' } })
    for (const output of Object.values(bundle.metafile!.outputs)) for (const imported of output.imports)
      expect(imported.external && isBuiltin(imported.path)).toBe(true)
    expect(Object.keys(bundle.metafile!.inputs).some(path => path.startsWith('node_modules/pg') || path.includes('/postgres'))).toBe(false)
    const entry = pathToFileURL(bundledEntry).href
    const cli = async (command: object, configured = false) => {
      await writeFile(commandFile, JSON.stringify(command))
      const child = spawn(process.execPath, ['--input-type=module', '-e',
        `import{readFileSync}from'node:fs';import{releaseMain}from ${JSON.stringify(entry)};process.exitCode=await releaseMain(JSON.parse(readFileSync(process.argv[1])),process.argv.slice(3),process.argv[2]);`,
        releaseFile, f.directory, 'notify', commandFile, '--data-dir', f.dataDirectory, ...(configured ? ['--notifications-file', configFile] : [])])
      let out = '', err = ''; child.stdout.on('data', b => { out += b }); child.stderr.on('data', b => { err += b })
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
      return { code, result: out ? JSON.parse(out) : undefined, err }
    }
    const sent = await cli({ operation: 'notifications.send', request }, true)
    expect(sent.code, sent.err).toBe(0); expect(sent.result.outcome.result.status).toBe('accepted')
    expect((await cli({ operation: 'notifications.send', request })).result).toEqual(sent.result)
    expect((await cli({ operation: 'notifications.list', page: {} })).result.deliveries).toHaveLength(1)
    const aborted = await cli({ operation: 'notifications.abort', requestId: request.requestId })
    expect(aborted.code).toBe(0); expect(aborted.result).toMatchObject({ status: 'not-active', receipt: { outcome: sent.result.outcome } })
    expect((await cli({ operation: 'runs.start', id: randomUUID(), input: {} })).code).toBe(2)
    expect(f.received).toHaveLength(1)
  })
})
