import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { CLI_OUTPUT_LIMITS, CliOutputError, createCliOutput, encodeCliJson } from '../src/process/cli-output.ts'
import { main } from '../src/cli.ts'
import { LocalRuntime } from '../src/runtime/index.ts'
import { runReleaseApp, type ReleaseBackend } from '../src/releases/app.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { acknowledgeCliWrite } from './helpers/cli-write.ts'

afterEach(() => vi.restoreAllMocks())
const echoPath = fileURLToPath(new URL('../examples/echo.yaml', import.meta.url))
const inputPath = fileURLToPath(new URL('../examples/echo-input.json', import.meta.url))
function capture() {
  let stdout = '', stderr = ''
  return { io: { out: (text: string) => { stdout += text }, err: (text: string) => { stderr += text } },
    get stdout() { return stdout }, get stderr() { return stderr } }
}

describe('complete bounded CLI output, not workflow retry or consumer attestation', () => {
  it('keeps exact normal pretty JSON and compact NDJSON encoding', () => {
    const value = { unicode: 'é😀', nested: [null, true, 1] }
    expect(encodeCliJson(value)).toBe(JSON.stringify(value, null, 2) + '\n')
    expect(encodeCliJson(value, 'stdout', false)).toBe(JSON.stringify(value) + '\n')
  })
  it('admits the exact encoded stdout boundary but never truncates an oversized response', async () => {
    const text = encodeCliJson('a'.repeat(CLI_OUTPUT_LIMITS.stdoutBytes - 3))
    expect(Buffer.byteLength(text)).toBe(CLI_OUTPUT_LIMITS.stdoutBytes)
    const writes: string[] = [], diagnostic = capture()
    const output = createCliOutput({ out: value => { writes.push(value) }, err: diagnostic.io.err })
    output.io.out(text)
    expect(() => output.io.out(text + 'x')).toThrow(CliOutputError)
    await output.finish()
    expect(writes).toEqual([text])
    expect(JSON.parse(diagnostic.stderr)).toMatchObject({ code: 'output-limit', channel: 'stdout', output: 'not-confirmed-complete' })
    expect(() => encodeCliJson('a'.repeat(CLI_OUTPUT_LIMITS.stdoutBytes - 2))).toThrow(CliOutputError)
  })
  it('counts UTF-8 bytes and the newline, not JavaScript character length', async () => {
    const diagnostic = capture(), output = createCliOutput(diagnostic.io)
    const exact = 'é'.repeat(CLI_OUTPUT_LIMITS.stderrBytes / 2)
    output.io.err(exact)
    expect(() => output.io.err(exact + '\n')).toThrow(CliOutputError)
    await output.finish()
    expect(diagnostic.stderr.slice(0, exact.length)).toBe(exact)
    expect(JSON.parse(diagnostic.stderr.slice(exact.length))).toMatchObject({ code: 'output-limit', channel: 'stderr', limitBytes: 64000 })
  })
  it.each(['cycle', 'bigint', 'undefined'] as const)('withholds a complete unencodable %s value without exposing it', mode => {
    const value: any = mode === 'bigint' ? { private: 'PRIVATE_OUTPUT', value: 1n } : mode === 'undefined' ? undefined : { private: 'PRIVATE_OUTPUT' }
    if (mode === 'cycle') value.self = value
    try { encodeCliJson(value); throw Error('Unexpected encoding success') }
    catch (error) {
      expect(error).toBeInstanceOf(CliOutputError)
      expect(error).toMatchObject({ code: 'output-encoding-failed', channel: 'stdout' })
      expect(String(error)).not.toContain('PRIVATE_OUTPUT'); expect(error).not.toHaveProperty('cause')
    }
  })
  it('bounds pending asynchronous output and waits for already admitted writes without replay', async () => {
    const resolves: (() => void)[] = [], writes: string[] = [], diagnostic = capture()
    const output = createCliOutput({ out: text => { writes.push(text); return new Promise<void>(resolve => { resolves.push(resolve) }) }, err: diagnostic.io.err })
    const chunk = 'a'.repeat(CLI_OUTPUT_LIMITS.stdoutBytes)
    output.io.out(chunk); output.io.out(chunk)
    expect(() => output.io.out('x')).toThrow(CliOutputError)
    let ended = false
    const finishing = output.finish().then(() => { ended = true })
    await Promise.resolve(); expect(ended).toBe(false)
    for (const resolve of resolves) resolve()
    await finishing
    expect(writes).toEqual([chunk, chunk]); expect(ended).toBe(true)
    expect(JSON.parse(diagnostic.stderr)).toMatchObject({ code: 'output-limit', pendingLimitBytes: 64000000 })
  })
  it('awaits asynchronous custom-writer failure and withholds raw writer errors', async () => {
    const diagnostic = capture()
    const code = await main(['capabilities'], { out: () => Promise.reject(Error('PRIVATE_WRITER_ERROR')), err: diagnostic.io.err })
    expect(code).toBe(5)
    expect(JSON.parse(diagnostic.stderr)).toMatchObject({ code: 'output-write-failed', channel: 'stdout' })
    expect(diagnostic.stderr).not.toContain('PRIVATE_WRITER_ERROR')
  })
  it('awaits a native write callback/error event and removes only its own listeners', async () => {
    const beforeStream = process.stdout.listeners('error'), beforeErr = process.stderr.listeners('error')
    let diagnostic = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(((_text: string, callback: (error?: Error | null) => void) => {
      queueMicrotask(() => { const error = Error('PRIVATE_EPIPE'); callback(error); process.stdout.emit('error', error) })
      return false
    }) as typeof process.stdout.write)
    vi.spyOn(process.stderr, 'write').mockImplementation(acknowledgeCliWrite(text => { diagnostic += text }))
    expect(await main(['capabilities'])).toBe(5)
    expect(JSON.parse(diagnostic)).toMatchObject({ code: 'output-write-failed', channel: 'stdout' })
    expect(diagnostic).not.toContain('PRIVATE_EPIPE')
    expect(process.stdout.listeners('error')).toEqual(beforeStream); expect(process.stderr.listeners('error')).toEqual(beforeErr)
  })
  it('returns failure when both output channels are broken instead of leaking or throwing writer details', async () => {
    expect(await main(['capabilities'], { out: () => { throw Error('PRIVATE_STDOUT') }, err: () => { throw Error('PRIVATE_STDERR') } })).toBe(5)
  })
  it('retains a completed real direct CLI run after receipt loss, then observes the same UUID without new events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-output-loss-')), dataDirectory = join(directory, 'state'), id = randomUUID()
    const args = ['run', echoPath, '--input', inputPath, '--id', id, '--data-dir', dataDirectory], diagnostic = capture()
    expect(await main(args, { out: () => { throw Error('PRIVATE_LOST_RECEIPT') }, err: diagnostic.io.err })).toBe(5)
    expect(JSON.parse(diagnostic.stderr)).toMatchObject({ code: 'output-write-failed', execution: 'not-cancelled-replayed-or-rolled-back-by-output-handler' })
    const owner = await LocalRuntime.open({ dataDirectory })
    let before: Awaited<ReturnType<typeof owner.events>>
    try { expect((await owner.show(id)).state.status).toBe('completed'); before = await owner.events(id) }
    finally { await owner.close() }
    const observed = capture(); expect(await main(args, observed.io)).toBe(0)
    expect(JSON.parse(observed.stdout)).toMatchObject({ id, status: 'completed', output: 'Hello from a standalone Jevable workflow.' })
    const reopened = await LocalRuntime.open({ dataDirectory })
    try { expect(await reopened.events(id)).toEqual(before!) } finally { await reopened.close() }
    expect(diagnostic.stderr).not.toContain('PRIVATE_LOST_RECEIPT')
  })
  it('preserves exact-release completion and original events after exported-app receipt loss', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-app-output-loss-')), dataDirectory = join(directory, 'state')
    const owner = await LocalRuntime.open({ dataDirectory })
    let snapshot: ReturnType<typeof owner.createRelease>['snapshot']
    try {
      const project = owner.editProject({ operation: 'create', yaml: await readFile(echoPath, 'utf8'), title: 'Output loss fixture', actor: 'fixture:owner' })
      snapshot = owner.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
        version: '1.0.0', actor: 'fixture:owner', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } }).snapshot
    } finally { await owner.close() }
    const backend: ReleaseBackend = { storage: 'sqlite', open: async () => LocalRuntime.open({ dataDirectory }),
      serve: async () => { throw Error('Unexpected service startup') } }
    const file = join(directory, 'input.json'), id = randomUUID(); await writeFile(file, JSON.stringify('Real output loss'), { mode: 0o600 })
    const args = ['run', '--input', file, '--id', id], diagnostic = capture()
    expect(await runReleaseApp(backend, snapshot!, args, directory, { out: () => Promise.reject(Error('PRIVATE_APP_WRITER')), err: diagnostic.io.err })).toBe(5)
    const retained = await LocalRuntime.open({ dataDirectory })
    let before: Awaited<ReturnType<typeof retained.events>>
    try { const run = await retained.show(id); expect(run.state.status).toBe('completed');
      if (run.state.status !== 'completed') throw Error('Fixture did not complete')
      expect(run.state.output).toBe('Real output loss'); before = await retained.events(id) }
    finally { await retained.close() }
    const observed = capture(); expect(await runReleaseApp(backend, snapshot!, args, directory, observed.io)).toBe(0)
    expect(JSON.parse(observed.stdout)).toMatchObject({ id, status: 'completed', output: 'Real output loss', release: { id: snapshot!.id } })
    const reopened = await LocalRuntime.open({ dataDirectory })
    try { expect(await reopened.events(id)).toEqual(before!) } finally { await reopened.close() }
    expect(diagnostic.stderr).not.toContain('PRIVATE_APP_WRITER')
  })
  it('preserves a real approval wait after receipt loss without deciding or creating a replacement attempt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-wait-output-loss-')), dataDirectory = join(directory, 'state'), id = randomUUID()
    const args = ['run', fileURLToPath(new URL('../examples/approval.yaml', import.meta.url)), '--input',
      fileURLToPath(new URL('../examples/approval-input.json', import.meta.url)), '--id', id, '--data-dir', dataDirectory]
    const diagnostic = capture()
    expect(await main(args, { out: () => { throw Error('PRIVATE_WAIT_WRITER') }, err: diagnostic.io.err })).toBe(5)
    const owner = await LocalRuntime.open({ dataDirectory })
    let before: Awaited<ReturnType<typeof owner.events>>, attempt: string
    try { const run = await owner.show(id); expect(run.state.status).toBe('waiting');
      attempt = (run.state as { attempt: { id: string } }).attempt.id; before = await owner.events(id) }
    finally { await owner.close() }
    const observed = capture(); expect(await main(args, observed.io)).toBe(3)
    expect(JSON.parse(observed.stdout)).toMatchObject({ id, status: 'waiting', attemptId: attempt! })
    const reopened = await LocalRuntime.open({ dataDirectory })
    try { expect(await reopened.events(id)).toEqual(before!) } finally { await reopened.close() }
  })
  it('retains an already written artifact after receipt loss without overwrite or rollback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-artifact-output-loss-')), output = join(directory, 'workflow.yaml'), diagnostic = capture()
    const args = ['templates', 'render', 'discount-approval', '--output', output]
    expect(await main(args, { out: () => { throw Error('PRIVATE_ARTIFACT_WRITER') }, err: diagnostic.io.err })).toBe(5)
    const bytes = await readFile(output)
    const observed = capture(); expect(await main(['validate', output, '--json'], observed.io)).toBe(0)
    expect(JSON.parse(observed.stdout)).toMatchObject({ status: 'valid', execution: 'not-run' })
    const refused = capture(); expect(await main(args, refused.io)).toBe(1)
    expect(await readFile(output)).toEqual(bytes)
    expect(JSON.parse(refused.stderr)).toMatchObject({ status: 'error' })
  })
  it('keeps graceful SIGINT status and settles admitted work even when its draining/output writer fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-signal-output-loss-')), dataDirectory = join(directory, 'state'), id = randomUUID()
    const before = process.listeners('SIGINT'), original = LocalRuntime.prototype.run
    vi.spyOn(LocalRuntime.prototype, 'run').mockImplementation(function (this: LocalRuntime, ...args) {
      const handler = process.listeners('SIGINT').find(value => !before.includes(value))!
      expect(handler).toBeTypeOf('function'); handler('SIGINT')
      return Reflect.apply(original, this, args)
    })
    expect(await main(['run', echoPath, '--input', inputPath, '--id', id, '--data-dir', dataDirectory],
      { out: () => { throw Error('PRIVATE_OUT') }, err: () => { throw Error('PRIVATE_DRAIN') } })).toBe(130)
    expect(process.listeners('SIGINT')).toEqual(before)
    const owner = await LocalRuntime.open({ dataDirectory })
    try { expect((await owner.show(id)).state.status).toBe('completed') } finally { await owner.close() }
  })
  it('discovers output budgets without altering ordinary help grammar or dispatching work', async () => {
    const observed = capture(); expect(await main(['help', 'run', '--json'], observed.io)).toBe(0)
    expect(JSON.parse(observed.stdout)).toMatchObject({ schemaVersion: 4, execution: 'not-dispatched',
      output: { ...CLI_OUTPUT_LIMITS, encoding: 'utf8', failureExitCode: 5, truncation: 'never', replay: 'never' } })
  })
})
