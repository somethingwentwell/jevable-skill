import { constants, type BigIntStats } from 'node:fs'
import { open, lstat, realpath, mkdir, rename, unlink, readdir, symlink, readlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { WorkflowRuntimeError } from './errors.ts'
import { currentOwnerContext } from './owner-context.ts'

const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/u)
const identitySchema = z.strictObject({ dev: decimal, ino: decimal })
const contextSchema = z.strictObject({ platform: z.literal('linux'), bootId: z.uuid(),
  pidNamespace: identitySchema, filesystemType: decimal, directory: identitySchema })
const lockSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('JevableRuntimeLock'),
  pid: z.number().int().positive().max(2147483647), owner: z.uuid(), startedAt: z.iso.datetime(),
  recoveryContext: contextSchema.nullable() })
const legacySchema = z.strictObject({ pid: z.number().int().positive().max(2147483647), owner: z.uuid(), startedAt: z.iso.datetime() })
const requestSchema = z.strictObject({ requestId: z.uuid(), owner: z.uuid(), lockSha256: z.string().regex(/^[a-f0-9]{64}$/u), confirm: z.literal(true) })
const recoveryOwnerSchema = z.strictObject({ pid: z.number().int().positive().max(2147483647), owner: z.uuid(), context: contextSchema })
const intentSchema = z.union([
  z.strictObject({ schemaVersion: z.literal(1), request: requestSchema, lock: lockSchema }),
  z.strictObject({ schemaVersion: z.literal(2), request: requestSchema, lock: lockSchema, recoveryOwner: recoveryOwnerSchema }),
])
const receiptSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('JevableRuntimeLockRecovery'),
  status: z.literal('released'), request: requestSchema, lock: lockSchema, lockBytes: z.number().int().min(1).max(4096),
  completedAt: z.iso.datetime(), database: z.literal('not-opened'), execution: z.literal('not-started') })
type Lock = z.infer<typeof lockSchema>
type File = Awaited<ReturnType<typeof open>>
export type RuntimeLockRecoveryRequest = z.infer<typeof requestSchema>
export type RuntimeLockRecoveryReceipt = z.infer<typeof receiptSchema>
const LOCK = 'runtime.lock', BARRIER = 'runtime.recovery.lock', ARCHIVES = 'runtime-lock-recoveries'
const COMPLETION = 'completion'
const PREPARATIONS = 'runtime-lock-preparations'
const publicationSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('JevableRecoveryPublication'), requestId: z.uuid(), recoveryOwnerId: z.uuid() })
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const refuse = () => new WorkflowRuntimeError('conflict')

function privateDirectory(info: BigIntStats) {
  if (!info.isDirectory() || (info.mode & 0o077n) || typeof process.getuid !== 'function' || info.uid !== BigInt(process.getuid())) throw refuse()
}
function privateFile(info: BigIntStats) {
  if (!info.isFile() || info.nlink !== 1n || (info.mode & 0o077n) || typeof process.getuid !== 'function' || info.uid !== BigInt(process.getuid())) throw refuse()
}
async function directory(value: string) {
  const path = resolve(value), info = await lstat(path, { bigint: true })
  privateDirectory(info)
  return { path: await realpath(path), info }
}
async function unchangedDirectory(path: string, info: BigIntStats) {
  const current = await lstat(path, { bigint: true }); privateDirectory(current)
  if (!sameFile(current, info)) throw refuse()
}
async function barrierAbsent(path: string) {
  try { await lstat(join(path, BARRIER)); throw new WorkflowRuntimeError('busy') }
  catch (error) { if (!missing(error)) throw error }
}
async function syncDirectory(path: string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await fd.sync() } finally { await fd.close() }
}
async function readFile(path: string, max = 4096) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat({ bigint: true }); privateFile(info)
    if (info.size < 1n || info.size > BigInt(max)) throw refuse()
    const bytes = Buffer.alloc(Number(info.size) + 1), result = await file.read(bytes, 0, bytes.length, 0)
    const after = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true })
    privateFile(after); privateFile(named)
    if (result.bytesRead !== Number(info.size) || !sameFile(info, named) || !sameFile(info, after)
      || info.size !== after.size || info.mtimeNs !== after.mtimeNs || info.ctimeNs !== after.ctimeNs) throw refuse()
    return { bytes: bytes.subarray(0, result.bytesRead), info }
  } finally { await file.close() }
}
function parse(bytes: Uint8Array) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
  catch { throw refuse() }
}

