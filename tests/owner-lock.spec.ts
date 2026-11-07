import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, chmod, symlink, link, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { currentOwnerContext } from '../src/runtime/owner-context.ts'
import { inspectRuntimeLock, recoverRuntimeLock, RuntimeOwnerLock } from '../src/runtime/owner-lock.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { main } from '../src/cli.ts'

// Supported-kernel identity is a test double on macOS. Filesystem, exclusion,
// signal-zero checks and naturally exited child PIDs below are real, not simulated.
vi.mock('../src/runtime/owner-context.ts', () => ({ currentOwnerContext: vi.fn() }))
const context = vi.mocked(currentOwnerContext)
const bootId = '34df7911-f150-4a92-a8ce-9f009f1ca061'
const normal: typeof currentOwnerContext = async (_path, info) => ({ platform: 'linux', bootId,
  pidNamespace: { dev: '4', ino: '4026531836' }, filesystemType: '61267', directory: { dev: String(info.dev), ino: String(info.ino) } })
afterEach(() => { context.mockReset(); vi.restoreAllMocks() })
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function fixture() { context.mockImplementation(normal); return await mkdtemp(join(tmpdir(), 'jevable-owner-lock-')) }
async function exitedPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const pid = child.pid!
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => {
    if (code !== 0 || signal !== null) reject(Error('Fixture child did not exit normally.')); else resolve()
  }) })
  expect(() => process.kill(pid, 0)).toThrow()
  return pid
}
async function stale(path: string) {
  const pid = await exitedPid(), owner = randomUUID(), info = await lstat(path, { bigint: true })
  const record = { schemaVersion: 1, kind: 'JevableRuntimeLock', pid, owner, startedAt: new Date().toISOString(), recoveryContext: await normal(path, info) }
  const bytes = Buffer.from(JSON.stringify(record) + '\n')
  await writeFile(join(path, 'runtime.lock'), bytes, { mode: 0o600, flag: 'wx' })
  await writeFile(join(path, 'runtime.sqlite'), 'PRIVATE_NOT_A_DATABASE', { mode: 0o600, flag: 'wx' })
  return { record, bytes, request: { requestId: randomUUID(), owner, lockSha256: hash(bytes), confirm: true as const } }
}
async function cli(args: string[]) { let stdout = '', stderr = ''; const code = await main(args, { out: t => { stdout += t }, err: t => { stderr += t } }); return { code, stdout, stderr } }

