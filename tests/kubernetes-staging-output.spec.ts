import { afterAll, expect, it } from 'vitest'
import { constants } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stageConfiguration } from '../src/deployment/scripts.ts'

const exec = promisify(execFile), children: number[] = []
const refusal = { code: 1, signal: null, stdout: '', stderr: 'Jevable private configuration staging failed.\n' }
async function execute(binary: string, args: string[], cwd: string) {
  const work = exec(binary, args, { cwd, timeout: 2500, killSignal: 'SIGTERM', maxBuffer: 16384 })
  children.push(work.child.pid!)
  try { const result = await work; return { code: 0, signal: null, ...result } }
  catch (error) {
    const result = error as { code: number | string | null; signal?: string; stdout?: string; stderr?: string }
    return { code: result.code, signal: result.signal ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
}
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'jevable-k8s-output-')))
  const source = join(directory, 'projected'), destination = join(directory, 'private'), script = join(directory, 'stage.mjs')
  await mkdir(source); await mkdir(destination, { mode: 0o700 }); await writeFile(script, stageConfiguration)
  const configuration = JSON.stringify({ tls: { mode: 'verify-full' }, password: 'SYNTHETIC_STAGING_CONFIG' })
  await writeFile(join(source, 'database.json'), configuration)
  for (const name of ['service-token', 'server.crt', 'server.key', 'ca.crt']) await writeFile(join(source, name), 'synthetic-fixture')
  const final = join(destination, 'database.json'), pending = final + '.pending'
  await writeFile(final, 'retained-final-config', { mode: 0o600 })
  return { directory, source, destination, configuration, final, pending,
    run: () => execute(process.execPath, [script, source, destination, 'no', 'no'], directory) }
}
afterAll(() => {
  for (const pid of children) {
    try { process.kill(pid, 0); throw Error('Recorded staging fixture child remains present') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
})
it.skipIf(process.platform === 'win32')('refuses an unconnected pending FIFO promptly without waiting for a reader', async () => {
  const f = await fixture()
  expect((await execute('mkfifo', [f.pending], f.directory)).code).toBe(0)
  expect(await f.run()).toEqual(refusal)
  expect((await lstat(f.pending)).isFIFO()).toBe(true)
  expect(await readFile(f.final, 'utf8')).toBe('retained-final-config')
})
it.skipIf(process.platform === 'win32')('refuses a connected pending FIFO before writing any configuration bytes', async () => {
  const f = await fixture()
  expect((await execute('mkfifo', [f.pending], f.directory)).code).toBe(0)
  const reader = await open(f.pending, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    expect(await f.run()).toEqual(refusal)
    expect((await reader.read(Buffer.alloc(1024), 0, 1024, null)).bytesRead).toBe(0)
    expect((await lstat(f.pending)).isFIFO()).toBe(true)
    expect(await readFile(f.final, 'utf8')).toBe('retained-final-config')
  } finally { await reader.close() }
})
it.skipIf(process.platform === 'win32')('refuses a hard-linked pending output before truncation, chmod or replacement', async () => {
  const f = await fixture(), protectedFile = join(f.directory, 'protected-fixture')
  await writeFile(protectedFile, 'unmodified-protected-fixture', { mode: 0o640 }); await link(protectedFile, f.pending)
  const before = await lstat(protectedFile)
  expect(await f.run()).toEqual(refusal)
  expect(await readFile(protectedFile, 'utf8')).toBe('unmodified-protected-fixture')
  expect(await readFile(f.pending, 'utf8')).toBe('unmodified-protected-fixture')
  const after = await lstat(protectedFile)
  expect({ mode: after.mode, ino: after.ino, nlink: after.nlink, size: after.size }).toEqual({ mode: before.mode, ino: before.ino, nlink: before.nlink, size: before.size })
  expect(await readFile(f.final, 'utf8')).toBe('retained-final-config')
})
it.skipIf(process.platform === 'win32')('refuses a pending symlink without changing its target or retained final file', async () => {
  const f = await fixture(), protectedFile = join(f.directory, 'protected-fixture')
  await writeFile(protectedFile, 'unmodified-protected-fixture'); await symlink(protectedFile, f.pending)
  expect(await f.run()).toEqual(refusal)
  expect((await lstat(f.pending)).isSymbolicLink()).toBe(true)
  expect(await readFile(protectedFile, 'utf8')).toBe('unmodified-protected-fixture')
  expect(await readFile(f.final, 'utf8')).toBe('retained-final-config')
})
it('refuses a pending directory without replacing it or the retained final file', async () => {
  const f = await fixture(); await mkdir(f.pending)
  expect(await f.run()).toEqual(refusal)
  expect((await lstat(f.pending)).isDirectory()).toBe(true)
  expect(await readFile(f.final, 'utf8')).toBe('retained-final-config')
})
it('replaces an owned regular incomplete pending file and still supports a normal init retry', async () => {
  const f = await fixture(); await writeFile(f.pending, 'incomplete owned configuration that must be fully replaced', { mode: 0o600 })
  for (let index = 0; index < 2; index++) {
    expect(await f.run()).toEqual({ code: 0, signal: null, stdout: '', stderr: '' })
    expect(await readFile(f.final, 'utf8')).toBe(f.configuration)
    const stat = await lstat(f.final)
    expect(stat.isFile()).toBe(true); expect(stat.nlink).toBe(1); expect(stat.mode & 0o777).toBe(0o600)
    await expect(lstat(f.pending)).rejects.toHaveProperty('code', 'ENOENT')
  }
})
