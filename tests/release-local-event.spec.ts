import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CORE_VERSION } from '../src/capabilities.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { RunStore } from '../src/runtime/store.ts'
import { runReleaseApp, type ReleaseBackend } from '../src/releases/app.ts'
import { sqliteReleaseBackend } from '../src/releases/entry.ts'
import { releaseMessageRunId } from '../src/releases/messages.ts'

const execute = promisify(execFile)
const api = await readFile(new URL('../examples/api-echo.yaml', import.meta.url), 'utf8')
const manual = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = (await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')).replace('modes: [manual]', 'modes: [api]')
const modelApi = `apiVersion: jevable.ai/v1alpha1
kind: Workflow
metadata:
  id: model-api
  name: Model API
spec:
  inputSchema:
    type: string
  nodes:
    start:
      type: trigger
      config:
        modes: [api]
    write:
      type: llm
      config:
        provider: fixture
        model: fixture
        connection:
          mode: workspace
          id: fixture
        prompt: "\${{ inputs }}"
        responseFormat: text
        generation:
          maxTokens: 20
          stream: false
        execution:
          timeoutSeconds: 60
          maxAttempts: 1
        historyScope: none
    result:
      type: output
      config:
        value: "\${{ nodes.write.output }}"
  edges:
    - from: start
      to: write
    - from: write
      to: result
`
afterEach(() => vi.restoreAllMocks())
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const capture = () => {
  let out = '', err = ''
  return { io: { out: (value: string) => { out += value }, err: (value: string) => { err += value } },
    out: () => out ? JSON.parse(out) : undefined, err: () => err ? JSON.parse(err) : undefined }
}
async function fixture(yaml = api) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-local-event-')), author = await LocalRuntime.open({ dataDirectory: join(directory, 'author') })
  let release
  try {
    const project = author.editProject({ operation: 'create', yaml, title: 'Private local event fixture', actor: 'fixture:author' })
    release = author.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
      version: '1.0.0', actor: 'fixture:author', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  } finally { await author.close() }
  const event = { format: 'jevable.ai/local-release-event', version: 1,
    release: { id: release.snapshot.id, sha256: release.sha256, revision: release.snapshot.workflow.revision },
    source: 'local/orders', messageId: 'PRIVATE_EVENT_001', input: 'PRIVATE_INPUT' }
  const path = join(directory, 'event.json'), state = join(directory, 'state')
  const save = async (value: unknown) => { const bytes = JSON.stringify(value); await writeFile(path, bytes, { mode: 0o600 }); return hash(bytes) }
  const sha256 = await save(event)
  const invoke = async (args: string[], backend = sqliteReleaseBackend) => {
    const result = capture(), code = await runReleaseApp(backend, release.snapshot, args, directory, result.io)
    return { code, out: result.out(), err: result.err() }
  }
  return { directory, release, event, path, state, sha256, save, invoke,
    flags: ['--data-dir', state], expectedId: releaseMessageRunId({ release: event.release, source: event.source, messageId: event.messageId }) }
}