describe('explicit cooperative SQLite owner recovery', () => {
  it('retains a versioned live owner and refuses inspection-based removal while that PID exists', async () => {
    const path = await fixture(), lock = await RuntimeOwnerLock.acquire(path)
    try {
      const result = await inspectRuntimeLock(path)
      expect(result).toMatchObject({ recoveryEligible: false, reason: 'owner-not-proven-exited', process: 'present' })
      await expect(recoverRuntimeLock(path, { requestId: randomUUID(), owner: result.owner, lockSha256: result.lockSha256, confirm: true })).rejects.toMatchObject({ code: 'conflict' })
      expect(await readdir(path)).toEqual(['runtime.lock'])
    } finally { await lock.release() }
  })

  it('preserves exact lock bytes and a durable receipt, releases only that owner, and never opens SQLite', async () => {
    const path = await fixture(), { request, bytes } = await stale(path)
    const before = await lstat(join(path, 'runtime.sqlite'))
    expect(await inspectRuntimeLock(path)).toMatchObject({ recoveryEligible: true, reason: 'owner-exited', process: 'absent' })
    const receipt = await recoverRuntimeLock(path, request)
    expect(receipt).toMatchObject({ status: 'released', request, lockBytes: bytes.length, database: 'not-opened', execution: 'not-started' })
    const archive = join(path, 'runtime-lock-recoveries', request.requestId)
    expect(await readFile(join(archive, 'runtime.lock'))).toEqual(bytes)
    expect(JSON.parse(await readFile(join(archive, 'receipt.json'), 'utf8'))).toEqual(receipt)
    expect((await lstat(archive)).mode & 0o777).toBe(0o700)
    for (const name of ['runtime.lock', 'intent.json', 'receipt.json']) expect((await lstat(join(archive, name))).mode & 0o777).toBe(0o600)
    expect((await lstat(join(path, 'runtime.sqlite'))).mtimeMs).toBe(before.mtimeMs)
    expect(await readFile(join(path, 'runtime.sqlite'), 'utf8')).toBe('PRIVATE_NOT_A_DATABASE')
    expect((await readdir(path)).sort()).toEqual(['runtime-lock-preparations', 'runtime-lock-recoveries', 'runtime.sqlite'])
    const replacement = await RuntimeOwnerLock.acquire(path)
    try {
      const replacementBytes = await readFile(join(path, 'runtime.lock'))
      expect(await recoverRuntimeLock(path, request)).toEqual(receipt)
      expect(await readFile(join(path, 'runtime.lock'))).toEqual(replacementBytes)
      await expect(recoverRuntimeLock(path, { ...request, owner: randomUUID() })).rejects.toMatchObject({ code: 'conflict' })
    } finally { await replacement.release() }
  })

  it.each(['owner', 'lockSha256', 'confirm', 'requestId'])('refuses the wrong %s before creating recovery artifacts', async field => {
    const path = await fixture(), { request, bytes } = await stale(path)
    const wrong = { ...request, [field]: field === 'owner' ? randomUUID() : field === 'lockSha256' ? '0'.repeat(64) : field === 'confirm' ? false : 'invalid' }
    await expect(recoverRuntimeLock(path, wrong as typeof request)).rejects.toThrow()
    expect((await readdir(path)).sort()).toEqual(['runtime.lock', 'runtime.sqlite'])
    expect(await readFile(join(path, 'runtime.lock'))).toEqual(bytes)
  })

  it.each(['bootId', 'pidNamespace', 'directory', 'filesystemType'])('refuses mismatched %s without probing the PID or modifying files', async field => {
    const path = await fixture(), { request, bytes } = await stale(path)
    context.mockImplementation(async (...args) => ({ ...(await normal(...args))!, [field]: field === 'bootId' ? randomUUID() : field === 'filesystemType' ? '999' : { dev: '999', ino: '999' } }))
    const signal = vi.spyOn(process, 'kill')
    expect(await inspectRuntimeLock(path)).toMatchObject({ recoveryEligible: false, reason: 'context-mismatch', process: 'not-probed' })
    await expect(recoverRuntimeLock(path, request)).rejects.toMatchObject({ code: 'conflict' })
    expect(signal).not.toHaveBeenCalled(); expect(await readFile(join(path, 'runtime.lock'))).toEqual(bytes)
    expect((await readdir(path)).sort()).toEqual(['runtime.lock', 'runtime.sqlite'])
  })

  it('refuses unsupported identity and legacy PID-only locks without PID guesses', async () => {
    const path = await fixture(), { record, request } = await stale(path), signal = vi.spyOn(process, 'kill')
    context.mockResolvedValue(null)
    expect(await inspectRuntimeLock(path)).toMatchObject({ reason: 'unsupported-context', recoveryEligible: false })
    await expect(recoverRuntimeLock(path, request)).rejects.toMatchObject({ code: 'conflict' })
    await writeFile(join(path, 'runtime.lock'), JSON.stringify({ pid: record.pid, owner: record.owner, startedAt: record.startedAt }))
    expect(await inspectRuntimeLock(path)).toMatchObject({ reason: 'legacy-lock', process: 'not-probed', recoveryEligible: false })
    await expect(recoverRuntimeLock(path, request)).rejects.toMatchObject({ code: 'conflict' })
    expect(signal).not.toHaveBeenCalled()
  })

  it('treats EPERM as unknown, never as proof of absence', async () => {
    const path = await fixture(), { request } = await stale(path)
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(Error('not allowed'), { code: 'EPERM' }) })
    expect(await inspectRuntimeLock(path)).toMatchObject({ recoveryEligible: false, process: 'unknown' })
    await expect(recoverRuntimeLock(path, request)).rejects.toMatchObject({ code: 'conflict' })
  })

  it.each(['invalid-json', 'invalid-utf8', 'unknown-field', 'oversize', 'empty'])('refuses %s lock bytes without recovery artifacts', async kind => {
    const path = await fixture(), { record, request } = await stale(path)
    const bytes = kind === 'invalid-json' ? '{' : kind === 'invalid-utf8' ? Buffer.from([0xff]) : kind === 'unknown-field' ? JSON.stringify({ ...record, extra: true }) : kind === 'oversize' ? 'x'.repeat(4097) : ''
    await writeFile(join(path, 'runtime.lock'), bytes)
    await expect(inspectRuntimeLock(path)).rejects.toThrow()
    await expect(recoverRuntimeLock(path, request)).rejects.toThrow()
    expect((await readdir(path)).sort()).toEqual(['runtime.lock', 'runtime.sqlite'])
  })

  it.each(['symlink', 'hardlink', 'public-file', 'public-directory'])('refuses %s rather than following or repairing it', async kind => {
    const path = await fixture(), { request, bytes } = await stale(path), lock = join(path, 'runtime.lock')
    if (kind === 'symlink') { await rename(lock, join(path, 'original')); await symlink(join(path, 'original'), lock) }
    if (kind === 'hardlink') await link(lock, join(path, 'alias'))
    if (kind === 'public-file') await chmod(lock, 0o644)
    if (kind === 'public-directory') await chmod(path, 0o755)
    await expect(inspectRuntimeLock(path)).rejects.toThrow(); await expect(recoverRuntimeLock(path, request)).rejects.toThrow()
    expect(await readFile(kind === 'symlink' ? join(path, 'original') : lock)).toEqual(bytes)
    expect(await readdir(path)).not.toContain('runtime.recovery.lock')
  })

  it('keeps the barrier and old lock if context changes after the intent is saved; startup never opens SQLite', async () => {
    const path = await fixture(), { request, bytes } = await stale(path)
    context.mockImplementationOnce(normal).mockImplementationOnce(normal).mockResolvedValueOnce(null)
    await expect(recoverRuntimeLock(path, request)).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(join(path, 'runtime.lock'))).toEqual(bytes)
    expect(await readFile(join(path, 'runtime.recovery.lock', 'runtime.lock'))).toEqual(bytes)
    await expect(LocalRuntime.open({ dataDirectory: path })).rejects.toMatchObject({ code: 'busy' })
    await expect(recoverRuntimeLock(path, request)).rejects.toMatchObject({ code: 'busy' })
    expect(await readFile(join(path, 'runtime.sqlite'), 'utf8')).toBe('PRIVATE_NOT_A_DATABASE')
  })

  it('refuses a recovery barrier appearing during owner acquisition and removes only its own new lock', async () => {
    const path = await fixture()
    context.mockImplementation(async (...args) => { await mkdir(join(path, 'runtime.recovery.lock'), { mode: 0o700 }); return normal(...args) })
    await expect(LocalRuntime.open({ dataDirectory: path })).rejects.toMatchObject({ code: 'busy' })
    expect(await readdir(path)).toEqual(['runtime.recovery.lock'])
  })

  it('never removes a replacement inode while the original owner closes', async () => {
    const path = await fixture(), lock = await RuntimeOwnerLock.acquire(path)
    await rename(join(path, 'runtime.lock'), join(path, 'original.lock'))
    await writeFile(join(path, 'runtime.lock'), 'replacement', { mode: 0o600, flag: 'wx' })
    await expect(lock.release()).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(join(path, 'runtime.lock'), 'utf8')).toBe('replacement')
    expect(await readFile(join(path, 'original.lock'), 'utf8')).toContain('JevableRuntimeLock')
  })

  it('allows exactly one concurrent recoverer; retains both request identities without overwriting archives', async () => {
    const path = await fixture(), { request } = await stale(path), other = { ...request, requestId: randomUUID() }
    const results = await Promise.allSettled([recoverRuntimeLock(path, request), recoverRuntimeLock(path, other)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    expect(await readdir(join(path, 'runtime-lock-recoveries'))).toHaveLength(1)
  })

  it('refuses incomplete existing recovery archives before creating a new barrier', async () => {
    const path = await fixture(), { request } = await stale(path)
    await mkdir(join(path, 'runtime-lock-recoveries', request.requestId), { recursive: true, mode: 0o700 })
    await expect(recoverRuntimeLock(path, request)).rejects.toThrow()
    expect(await readdir(path)).not.toContain('runtime.recovery.lock')
  })

  it('admits CLI help and refuses missing pins, unsupported options and wrong formats before filesystem access', async () => {
    expect((await cli(['help', 'runtime', 'lock', 'recover', '--json'])).code).toBe(0)
    for (const args of [[], ['--state-dir', 'never-created'], ['--state-dir', 'never-created', '--request-id', 'bad'], ['--data-dir', 'never-created'],
      ['--state-dir', 'never-created', '--telemetry-file', 'never-read'], ['--state-dir', 'never-created', '--endpoint', 'https://not-contacted.invalid']]) {
      const result = await cli(['runtime', 'lock', 'recover', ...args])
      expect(result.code).toBe(2); expect(result.stdout).toBe('')
    }
    expect(context).not.toHaveBeenCalled()
  })
})