function processState(pid: number): 'present' | 'absent' | 'unknown' {
  try { process.kill(pid, 0); return 'present' }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'unknown' }
}
async function inspectAt(path: string, info: BigIntStats) {
  const saved = await readFile(join(path, LOCK)), value = parse(saved.bytes), decoded = lockSchema.safeParse(value)
  if (!decoded.success) {
    if (!legacySchema.safeParse(value).success) throw refuse()
    return { saved, lock: null, reason: 'legacy-lock' as const, process: 'not-probed' as const }
  }
  const lock = decoded.data, context = await currentOwnerContext(path, info)
  await unchangedDirectory(path, info)
  if (!context || !lock.recoveryContext) return { saved, lock, reason: 'unsupported-context' as const, process: 'not-probed' as const }
  if (!isDeepStrictEqual(lock.recoveryContext, context)) return { saved, lock, reason: 'context-mismatch' as const, process: 'not-probed' as const }
  const state = processState(lock.pid)
  return { saved, lock, reason: state === 'absent' ? 'owner-exited' as const : 'owner-not-proven-exited' as const, process: state }
}

/** Read-only; no directory creation, SQLite, owner acquisition, signal or workflow work. */
export async function inspectRuntimeLock(dataDirectory: string) {
  const { path, info } = await directory(dataDirectory)
  await barrierAbsent(path)
  const result = await inspectAt(path, info)
  return { schemaVersion: 1 as const, kind: 'JevableRuntimeLockInspection' as const,
    lockSha256: hash(result.saved.bytes), owner: result.lock?.owner ?? (legacySchema.parse(parse(result.saved.bytes))).owner,
    pid: result.lock?.pid ?? (legacySchema.parse(parse(result.saved.bytes))).pid,
    recoveryEligible: result.reason === 'owner-exited', reason: result.reason, process: result.process,
    database: 'not-opened' as const, execution: 'not-started' as const }
}

async function writePrivate(path: string, bytes: Uint8Array) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n')

async function privateChild(path: string, parentInfo: BigIntStats) {
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(path, { bigint: true }); privateDirectory(info)
  if (info.dev !== parentInfo.dev) throw refuse()
  return info
}
type Publication = { info: BigIntStats; target: string; requestId: string; recoveryOwnerId: string; request: RuntimeLockRecoveryRequest }
/** Only this owned, bounded, exact generated relative pointer can be resolved.
 * Lock/evidence files and every target directory remain no-follow/private.
 * A dangling pointer is still an exclusion barrier, never an absent barrier. */
