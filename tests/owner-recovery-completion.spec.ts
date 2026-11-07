import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, unlink, chmod, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { currentOwnerContext } from '../src/runtime/owner-context.ts'
import { inspectRuntimeLockRecovery, completeRuntimeLockRecovery, recoverRuntimeLock, RuntimeOwnerLock } from '../src/runtime/owner-lock.ts'
import { LocalRuntime } from '../src/runtime/local.ts'
import { main } from '../src/cli.ts'

// Source boundary tests: real private files and naturally exited child PIDs;
// Linux kernel identity is explicitly doubled on this macOS test host.
vi.mock('../src/runtime/owner-context.ts', () => ({ currentOwnerContext: vi.fn() }))
const context = vi.mocked(currentOwnerContext)
const normal: typeof currentOwnerContext = async (_path, info) => ({ platform: 'linux', bootId: 'b30ec848-ecf6-47b1-8785-dcd270180c12',
  pidNamespace: { dev: '4', ino: '4026531836' }, filesystemType: '61267', directory: { dev: String(info.dev), ino: String(info.ino) } })
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
afterEach(() => { context.mockReset(); vi.restoreAllMocks() })
async function exitedPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => {
    if (code !== 0 || signal !== null) reject(Error('Child did not exit normally.')); else resolve()
  }) })
  expect(() => process.kill(child.pid!, 0)).toThrow(); return child.pid!
}
type Stage = 'intent-only' | 'lock-retained' | 'released-before-receipt' | 'receipt-retained'
async function fixture(stage: Stage = 'lock-retained') {
  context.mockImplementation(normal)
  const path = await mkdtemp(join(tmpdir(), 'jevable-recovery-complete-')), guard = join(path, 'runtime.recovery.lock')
  const identity = (await normal(path, await lstat(path, { bigint: true })))!
  const lock = { schemaVersion: 1, kind: 'JevableRuntimeLock', pid: await exitedPid(), owner: randomUUID(), startedAt: new Date().toISOString(), recoveryContext: identity }
  const bytes = Buffer.from(JSON.stringify(lock) + '\n')
  const request = { requestId: randomUUID(), owner: lock.owner, lockSha256: hash(bytes), confirm: true as const }
  const intent = { schemaVersion: 2, request, lock, recoveryOwner: { pid: await exitedPid(), owner: randomUUID(), context: identity } }
  await mkdir(guard, { mode: 0o700 })
  await writeFile(join(guard, 'intent.json'), JSON.stringify(intent) + '\n', { mode: 0o600, flag: 'wx' })
  await writeFile(join(path, 'runtime.sqlite'), 'PRIVATE_NOT_SQLITE', { mode: 0o600, flag: 'wx' })
  if (stage === 'intent-only' || stage === 'lock-retained') await writeFile(join(path, 'runtime.lock'), bytes, { mode: 0o600, flag: 'wx' })
  if (stage !== 'intent-only') await writeFile(join(guard, 'runtime.lock'), bytes, { mode: 0o600, flag: 'wx' })
  const receipt = { schemaVersion: 1, kind: 'JevableRuntimeLockRecovery', status: 'released', request, lock,
    lockBytes: bytes.length, completedAt: new Date().toISOString(), database: 'not-opened', execution: 'not-started' }
  if (stage === 'receipt-retained') await writeFile(join(guard, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  return { path, guard, identity, lock, bytes, request, intent, receipt }
}
async function saveIntent(f: Awaited<ReturnType<typeof fixture>>, intent: unknown) { await writeFile(join(f.guard, 'intent.json'), JSON.stringify(intent) + '\n') }
async function cli(args: string[]) { let stdout = '', stderr = ''; const code = await main(args, { out: t => { stdout += t }, err: t => { stderr += t } }); return { code, stdout, stderr } }

describe('explicit completion of proof-bearing interrupted recovery', () => {
  it.each<Stage>(['intent-only', 'lock-retained', 'released-before-receipt', 'receipt-retained'])('completes %s with exact preserved bytes and no SQLite access or workflow execution', async stage => {
    const f = await fixture(stage), before = await lstat(join(f.path, 'runtime.sqlite'))
    expect(await inspectRuntimeLockRecovery(f.path)).toMatchObject({ stage, completionEligible: true, reason: 'eligible', ownerProcess: 'absent', recoveryProcess: 'absent', database: 'not-opened' })
    expect(await readdir(f.guard)).not.toContain('completion')
    await expect(LocalRuntime.open({ dataDirectory: f.path })).rejects.toMatchObject({ code: 'busy' })
    const receiptBytes = stage === 'receipt-retained' ? await readFile(join(f.guard, 'receipt.json')) : undefined
    const receipt = await completeRuntimeLockRecovery(f.path, f.request)
    const archive = join(f.path, 'runtime-lock-recoveries', f.request.requestId)
    expect(receipt).toMatchObject({ status: 'released', request: f.request, lock: f.lock, database: 'not-opened', execution: 'not-started' })
    if (receiptBytes) { expect(receipt).toEqual(f.receipt); expect(await readFile(join(archive, 'receipt.json'))).toEqual(receiptBytes) }
    expect(await readFile(join(archive, 'runtime.lock'))).toEqual(f.bytes)
    expect(JSON.parse(await readFile(join(archive, 'intent.json'), 'utf8'))).toEqual(f.intent)
    expect((await lstat(join(archive, 'completion'))).mode & 0o777).toBe(0o700)
    expect((await lstat(join(archive, 'completion', 'owner.json'))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(f.path, 'runtime.sqlite'), 'utf8')).toBe('PRIVATE_NOT_SQLITE')
    expect((await lstat(join(f.path, 'runtime.sqlite'))).mtimeMs).toBe(before.mtimeMs)
    expect((await readdir(f.path)).sort()).toEqual(['runtime-lock-recoveries', 'runtime.sqlite'])
    const live = await RuntimeOwnerLock.acquire(f.path)
    try {
      const bytes = await readFile(join(f.path, 'runtime.lock'))
      expect(await completeRuntimeLockRecovery(f.path, f.request)).toEqual(receipt)
      expect(await recoverRuntimeLock(f.path, f.request)).toEqual(receipt)
      expect(await readFile(join(f.path, 'runtime.lock'))).toEqual(bytes)
    } finally { await live.release() }
  })
  it.each(['owner', 'recoverer'])('refuses a live %s before claiming or mutating storage', async actor => {
    const f = await fixture()
    const intent = actor === 'owner' ? { ...f.intent, lock: { ...f.lock, pid: process.pid } } : { ...f.intent, recoveryOwner: { ...f.intent.recoveryOwner, pid: process.pid } }
    if (actor === 'owner') {
      const bytes = Buffer.from(JSON.stringify(intent.lock) + '\n'), request = { ...f.request, lockSha256: hash(bytes) }
      intent.request = request; f.request = request
      await writeFile(join(f.path, 'runtime.lock'), bytes); await writeFile(join(f.guard, 'runtime.lock'), bytes)
    }
    await saveIntent(f, intent)
    expect(await inspectRuntimeLockRecovery(f.path)).toMatchObject({ reason: 'process-not-proven-exited', completionEligible: false })
    await expect(completeRuntimeLockRecovery(f.path, f.request)).rejects.toMatchObject({ code: 'conflict' })
    expect(await readdir(f.guard)).not.toContain('completion')
  })
  it('never treats unknown PID permission as proof of exited processes', async () => {
    const f = await fixture()
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(Error(), { code: 'EPERM' }) })
    expect(await inspectRuntimeLockRecovery(f.path)).toMatchObject({ ownerProcess: 'unknown', recoveryProcess: 'unknown', completionEligible: false })
    await expect(completeRuntimeLockRecovery(f.path, f.request)).rejects.toMatchObject({ code: 'conflict' })
    expect(await readdir(f.guard)).not.toContain('completion')
  })
  it.each(['unsupported', 'boot', 'namespace', 'directory'])('refuses %s context without probing PIDs or making a claim', async kind => {
    const f = await fixture(), signal = vi.spyOn(process, 'kill')
    context.mockImplementation(async (...args) => kind === 'unsupported' ? null : { ...(await normal(...args))!,
      ...(kind === 'boot' ? { bootId: randomUUID() } : kind === 'namespace' ? { pidNamespace: { dev: '9', ino: '9' } } : { directory: { dev: '9', ino: '9' } }) })
    expect(await inspectRuntimeLockRecovery(f.path)).toMatchObject({ completionEligible: false, ownerProcess: 'not-probed', recoveryProcess: 'not-probed' })
    await expect(completeRuntimeLockRecovery(f.path, f.request)).rejects.toMatchObject({ code: 'conflict' })
    expect(signal).not.toHaveBeenCalled(); expect(await readdir(f.guard)).not.toContain('completion')
  })
  it.each(['owner', 'lockSha256', 'requestId', 'confirm'])('refuses changed request %s before the claim', async field => {
    const f = await fixture(), changed = { ...f.request, [field]: field === 'confirm' ? false : field === 'lockSha256' ? '0'.repeat(64) : randomUUID() }
    await expect(completeRuntimeLockRecovery(f.path, changed as typeof f.request)).rejects.toThrow()
    expect(await readdir(f.guard)).not.toContain('completion')
  })
  it('does not complete legacy v1 intent, infer a missing original byte copy, or bypass an existing completion', async () => {
    const legacy = await fixture(); await saveIntent(legacy, { schemaVersion: 1, request: legacy.request, lock: legacy.lock })
    expect(await inspectRuntimeLockRecovery(legacy.path)).toMatchObject({ reason: 'legacy-intent', completionEligible: false })
    await expect(completeRuntimeLockRecovery(legacy.path, legacy.request)).rejects.toMatchObject({ code: 'conflict' })
    const missing = await fixture('intent-only'); await unlink(join(missing.path, 'runtime.lock'))
    await expect(completeRuntimeLockRecovery(missing.path, missing.request)).rejects.toMatchObject({ code: 'conflict' })
    const claimed = await fixture(); await mkdir(join(claimed.guard, 'completion'), { mode: 0o700 })
    expect(await inspectRuntimeLockRecovery(claimed.path)).toMatchObject({ reason: 'completion-claimed', completionEligible: false })
    await expect(completeRuntimeLockRecovery(claimed.path, claimed.request)).rejects.toMatchObject({ code: 'conflict' })
    expect(await readdir(join(claimed.guard, 'completion'))).toEqual([])
  })
  it('retains finalized v1 receipt-only compatibility without touching a new live owner', async () => {
    const f = await fixture('receipt-retained')
    await saveIntent(f, { schemaVersion: 1, request: f.request, lock: f.lock })
    const archives = join(f.path, 'runtime-lock-recoveries'); await mkdir(archives, { mode: 0o700 })
    await rename(f.guard, join(archives, f.request.requestId))
    const live = await RuntimeOwnerLock.acquire(f.path)
    try {
      const bytes = await readFile(join(f.path, 'runtime.lock'))
      expect(await completeRuntimeLockRecovery(f.path, f.request)).toEqual(f.receipt)
      expect(await recoverRuntimeLock(f.path, f.request)).toEqual(f.receipt)
      expect(await readFile(join(f.path, 'runtime.lock'))).toEqual(bytes)
      expect(await readFile(join(f.path, 'runtime.sqlite'), 'utf8')).toBe('PRIVATE_NOT_SQLITE')
    } finally { await live.release() }
  })
  it.each(['symlink-intent', 'public-intent', 'public-guard', 'unknown-file', 'wrong-retained', 'replacement', 'bad-receipt'])('refuses %s without altering the transaction', async kind => {
    const f = await fixture(kind === 'bad-receipt' ? 'receipt-retained' : 'lock-retained')
    if (kind === 'symlink-intent') { await rename(join(f.guard, 'intent.json'), join(f.path, 'intent')); await symlink(join(f.path, 'intent'), join(f.guard, 'intent.json')) }
    if (kind === 'public-intent') await chmod(join(f.guard, 'intent.json'), 0o644)
    if (kind === 'public-guard') await chmod(f.guard, 0o755)
    if (kind === 'unknown-file') await writeFile(join(f.guard, 'foreign'), 'unknown', { mode: 0o600 })
    if (kind === 'wrong-retained') await writeFile(join(f.guard, 'runtime.lock'), '{}')
    if (kind === 'replacement') await writeFile(join(f.path, 'runtime.lock'), '{}')
    if (kind === 'bad-receipt') await writeFile(join(f.guard, 'receipt.json'), JSON.stringify({ ...f.receipt, lockBytes: 1 }))
    const names = await readdir(f.guard)
    await expect(inspectRuntimeLockRecovery(f.path)).rejects.toThrow()
    await expect(completeRuntimeLockRecovery(f.path, f.request)).rejects.toThrow()
    expect(await readdir(f.guard)).toEqual(names); expect(names).not.toContain('completion')
  })
  it('refuses incomplete existing archive or an initial lock with no interrupted barrier', async () => {
    const f = await fixture(); await mkdir(join(f.path, 'runtime-lock-recoveries', f.request.requestId), { recursive: true, mode: 0o700 })
    await expect(completeRuntimeLockRecovery(f.path, f.request)).rejects.toMatchObject({ code: 'conflict' })
    expect(await readdir(f.guard)).not.toContain('completion')
    const initial = await fixture('intent-only'); await rename(initial.guard, join(initial.path, 'kept-evidence'))
    await expect(completeRuntimeLockRecovery(initial.path, initial.request)).rejects.toThrow()
    expect(await readFile(join(initial.path, 'runtime.lock'))).toEqual(initial.bytes)
    expect(await readdir(initial.path)).not.toContain('runtime-lock-recoveries')
  })
  it('keeps the completion claim and original lock on a post-claim identity failure; no automatic takeover', async () => {
    const f = await fixture(); context.mockImplementationOnce(normal).mockResolvedValueOnce(null)
    await expect(completeRuntimeLockRecovery(f.path, f.request)).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(join(f.path, 'runtime.lock'))).toEqual(f.bytes)
    expect(await readdir(join(f.guard, 'completion'))).toEqual(['owner.json'])
    await expect(LocalRuntime.open({ dataDirectory: f.path })).rejects.toMatchObject({ code: 'busy' })
    await expect(completeRuntimeLockRecovery(f.path, f.request)).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(join(f.path, 'runtime.sqlite'), 'utf8')).toBe('PRIVATE_NOT_SQLITE')
  })
  it('coordinates concurrent matching completers without overwriting the sole archive or receipt', async () => {
    const f = await fixture()
    const results = await Promise.allSettled([completeRuntimeLockRecovery(f.path, f.request), completeRuntimeLockRecovery(f.path, f.request)])
    const receipts = results.filter(r => r.status === 'fulfilled').map(r => r.value)
    expect(receipts.length).toBeGreaterThanOrEqual(1)
    for (const receipt of receipts) expect(receipt).toEqual(receipts[0])
    expect(await readdir(join(f.path, 'runtime-lock-recoveries'))).toEqual([f.request.requestId])
    expect(await readFile(join(f.path, 'runtime-lock-recoveries', f.request.requestId, 'runtime.lock'))).toEqual(f.bytes)
  })
  it('admits real CLI inspection/completion and refuses unsupported flags/formats before filesystem access', async () => {
    const f = await fixture('released-before-receipt')
    const inspected = await cli(['runtime', 'lock', 'inspect-recovery', '--state-dir', f.path])
    expect(inspected.code).toBe(0); expect(JSON.parse(inspected.stdout)).toMatchObject({ completionEligible: true, stage: 'released-before-receipt' })
    const completed = await cli(['runtime', 'lock', 'complete-recovery', '--state-dir', f.path, '--request-id', f.request.requestId,
      '--owner', f.request.owner, '--lock-sha256', f.request.lockSha256, '--confirm-recover'])
    expect(completed.code).toBe(0); expect(JSON.parse(completed.stdout)).toMatchObject({ status: 'released' })
    context.mockClear()
    for (const operation of ['inspect-recovery', 'complete-recovery']) {
      expect((await cli(['help', 'runtime', 'lock', operation, '--json'])).code).toBe(0)
      for (const args of [[], ['--data-dir', 'not-created'], ['--state-dir', 'not-created', '--endpoint', 'https://not-contacted.invalid'],
        ['--state-dir', 'not-created', '--telemetry-file', 'not-read'], ['--state-dir', 'not-created', '--request-id', 'bad']]) {
        const result = await cli(['runtime', 'lock', operation, ...args]); expect(result.code).toBe(2); expect(result.stdout).toBe('')
      }
    }
    expect(context).not.toHaveBeenCalled()
  })
})
