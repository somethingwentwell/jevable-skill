import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, symlink, readlink, rename, chmod, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { currentOwnerContext } from '../src/runtime/owner-context.ts'
import { recoverRuntimeLock, inspectRuntimeLockRecovery, completeRuntimeLockRecovery, RuntimeOwnerLock } from '../src/runtime/owner-lock.ts'
import { LocalRuntime } from '../src/runtime/local.ts'

// Observe a real filesystem publication call, with Linux kernel context doubled
// on macOS. Ordinary private files, symlinks and naturally exited PIDs are real.
const hooks = vi.hoisted(() => ({ beforePublish: undefined as undefined | ((target: string, path: string) => Promise<void>) }))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return { ...actual, symlink: async (...args: Parameters<typeof actual.symlink>) => {
    if (hooks.beforePublish) await hooks.beforePublish(String(args[0]), String(args[1]))
    return actual.symlink(...args)
  } }
})
vi.mock('../src/runtime/owner-context.ts', () => ({ currentOwnerContext: vi.fn() }))
const context = vi.mocked(currentOwnerContext)
const normal: typeof currentOwnerContext = async (_path, info) => ({ platform: 'linux', bootId: 'e7f7418d-0943-49ae-b4af-f94b3587c4ca',
  pidNamespace: { dev: '4', ino: '4026531836' }, filesystemType: '61267', directory: { dev: String(info.dev), ino: String(info.ino) } })
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
afterEach(() => { hooks.beforePublish = undefined; context.mockReset(); vi.restoreAllMocks() })
async function exitedPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => {
    if (code !== 0 || signal !== null) reject(Error('Child did not exit normally.')); else resolve()
  }) }); expect(() => process.kill(child.pid!, 0)).toThrow(); return child.pid!
}
async function fixture() {
  context.mockImplementation(normal)
  const path = await realpath(await mkdtemp(join(tmpdir(), 'jevable-owner-publication-'))), identity = (await normal(path, await lstat(path, { bigint: true })))!
  const lock = { schemaVersion: 1, kind: 'JevableRuntimeLock', pid: await exitedPid(), owner: randomUUID(), startedAt: new Date().toISOString(), recoveryContext: identity }
  const bytes = Buffer.from(JSON.stringify(lock) + '\n'), request = { requestId: randomUUID(), owner: lock.owner, lockSha256: hash(bytes), confirm: true as const }
  await writeFile(join(path, 'runtime.lock'), bytes, { mode: 0o600, flag: 'wx' })
  await writeFile(join(path, 'runtime.sqlite'), 'PRIVATE_NOT_SQLITE', { mode: 0o600, flag: 'wx' })
  return { path, identity, lock, bytes, request }
}
async function published(stage: 'lock-retained' | 'released-before-receipt' | 'receipt-retained' | 'archived-before-barrier-release' = 'lock-retained') {
  const f = await fixture(), recoverer = { pid: await exitedPid(), owner: randomUUID(), context: f.identity }
  const requestRoot = join(f.path, 'runtime-lock-preparations', f.request.requestId)
  await mkdir(requestRoot, { mode: 0o700, recursive: true }); await writeFile(join(requestRoot, 'request.json'), JSON.stringify(f.request), { mode: 0o600 })
  const guard = join(requestRoot, recoverer.owner); await mkdir(guard, { mode: 0o700 })
  await writeFile(join(guard, 'intent.json'), JSON.stringify({ schemaVersion: 2, request: f.request, lock: f.lock, recoveryOwner: recoverer }), { mode: 0o600 })
  await writeFile(join(guard, 'runtime.lock'), f.bytes, { mode: 0o600 })
  await writeFile(join(guard, 'publication.json'), JSON.stringify({ schemaVersion: 1, kind: 'JevableRecoveryPublication', requestId: f.request.requestId, recoveryOwnerId: recoverer.owner }), { mode: 0o600 })
  const receipt = { schemaVersion: 1, kind: 'JevableRuntimeLockRecovery', status: 'released', request: f.request, lock: f.lock,
    lockBytes: f.bytes.length, completedAt: new Date().toISOString(), database: 'not-opened', execution: 'not-started' }
  if (stage !== 'lock-retained') await (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).unlink(join(f.path, 'runtime.lock'))
  if (stage === 'receipt-retained' || stage === 'archived-before-barrier-release') await writeFile(join(guard, 'receipt.json'), JSON.stringify(receipt) + '\n', { mode: 0o600 })
  const target = `runtime-lock-preparations/${f.request.requestId}/${recoverer.owner}`
  await symlink(target, join(f.path, 'runtime.recovery.lock'))
  if (stage === 'archived-before-barrier-release') {
    await mkdir(join(f.path, 'runtime-lock-recoveries'), { mode: 0o700 }); await rename(guard, join(f.path, 'runtime-lock-recoveries', f.request.requestId))
  }
  return { ...f, guard, target, recoverer, receipt, requestRoot }
}