async function resolveRecoveryBarrier(path: string, info: BigIntStats) {
  const barrier = join(path, BARRIER), named = await lstat(barrier, { bigint: true })
  if (named.isDirectory()) { privateDirectory(named); return { guard: barrier, guardInfo: named, publication: null, archived: false } }
  if (!named.isSymbolicLink() || named.nlink !== 1n || named.size < 1n || named.size > 256n
    || typeof process.getuid !== 'function' || named.uid !== BigInt(process.getuid())) throw refuse()
  const bytes = await readlink(barrier, { encoding: 'buffer' }), after = await lstat(barrier, { bigint: true })
  if (bytes.length !== Number(named.size) || !sameFile(named, after) || named.mtimeNs !== after.mtimeNs || named.ctimeNs !== after.ctimeNs) throw refuse()
  let target: string
  try { target = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw refuse() }
  const parts = target.split('/')
  if (parts.length !== 3 || parts[0] !== PREPARATIONS || !z.uuid().safeParse(parts[1]).success || !z.uuid().safeParse(parts[2]).success) throw refuse()
  const requestId = parts[1]!, recoveryOwnerId = parts[2]!
  for (const parent of [join(path, PREPARATIONS), join(path, PREPARATIONS, requestId)]) {
    const current = await lstat(parent, { bigint: true }); privateDirectory(current); if (current.dev !== info.dev) throw refuse()
  }
  const request = requestSchema.parse(parse((await readFile(join(path, PREPARATIONS, requestId, 'request.json'))).bytes))
  if (request.requestId !== requestId) throw refuse()
  const publication: Publication = { info: named, target, requestId, recoveryOwnerId, request }
  let guard = join(path, target), archived = false, guardInfo: BigIntStats
  try { guardInfo = await lstat(guard, { bigint: true }) }
  catch (error) {
    if (!missing(error)) throw error
    const root = await lstat(join(path, ARCHIVES), { bigint: true }); privateDirectory(root)
    guard = join(path, ARCHIVES, publication.requestId); guardInfo = await lstat(guard, { bigint: true }); archived = true
  }
  privateDirectory(guardInfo); if (guardInfo.dev !== info.dev) throw refuse()
  const declaration = publicationSchema.parse(parse((await readFile(join(guard, 'publication.json'))).bytes))
  if (declaration.requestId !== publication.requestId || declaration.recoveryOwnerId !== publication.recoveryOwnerId) throw refuse()
  await unchangedDirectory(path, info)
  return { guard, guardInfo, publication, archived }
}
async function samePublication(path: string, info: BigIntStats, expected: Publication, guardInfo: BigIntStats, archived: boolean) {
  const actual = await resolveRecoveryBarrier(path, info)
  if (!actual.publication || !sameFile(actual.publication.info, expected.info) || actual.publication.target !== expected.target
    || !isDeepStrictEqual(actual.publication.request, expected.request) || !sameFile(actual.guardInfo, guardInfo) || actual.archived !== archived) throw refuse()
}
async function claimCompletion(guard: string, context: z.infer<typeof contextSchema> | null) {
  const claim = join(guard, COMPLETION)
  try { await mkdir(claim, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkflowRuntimeError('busy'); throw error }
  const info = await lstat(claim, { bigint: true }); privateDirectory(info)
  await writePrivate(join(claim, 'owner.json'), json({ pid: process.pid, owner: randomUUID(), context }))
  await syncDirectory(claim); await syncDirectory(guard)
  return info
}
/** A held completion claim serializes removal, including the after-archive phase.
 * No stale-claim takeover: a failure keeps the published pointer and evidence. */
async function releasePublication(path: string, info: BigIntStats, publication: Publication, archive: string,
  guardInfo: BigIntStats, claimInfo: BigIntStats, context: z.infer<typeof contextSchema> | null) {
  await samePublication(path, info, publication, guardInfo, true)
  const current = await currentOwnerContext(path, info)
  if (!current || !isDeepStrictEqual(current, context)) throw refuse()
  await unchangedDirectory(join(archive, COMPLETION), claimInfo)
  const holder = recoveryOwnerSchema.parse(parse((await readFile(join(archive, COMPLETION, 'owner.json'))).bytes))
  if (holder.pid !== process.pid || !isDeepStrictEqual(holder.context, current)) throw refuse()
  await samePublication(path, info, publication, guardInfo, true)
  await unlink(join(path, BARRIER)); await syncDirectory(path)
}

/** Explicit same-boot recovery only. Once the barrier exists, any failure retains it.
 * A crash during recovery therefore blocks startup, rather than guessing transaction outcome.
 * This is cooperative locking in a trusted private directory, not protection from a
 * malicious same-UID/root process mutating paths between an identity check and unlink.
 */
export async function recoverRuntimeLock(dataDirectory: string, input: RuntimeLockRecoveryRequest): Promise<RuntimeLockRecoveryReceipt> {
  const request = requestSchema.parse(input), { path, info } = await directory(dataDirectory)
  await barrierAbsent(path)
  const archive = join(path, ARCHIVES, request.requestId)
  let retained = false
  try {
    const root = await lstat(join(path, ARCHIVES), { bigint: true }); privateDirectory(root)
    const archived = await lstat(archive, { bigint: true }); privateDirectory(archived)
    retained = true
  } catch (error) { if (!missing(error)) throw error }
  if (retained) {
    const receipt = receiptSchema.parse(parse((await readFile(join(archive, 'receipt.json'), 16384)).bytes))
    const original = await readFile(join(archive, LOCK))
    if (!isDeepStrictEqual(receipt.request, request) || hash(original.bytes) !== request.lockSha256
      || receipt.lock.owner !== request.owner || original.bytes.length !== receipt.lockBytes || !isDeepStrictEqual(parse(original.bytes), receipt.lock)
      || !matchesIntent(intentSchema.parse(parse((await readFile(join(archive, 'intent.json'), 16384)).bytes)), request, receipt.lock)) throw refuse()
    await unchangedDirectory(path, info)
    return receipt // A retry never inspects/releases a replacement owner or opens storage.
  }
  const initial = await inspectAt(path, info)
  if (!initial.lock || initial.reason !== 'owner-exited' || initial.lock.owner !== request.owner || hash(initial.saved.bytes) !== request.lockSha256) throw refuse()
  // Prepare complete proof privately before the atomic no-replace publication.
  const preparations = join(path, PREPARATIONS), preparationsInfo = await privateChild(preparations, info)
  const requestRoot = join(preparations, request.requestId), requestInfo = await privateChild(requestRoot, preparationsInfo)
  const requestPath = join(requestRoot, 'request.json')
  try { await writePrivate(requestPath, json(request)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  if (!isDeepStrictEqual(requestSchema.parse(parse((await readFile(requestPath)).bytes)), request)) throw refuse()
  const recoveryOwnerId = randomUUID(), guard = join(requestRoot, recoveryOwnerId)
  await mkdir(guard, { mode: 0o700 })
  const guardInfo = await lstat(guard, { bigint: true }); privateDirectory(guardInfo)
  if (guardInfo.dev !== requestInfo.dev) throw refuse()
  await writePrivate(join(guard, 'intent.json'), json({ schemaVersion: 2, request, lock: initial.lock,
    recoveryOwner: { pid: process.pid, owner: recoveryOwnerId, context: initial.lock.recoveryContext } }))
  await writePrivate(join(guard, LOCK), initial.saved.bytes)
  await writePrivate(join(guard, 'publication.json'), json({ schemaVersion: 1, kind: 'JevableRecoveryPublication', requestId: request.requestId, recoveryOwnerId }))
  await syncDirectory(guard); await syncDirectory(requestRoot); await syncDirectory(preparations); await syncDirectory(path)
  await unchangedDirectory(requestRoot, requestInfo); await unchangedDirectory(preparations, preparationsInfo); await unchangedDirectory(path, info)
  const beforePublication = await inspectAt(path, info)
  if (!beforePublication.lock || beforePublication.reason !== 'owner-exited' || !sameFile(beforePublication.saved.info, initial.saved.info)
    || !beforePublication.saved.bytes.equals(initial.saved.bytes)) throw refuse()
  await absentArchive(path, request.requestId)
  const target = `${PREPARATIONS}/${request.requestId}/${recoveryOwnerId}`
  try { await symlink(target, join(path, BARRIER)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkflowRuntimeError('busy'); throw error }
  const resolved = await resolveRecoveryBarrier(path, info)
  if (!resolved.publication || !isDeepStrictEqual(resolved.publication.request, request)
    || !sameFile(resolved.guardInfo, guardInfo) || resolved.publication.target !== target || resolved.archived) throw refuse()
  const publication = resolved.publication
  // No cleanup on later error: preserve complete proof and the exclusion pointer.
  await syncDirectory(path)
  const final = await inspectAt(path, info)
  await unchangedDirectory(guard, guardInfo)
  if (!final.lock || final.reason !== 'owner-exited' || !sameFile(final.saved.info, initial.saved.info)
    || !final.saved.bytes.equals(initial.saved.bytes)) throw refuse()
  await mkdir(join(path, ARCHIVES), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  privateDirectory(await lstat(join(path, ARCHIVES), { bigint: true }))
  // A pre-existing archive identity is never overwritten, even if it lacks a receipt.
  try { await lstat(archive); throw refuse() } catch (error) { if (!missing(error)) throw error }
  await unchangedDirectory(path, info)
  await samePublication(path, info, publication, guardInfo, false)
  await unlink(join(path, LOCK))
  await syncDirectory(path)
  const receipt: RuntimeLockRecoveryReceipt = { schemaVersion: 1, kind: 'JevableRuntimeLockRecovery', status: 'released',
    request, lock: final.lock, lockBytes: final.saved.bytes.length, completedAt: new Date().toISOString(), database: 'not-opened', execution: 'not-started' }
  await writePrivate(join(guard, 'receipt.json'), json(receipt)); await syncDirectory(guard)
  await unchangedDirectory(guard, guardInfo)
  await rename(guard, archive)
  await syncDirectory(requestRoot); await syncDirectory(join(path, ARCHIVES)); await syncDirectory(path)
  const claimInfo = await claimCompletion(archive, final.lock.recoveryContext)
  await releasePublication(path, info, publication, archive, guardInfo, claimInfo, final.lock.recoveryContext)
  return receipt
}

function matchesIntent(intent: z.infer<typeof intentSchema>, request: RuntimeLockRecoveryRequest, lock: Lock) {
  return isDeepStrictEqual(intent.request, request) && isDeepStrictEqual(intent.lock, lock)
    && (intent.schemaVersion === 1 || isDeepStrictEqual(intent.recoveryOwner.context, lock.recoveryContext))
}
async function optionalFile(path: string, max = 4096) {
  try { return await readFile(path, max) } catch (error) { if (missing(error)) return null; throw error }
}
async function absentArchive(path: string, requestId: string) {
  try { privateDirectory(await lstat(join(path, ARCHIVES), { bigint: true })) }
  catch (error) { if (!missing(error)) throw error; return }
  try { await lstat(join(path, ARCHIVES, requestId)); throw refuse() }
  catch (error) { if (!missing(error)) throw error }
}

/** Proof-bearing v2 intent only. A legacy/partial intent is not an admission token.
 * No SQLite, directory mutation, PID signal other than zero, or workflow imports. */
async function interruptedAt(path: string, info: BigIntStats, allowClaim = false) {
  const { guard, guardInfo, publication, archived } = await resolveRecoveryBarrier(path, info)
  const entries = await readdir(guard)
  if (entries.some(name => !['intent.json', LOCK, 'receipt.json', COMPLETION, ...(publication ? ['publication.json'] : [])].includes(name))) throw refuse()
  const claimed = entries.includes(COMPLETION)
  if (claimed) privateDirectory(await lstat(join(guard, COMPLETION), { bigint: true }))
  const intentFile = await readFile(join(guard, 'intent.json'), 16384), intent = intentSchema.parse(parse(intentFile.bytes))
  if (publication && (intent.schemaVersion !== 2 || !isDeepStrictEqual(intent.request, publication.request)
    || intent.request.requestId !== publication.requestId || intent.recoveryOwner.owner !== publication.recoveryOwnerId)) throw refuse()
  const original = await optionalFile(join(path, LOCK)), retained = await optionalFile(join(guard, LOCK))
  const saved = retained ?? original
  if (!saved || hash(saved.bytes) !== intent.request.lockSha256 || !matchesIntent(intent, intent.request, lockSchema.parse(parse(saved.bytes)))) throw refuse()
  if (original && !original.bytes.equals(saved.bytes)) throw refuse()
  const receiptFile = await optionalFile(join(guard, 'receipt.json'), 16384)
  const receipt = receiptFile ? receiptSchema.parse(parse(receiptFile.bytes)) : null
  if (receipt && (original || !retained || !isDeepStrictEqual(receipt.request, intent.request)
    || !isDeepStrictEqual(receipt.lock, intent.lock) || receipt.lockBytes !== saved.bytes.length)) throw refuse()
  if (!archived) await absentArchive(path, intent.request.requestId)
  else if (!receipt || original || !retained) throw refuse()
  await unchangedDirectory(guard, guardInfo); await unchangedDirectory(path, info)
  if (publication) await samePublication(path, info, publication, guardInfo, archived)
  const stage = archived ? 'archived-before-barrier-release' as const : receipt ? 'receipt-retained' as const : original ? retained ? 'lock-retained' as const : 'intent-only' as const : 'released-before-receipt' as const
  let reason: 'legacy-intent' | 'completion-claimed' | 'unsupported-context' | 'context-mismatch' | 'process-not-proven-exited' | 'eligible'
  let ownerProcess: 'not-probed' | 'present' | 'absent' | 'unknown' = 'not-probed'
  let recoveryProcess: 'not-probed' | 'present' | 'absent' | 'unknown' = 'not-probed'
  if (intent.schemaVersion === 1) reason = 'legacy-intent'
  else if (claimed && !allowClaim) reason = 'completion-claimed'
  else {
    const context = await currentOwnerContext(path, info)
    await unchangedDirectory(path, info)
    if (!context || !intent.lock.recoveryContext) reason = 'unsupported-context'
    else if (!isDeepStrictEqual(context, intent.lock.recoveryContext) || !isDeepStrictEqual(context, intent.recoveryOwner.context)) reason = 'context-mismatch'
    else {
      ownerProcess = processState(intent.lock.pid); recoveryProcess = processState(intent.recoveryOwner.pid)
      reason = ownerProcess === 'absent' && recoveryProcess === 'absent' ? 'eligible' : 'process-not-proven-exited'
    }
  }
  return { guard, guardInfo, publication, archived, intentFile, intent, original, retained, saved, receipt, stage, reason, ownerProcess, recoveryProcess }
}

/** Inspect an existing interrupted transaction, without acquiring any owner. */
export async function inspectRuntimeLockRecovery(dataDirectory: string) {
  const { path, info } = await directory(dataDirectory), result = await interruptedAt(path, info)
  return { schemaVersion: 1 as const, kind: 'JevableRuntimeLockRecoveryInspection' as const,
    request: result.intent.request, ownerPid: result.intent.lock.pid,
    recoveryPid: result.intent.schemaVersion === 2 ? result.intent.recoveryOwner.pid : null,
    stage: result.stage, completionEligible: result.reason === 'eligible', reason: result.reason,
    ownerProcess: result.ownerProcess, recoveryProcess: result.recoveryProcess,
    database: 'not-opened' as const, execution: 'not-started' as const }
}

/** Explicitly finish a proved-exited v2 recovery. The exclusive completion claim
 * is retained inside the original barrier/archive. Failure after claiming stays
 * blocked; recursive takeover of an interrupted completion is not implemented.
 * This is trusted-directory cooperative exclusion, not hostile same-UID fencing. */
export async function completeRuntimeLockRecovery(dataDirectory: string, input: RuntimeLockRecoveryRequest): Promise<RuntimeLockRecoveryReceipt> {
  const request = requestSchema.parse(input), { path, info } = await directory(dataDirectory)
  try { await lstat(join(path, BARRIER)) }
  catch (error) {
    if (!missing(error)) throw error
    // Finalized retry only; never turn a completion command into initial recovery.
    privateDirectory(await lstat(join(path, ARCHIVES, request.requestId), { bigint: true }))
    return recoverRuntimeLock(path, request)
  }
  const initial = await interruptedAt(path, info)
  if (initial.reason !== 'eligible' || !isDeepStrictEqual(initial.intent.request, request)) throw refuse()
  const claim = join(initial.guard, COMPLETION), claimInfo = await claimCompletion(initial.guard, initial.intent.lock.recoveryContext)
  // No cleanup on subsequent failure. Other completers/startup cannot bypass this.
  await syncDirectory(path)
  const checked = await interruptedAt(path, info, true)
  await unchangedDirectory(claim, claimInfo)
  if (checked.reason !== 'eligible' || !sameFile(initial.guardInfo, checked.guardInfo)
    || !sameFile(initial.intentFile.info, checked.intentFile.info) || !initial.intentFile.bytes.equals(checked.intentFile.bytes)
    || !initial.saved.bytes.equals(checked.saved.bytes) || initial.stage !== checked.stage) throw refuse()
  if (initial.original && (!checked.original || !sameFile(initial.original.info, checked.original.info))) throw refuse()
  if (initial.retained && (!checked.retained || !sameFile(initial.retained.info, checked.retained.info))) throw refuse()
  if (checked.archived) {
    if (!checked.publication || !checked.receipt) throw refuse()
    await releasePublication(path, info, checked.publication, checked.guard, checked.guardInfo, claimInfo, checked.intent.lock.recoveryContext)
    return checked.receipt
  }
  if (!checked.retained) await writePrivate(join(initial.guard, LOCK), checked.saved.bytes)
  await syncDirectory(initial.guard); await syncDirectory(path)
  await mkdir(join(path, ARCHIVES), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  await absentArchive(path, request.requestId)
  await unchangedDirectory(path, info); await unchangedDirectory(initial.guard, initial.guardInfo); await unchangedDirectory(claim, claimInfo)
  // The old owner and initial recoverer are dead and other completers are excluded.
  if (checked.original) {
    const final = await inspectAt(path, info)
    if (final.reason !== 'owner-exited' || !sameFile(final.saved.info, checked.original.info) || !final.saved.bytes.equals(checked.saved.bytes)) throw refuse()
    await unlink(join(path, LOCK))
  } else if (await optionalFile(join(path, LOCK))) throw refuse()
  await syncDirectory(path)
  const receipt: RuntimeLockRecoveryReceipt = checked.receipt ?? { schemaVersion: 1, kind: 'JevableRuntimeLockRecovery', status: 'released',
    request, lock: checked.intent.lock, lockBytes: checked.saved.bytes.length, completedAt: new Date().toISOString(), database: 'not-opened', execution: 'not-started' }
  if (!checked.receipt) await writePrivate(join(initial.guard, 'receipt.json'), json(receipt))
  await syncDirectory(initial.guard)
  await unchangedDirectory(initial.guard, initial.guardInfo); await unchangedDirectory(claim, claimInfo)
  await rename(initial.guard, join(path, ARCHIVES, request.requestId))
  if (initial.publication) await syncDirectory(join(path, PREPARATIONS, request.requestId))
  await syncDirectory(join(path, ARCHIVES)); await syncDirectory(path)
  if (initial.publication) await releasePublication(path, info, initial.publication, join(path, ARCHIVES, request.requestId), initial.guardInfo, claimInfo, initial.intent.lock.recoveryContext)
  return receipt
}

/** Shared by every new SQLite owner. Check recovery exclusion both sides of wx creation. */
export class RuntimeOwnerLock {
  private constructor(private readonly file: File, private readonly path: string, private readonly info: BigIntStats) {}
  static async acquire(path: string) {
    await barrierAbsent(path)
    const lockPath = join(path, LOCK)
    let file: File
    try { file = await open(lockPath, 'wx', 0o600) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkflowRuntimeError('busy'); throw error }
    const info = await file.stat({ bigint: true }), owned = new RuntimeOwnerLock(file, lockPath, info)
    try {
      await barrierAbsent(path)
      const dir = await lstat(path, { bigint: true })
      const recoveryContext = await currentOwnerContext(path, dir)
      const lock: Lock = { schemaVersion: 1, kind: 'JevableRuntimeLock', pid: process.pid, owner: randomUUID(),
        startedAt: new Date().toISOString(), recoveryContext }
      await file.writeFile(json(lock)); await file.sync()
      await barrierAbsent(path)
      return owned
    } catch (error) { await owned.release(); throw error }
  }
  async release() {
    try {
      const named = await lstat(this.path, { bigint: true })
      if (!sameFile(named, this.info)) throw refuse()
      await unlink(this.path)
    } finally { await this.file.close() }
  }
}