describe('exact release one-shot local events', () => {
  it('derives the stable identity and exact-byte pin without a storage owner or private payload output', async () => {
    const f = await fixture(), open = vi.fn(), serve = vi.fn()
    const backend = { storage: 'sqlite', open, serve } as unknown as ReleaseBackend
    const receipt = await f.invoke(['event-id', f.path], backend)
    expect(receipt).toMatchObject({ code: 0, out: { format: 'jevable.ai/local-release-event-id', runId: f.expectedId,
      eventSha256: f.sha256, execution: 'not-run', authority: 'local-owner-file; sender-not-verified' } })
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_')
    expect(open).not.toHaveBeenCalled(); expect(serve).not.toHaveBeenCalled()
    expect((await f.invoke(['event-id', f.path, '--data-dir', f.state], backend)).code).toBe(2)
  })

  it('cold-starts one API job, closes its owner and observes the same result on redelivery after reopen', async () => {
    const f = await fixture(), args = ['event', f.path, '--event-sha256', f.sha256, ...f.flags]
    const first = await f.invoke(args)
    expect(first).toMatchObject({ code: 0, out: { id: f.expectedId, status: 'completed', output: f.event.input, eventSha256: f.sha256 } })
    const runtime = await LocalRuntime.open({ dataDirectory: f.state })
    const events = await runtime.events(f.expectedId)
    expect((await runtime.show(f.expectedId)).triggerMode).toBe('api'); expect(runtime.list()).toHaveLength(1)
    await runtime.close()
    expect(await f.invoke(args)).toEqual(first)
    const reopened = await LocalRuntime.open({ dataDirectory: f.state })
    try { expect(await reopened.events(f.expectedId)).toEqual(events); expect(reopened.list()).toHaveLength(1) }
    finally { await reopened.close() }
  })

  it('preserves an approval wait across redelivery without approval or further journal events', async () => {
    const f = await fixture(approval), sha256 = await f.save({ ...f.event, input: { message: 'PRIVATE_REVIEW' } })
    const args = ['event', f.path, '--event-sha256', sha256, ...f.flags]
    const waiting = await f.invoke(args)
    expect(waiting).toMatchObject({ code: 3, out: { id: f.expectedId, status: 'waiting', nodeId: 'review' } })
    const owner = await LocalRuntime.open({ dataDirectory: f.state }), before = await owner.events(f.expectedId)
    await owner.close()
    expect(await f.invoke(args)).toEqual(waiting)
    const next = await LocalRuntime.open({ dataDirectory: f.state })
    try { expect(await next.events(f.expectedId)).toEqual(before); expect(next.list()).toHaveLength(1) }
    finally { await next.close() }
  })

  it('refuses a changed input under the original message identity even with its new reviewed byte hash', async () => {
    const f = await fixture()
    expect((await f.invoke(['event', f.path, '--event-sha256', f.sha256, ...f.flags])).code).toBe(0)
    const changed = await f.save({ ...f.event, input: 'CHANGED' })
    expect(await f.invoke(['event', f.path, '--event-sha256', changed, ...f.flags])).toMatchObject({ code: 1, err: { code: 'conflict' } })
    const owner = await LocalRuntime.open({ dataDirectory: f.state })
    try { expect((await owner.show(f.expectedId)).input).toBe(f.event.input); expect(owner.list()).toHaveLength(1) }
    finally { await owner.close() }
  })

  it('owns the admitted input bytes before asynchronous storage startup', async () => {
    const f = await fixture(), open = vi.fn(async (...args: Parameters<ReleaseBackend['open']>) => {
      await f.save({ ...f.event, input: 'REPLACED_DURING_STARTUP' })
      return sqliteReleaseBackend.open(...args)
    })
    const result = await f.invoke(['event', f.path, '--event-sha256', f.sha256, ...f.flags], { ...sqliteReleaseBackend, open })
    expect(result).toMatchObject({ code: 0, out: { output: f.event.input, eventSha256: f.sha256 } })
    expect(open).toHaveBeenCalledOnce()
  })

  it('observes a lost creation acknowledgement as the original paused checkpoint and never executes on redelivery', async () => {
    const f = await fixture(), save = RunStore.prototype.save
    const fault = vi.spyOn(RunStore.prototype, 'save').mockImplementation(function(this: RunStore, ...args) {
      save.apply(this, args); if (args[1] === 'run-created') throw Error('PRIVATE_LOST_ACK')
    })
    const args = ['event', f.path, '--event-sha256', f.sha256, ...f.flags]
    expect(await f.invoke(args)).toMatchObject({ code: 1, err: { code: 'operation-failed' } }); fault.mockRestore()
    const retried = await f.invoke(args)
    expect(retried).toMatchObject({ code: 3, out: { id: f.expectedId, status: 'paused' } })
    const owner = await LocalRuntime.open({ dataDirectory: f.state })
    try { expect((await owner.events(f.expectedId)).map(event => event.kind)).toEqual(['run-created']); expect(owner.list()).toHaveLength(1) }
    finally { await owner.close() }
  })

  it.each(['sqlite', 'postgres'] as const)('rejects malformed %s event authority before any owner is opened', async storage => {
    const f = await fixture(), open = vi.fn(), serve = vi.fn()
    const backend = { storage, open, serve } as unknown as ReleaseBackend
    const flags = storage === 'sqlite' ? f.flags : ['--database-file', '/never-read']
    for (const value of [null, [], { ...f.event, actor: 'spoof' }, { ...f.event, version: 2 },
      { ...f.event, source: ' bad' }, { ...f.event, messageId: 'has space' },
      { ...f.event, release: { ...f.event.release, id: randomUUID() } },
      { ...f.event, release: { ...f.event.release, sha256: 'b'.repeat(64) } },
      { ...f.event, release: { ...f.event.release, revision: 'c'.repeat(64) } },
      Object.fromEntries(Object.entries(f.event).filter(([key]) => key !== 'input'))]) {
      const sha256 = await f.save(value)
      expect(await f.invoke(['event', f.path, '--event-sha256', sha256, ...flags], backend)).toMatchObject({ code: 2, err: { code: 'invalid-command' } })
    }
    const sha256 = await f.save(f.event)
    for (const expected of ['a'.repeat(64), sha256.toUpperCase(), 'bad'])
      expect((await f.invoke(['event', f.path, '--event-sha256', expected, ...flags], backend)).code).toBe(2)
    expect((await f.invoke(['event', f.path, ...flags], backend)).code).toBe(2)
    expect(open).not.toHaveBeenCalled(); expect(serve).not.toHaveBeenCalled()
  })

  it('rejects manual-only graphs, final symlinks, public files, malformed UTF-8 and oversized files before owner startup', async () => {
    const f = await fixture(manual), open = vi.fn(), backend = { ...sqliteReleaseBackend, open }
    expect((await f.invoke(['event-id', f.path], backend)).code).toBe(2)
    const apiFixture = await fixture()
    const alias = join(apiFixture.directory, 'symlink.json'); await symlink(apiFixture.path, alias)
    expect((await apiFixture.invoke(['event-id', alias], backend)).code).toBe(2)
    await chmod(apiFixture.path, 0o644)
    if (process.platform !== 'win32') expect((await apiFixture.invoke(['event-id', apiFixture.path], backend)).code).toBe(2)
    await chmod(apiFixture.path, 0o600)
    await writeFile(apiFixture.path, new Uint8Array([0xff, 0xfe]))
    expect((await apiFixture.invoke(['event-id', apiFixture.path], backend)).code).toBe(2)
    await writeFile(apiFixture.path, Buffer.alloc(1_100_001, 32))
    expect((await apiFixture.invoke(['event-id', apiFixture.path], backend)).code).toBe(2)
    expect(open).not.toHaveBeenCalled()
  })

  it('refuses a competing SQLite owner without creating a run, then admits the same event exactly once', async () => {
    const f = await fixture(), args = ['event', f.path, '--event-sha256', f.sha256, ...f.flags]
    const owner = await LocalRuntime.open({ dataDirectory: f.state })
    try {
      expect(await f.invoke(args)).toMatchObject({ code: 1, err: { code: 'busy' } })
      expect(owner.list()).toHaveLength(0)
    } finally { await owner.close() }
    expect(await f.invoke(args)).toMatchObject({ code: 0, out: { id: f.expectedId, status: 'completed' } })
    const reopened = await LocalRuntime.open({ dataDirectory: f.state })
    try { expect(reopened.list()).toHaveLength(1) } finally { await reopened.close() }
  })

  it('refuses a nonblocking FIFO event path without hanging on an absent writer', async () => {
    const f = await fixture(), open = vi.fn(), backend = { ...sqliteReleaseBackend, open }
    if (process.platform !== 'win32') {
      const fifo = join(f.directory, 'event.fifo')
      await execute('mkfifo', [fifo])
      await chmod(fifo, 0o600)
      expect((await f.invoke(['event-id', fifo], backend)).code).toBe(2)
      expect((await f.invoke(['event', fifo, '--event-sha256', 'd'.repeat(64), ...f.flags], backend)).code).toBe(2)
      expect(open).not.toHaveBeenCalled()
    }
  })

  it('refuses model dispatch before any run exists when the release provider connection is absent', async () => {
    const f = await fixture(modelApi), args = ['event', f.path, '--event-sha256', f.sha256, ...f.flags]
    const refused = await f.invoke(args)
    expect(refused).toMatchObject({ code: 1, err: { code: 'missing-connection' } })
    expect(JSON.stringify(refused)).not.toContain('PRIVATE_')
    expect(await f.invoke(args)).toEqual(refused)
    const owner = await LocalRuntime.open({ dataDirectory: f.state })
    try { expect(owner.list()).toHaveLength(0) } finally { await owner.close() }
  })

  it('admits exactly one run across real concurrent processes and observes later duplicates', async () => {
    const f = await fixture()
    const program = `
      const { releaseMain } = await import(${JSON.stringify(new URL('../src/releases/entry.ts', import.meta.url).href)})
      process.exitCode = await releaseMain(${JSON.stringify(f.release.snapshot)},
        ${JSON.stringify(['event', f.path, '--event-sha256', f.sha256, ...f.flags])}, ${JSON.stringify(f.directory)})`
    const child = () => execute(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', program],
      { cwd: f.directory, env: { PATH: '', TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', TZ: 'UTC',
        ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}) } })
    const cold = await Promise.allSettled([child(), child()])
    expect(cold.some(result => result.status === 'fulfilled')).toBe(true)
    // Receipts are pretty-printed JSON; stderr may lead with Node warnings.
    const receiptJson = (text: string) => JSON.parse(text.split('\n').slice(text.split('\n').findIndex(line => line.startsWith('{'))).join('\n'))
    for (const result of cold) {
      if (result.status === 'fulfilled') expect(receiptJson(result.value.stdout)).toMatchObject({ id: f.expectedId, status: 'completed', output: f.event.input })
      else expect(receiptJson(result.reason.stderr)).toMatchObject({ code: 'busy' })
    }
    const settled = await child()
    const receipt = receiptJson(settled.stdout)
    expect(receipt).toMatchObject({ id: f.expectedId, status: 'completed', output: f.event.input })
    expect(receiptJson((await child()).stdout)).toEqual(receipt)
    const owner = await LocalRuntime.open({ dataDirectory: f.state })
    try { expect(owner.list()).toHaveLength(1) } finally { await owner.close() }
  }, 60_000)

  it('keeps the exact event identity across an authorized separate approval continuation', async () => {
    const f = await fixture(approval), sha256 = await f.save({ ...f.event, input: { message: 'PRIVATE_REVIEW' } })
    const args = ['event', f.path, '--event-sha256', sha256, ...f.flags]
    const waiting = await f.invoke(args)
    expect(waiting).toMatchObject({ code: 3, out: { id: f.expectedId, status: 'waiting', attemptId: expect.any(String) } })
    expect(await f.invoke(args)).toEqual(waiting)
    const decided = await f.invoke(['decide', f.expectedId, '--attempt', waiting.out!.attemptId, '--action', 'approve', ...f.flags])
    expect(decided).toMatchObject({ code: 0, out: { id: f.expectedId, status: 'completed' } })
    expect(await f.invoke(args)).toMatchObject({ code: 0, out: { id: f.expectedId, status: 'completed' } })
    const owner = await LocalRuntime.open({ dataDirectory: f.state })
    try {
      expect(owner.list()).toHaveLength(1)
      expect((await owner.events(f.expectedId)).filter(event => event.kind === 'approval-decided')).toHaveLength(1)
    } finally { await owner.close() }
  })
})