describe('proof-before-exclusion atomic recovery publication', () => {
  it('publishes only after complete private proof exists, retains a completion claim, and never opens SQLite', async () => {
    const f = await fixture(), db = await lstat(join(f.path, 'runtime.sqlite')); let observed = false
    hooks.beforePublish = async (target, barrier) => {
      expect(barrier).toBe(join(f.path, 'runtime.recovery.lock')); await expect(lstat(barrier)).rejects.toMatchObject({ code: 'ENOENT' })
      const guard = join(f.path, target), intent = JSON.parse(await readFile(join(guard, 'intent.json'), 'utf8'))
      expect(intent).toMatchObject({ schemaVersion: 2, request: f.request, recoveryOwner: { pid: process.pid } })
      expect(await readFile(join(guard, 'runtime.lock'))).toEqual(f.bytes)
      expect(await readFile(join(f.path, 'runtime.lock'))).toEqual(f.bytes)
      expect(JSON.parse(await readFile(join(guard, 'publication.json'), 'utf8'))).toMatchObject({ requestId: f.request.requestId, recoveryOwnerId: intent.recoveryOwner.owner })
      expect((await lstat(guard)).mode & 0o777).toBe(0o700)
      for (const name of ['intent.json', 'runtime.lock', 'publication.json']) expect((await lstat(join(guard, name))).mode & 0o777).toBe(0o600)
      observed = true
    }
    const receipt = await recoverRuntimeLock(f.path, f.request); expect(observed).toBe(true); expect(receipt.status).toBe('released')
    expect((await readdir(f.path)).sort()).toEqual(['runtime-lock-preparations', 'runtime-lock-recoveries', 'runtime.sqlite'])
    expect(await readFile(join(f.path, 'runtime.sqlite'), 'utf8')).toBe('PRIVATE_NOT_SQLITE'); expect((await lstat(join(f.path, 'runtime.sqlite'))).mtimeMs).toBe(db.mtimeMs)
    expect(JSON.parse(await readFile(join(f.path, 'runtime-lock-recoveries', f.request.requestId, 'completion', 'owner.json'), 'utf8'))).toMatchObject({ pid: process.pid, context: f.identity })
  })
  it('a prepublication failure leaves no barrier, preserves all prepared proof, and retries the same request without replay', async () => {
    const f = await fixture(), db = await lstat(join(f.path, 'runtime.sqlite')); let staged = ''
    hooks.beforePublish = async target => { staged = join(f.path, target); throw Error('controlled-prepublication-failure') }
    await expect(recoverRuntimeLock(f.path, f.request)).rejects.toThrow('controlled-prepublication-failure')
    await expect(lstat(join(f.path, 'runtime.recovery.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.path, 'runtime.lock'))).toEqual(f.bytes)
    const saved = await readFile(join(staged, 'intent.json')); expect(await readFile(join(staged, 'runtime.lock'))).toEqual(f.bytes)
    hooks.beforePublish = undefined
    expect((await recoverRuntimeLock(f.path, f.request)).status).toBe('released')
    expect(await readFile(join(staged, 'intent.json'))).toEqual(saved); expect(await readFile(join(staged, 'runtime.lock'))).toEqual(f.bytes)
    expect((await lstat(join(f.path, 'runtime.sqlite'))).mtimeMs).toBe(db.mtimeMs)
  })
  it('an empty older barrier arriving just before publication is never replaced or repaired', async () => {
    const f = await fixture(); let original: Awaited<ReturnType<typeof lstat>> | undefined
    hooks.beforePublish = async (_target, barrier) => { await mkdir(barrier, { mode: 0o700 }); original = await lstat(barrier) }
    await expect(recoverRuntimeLock(f.path, f.request)).rejects.toMatchObject({ code: 'busy' })
    expect((await lstat(join(f.path, 'runtime.recovery.lock'))).ino).toBe(original!.ino)
    expect(await readdir(join(f.path, 'runtime.recovery.lock'))).toEqual([]); expect(await readFile(join(f.path, 'runtime.lock'))).toEqual(f.bytes)
  })
  it('refuses a changed prepublication context before creating an exclusion pointer', async () => {
    const f = await fixture(); context.mockImplementationOnce(normal).mockResolvedValueOnce(null)
    await expect(recoverRuntimeLock(f.path, f.request)).rejects.toMatchObject({ code: 'conflict' })
    await expect(lstat(join(f.path, 'runtime.recovery.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.path, 'runtime.lock'))).toEqual(f.bytes)
  })
  it.each(['invalid', 'different-pins'])('refuses %s staging request metadata without publishing or overwriting it', async kind => {
    const f = await fixture(), root = join(f.path, 'runtime-lock-preparations', f.request.requestId)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const bytes = kind === 'invalid' ? '{' : JSON.stringify({ ...f.request, owner: randomUUID() })
    await writeFile(join(root, 'request.json'), bytes, { mode: 0o600 })
    await expect(recoverRuntimeLock(f.path, f.request)).rejects.toThrow()
    expect(await readFile(join(root, 'request.json'), 'utf8')).toBe(bytes); expect(await readdir(root)).toEqual(['request.json'])
    await expect(lstat(join(f.path, 'runtime.recovery.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['lock-retained', 'released-before-receipt', 'receipt-retained', 'archived-before-barrier-release'] as const)('completes a dead publisher at %s, preserving proof/receipts/storage', async stage => {
    const f = await published(stage), before = await lstat(join(f.path, 'runtime.sqlite'))
    expect(await readlink(join(f.path, 'runtime.recovery.lock'))).toBe(f.target)
    expect(await inspectRuntimeLockRecovery(f.path)).toMatchObject({ stage, completionEligible: true, recoveryProcess: 'absent' })
    await expect(LocalRuntime.open({ dataDirectory: f.path })).rejects.toMatchObject({ code: 'busy' })
    const receipt = await completeRuntimeLockRecovery(f.path, f.request)
    expect(receipt).toMatchObject({ status: 'released', request: f.request, execution: 'not-started', database: 'not-opened' })
    if (stage === 'receipt-retained' || stage === 'archived-before-barrier-release') expect(receipt).toEqual(f.receipt)
    await expect(lstat(join(f.path, 'runtime.recovery.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.path, 'runtime-lock-recoveries', f.request.requestId, 'runtime.lock'))).toEqual(f.bytes)
    expect((await lstat(join(f.path, 'runtime.sqlite'))).mtimeMs).toBe(before.mtimeMs)
    const live = await RuntimeOwnerLock.acquire(f.path)
    try { const bytes = await readFile(join(f.path, 'runtime.lock')); expect(await completeRuntimeLockRecovery(f.path, f.request)).toEqual(receipt); expect(await readFile(join(f.path, 'runtime.lock'))).toEqual(bytes) }
    finally { await live.release() }
  })
  it.each(['absolute', 'traversal', 'wrong-prefix', 'oversize'])('refuses %s pointers before probing PIDs or reading arbitrary targets', async kind => {
    const f = await fixture(), target = kind === 'absolute' ? '/not-read/intent.json' : kind === 'traversal' ? '../not-read' : kind === 'oversize' ? 'x'.repeat(257) : `other/${randomUUID()}/${randomUUID()}`
    await symlink(target, join(f.path, 'runtime.recovery.lock')); const signal = vi.spyOn(process, 'kill')
    await expect(inspectRuntimeLockRecovery(f.path)).rejects.toMatchObject({ code: 'conflict' })
    await expect(completeRuntimeLockRecovery(f.path, f.request)).rejects.toMatchObject({ code: 'conflict' })
    expect(signal).not.toHaveBeenCalled(); expect(await readlink(join(f.path, 'runtime.recovery.lock'))).toBe(target)
  })
  it.each(['parent-symlink', 'public-request-root', 'wrong-publication', 'wrong-intent', 'wrong-anchor'])('refuses %s generated-format evidence without repairing it', async kind => {
    const f = await published()
    if (kind === 'parent-symlink') { await rename(join(f.path, 'runtime-lock-preparations'), join(f.path, 'saved-preparations')); await symlink('saved-preparations', join(f.path, 'runtime-lock-preparations')) }
    if (kind === 'public-request-root') await chmod(f.requestRoot, 0o755)
    if (kind === 'wrong-publication') await writeFile(join(f.guard, 'publication.json'), JSON.stringify({ schemaVersion: 1, kind: 'JevableRecoveryPublication', requestId: f.request.requestId, recoveryOwnerId: randomUUID() }))
    if (kind === 'wrong-intent') await writeFile(join(f.guard, 'intent.json'), JSON.stringify({ schemaVersion: 2, request: f.request, lock: f.lock, recoveryOwner: { ...f.recoverer, owner: randomUUID() } }))
    if (kind === 'wrong-anchor') await writeFile(join(f.requestRoot, 'request.json'), JSON.stringify({ ...f.request, owner: randomUUID() }))
    await expect(completeRuntimeLockRecovery(f.path, f.request)).rejects.toThrow()
    expect(await readlink(join(f.path, 'runtime.recovery.lock'))).toBe(f.target)
    expect(await readFile(join(f.path, 'runtime.lock'))).toEqual(f.bytes)
  })
  it('never bypasses an archived incomplete cleanup claim, even after the old publisher exited', async () => {
    const f = await published('archived-before-barrier-release'), archive = join(f.path, 'runtime-lock-recoveries', f.request.requestId)
    await mkdir(join(archive, 'completion'), { mode: 0o700 })
    expect(await inspectRuntimeLockRecovery(f.path)).toMatchObject({ stage: 'archived-before-barrier-release', reason: 'completion-claimed', completionEligible: false })
    await expect(completeRuntimeLockRecovery(f.path, f.request)).rejects.toMatchObject({ code: 'conflict' })
    expect(await readlink(join(f.path, 'runtime.recovery.lock'))).toBe(f.target); expect(await readdir(join(archive, 'completion'))).toEqual([])
  })
})
