import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { WorkflowRuntimeError } from '../runtime/errors.ts'

const maxEventBytes = 1_100_000
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
/** Durable local event inbox records. `pending` retries on every scheduler pass,
 * `observed` holds a non-terminal run state (waiting/paused/executing) and is
 * re-observed after the wait settles, and the three terminal states stop retrying.
 * Nothing here resumes, retries execution, decides an approval or invents an identity. */
const recordSchema = z.strictObject({
  format: z.literal('jevable.ai/local-release-inbox'), version: z.literal(1),
  eventSha256: hash, runId: z.uuid(),
  release: z.strictObject({ id: z.uuid(), sha256: hash, revision: hash }),
  source: z.string(), messageId: z.string(),
  state: z.enum(['pending', 'observed', 'acked', 'conflict', 'invalid']),
  attempts: z.number().int().min(0).max(1_000_000),
  lastStatus: z.string().max(64).optional(), lastCode: z.string().max(64).optional(),
  lastObservedAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
})
export type ReleaseLocalInboxRecord = z.infer<typeof recordSchema>
export type ReleaseLocalInboxState = ReleaseLocalInboxRecord['state']
const lockSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('JevableLocalInboxLock'),
  pid: z.number().int().positive().max(2147483647), startedAt: z.iso.datetime() })
const LOCK = 'scheduler.lock'
const refuse = (code: 'invalid-command' | 'conflict' | 'busy' | 'corrupt' = 'invalid-command') => new WorkflowRuntimeError(code)

function privateDirectory(info: { isDirectory(): boolean; mode: number; uid: bigint | number }) {
  if (!info.isDirectory() || (info.mode & 0o077) || typeof process.getuid !== 'function'
    || BigInt(info.uid) !== BigInt(process.getuid())) throw refuse()
}
async function privateFile(path: string) {
  const info = await lstat(path)
  if (!info.isFile() || (info.mode & 0o077) || typeof process.getuid !== 'function'
    || BigInt(info.uid) !== BigInt(process.getuid())) throw refuse()
}
async function inboxDirectory(value: string, create: boolean) {
  const path = resolve(value)
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
  privateDirectory(await lstat(path))
  return path
}
async function writePrivate(path: string, bytes: Uint8Array) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
}
/** Replace a record atomically enough for a trusted private directory: fsync then rename. */
async function replacePrivate(path: string, bytes: Uint8Array) {
  const temporary = path + '.tmp'
  await writeFile(temporary, bytes, { mode: 0o600 })
  const file = await open(temporary, constants.O_WRONLY | constants.O_NOFOLLOW)
  try { await file.sync() } finally { await file.close() }
  await rename(temporary, path)
}

export interface QueuedReleaseLocalEvent { eventSha256: string; runId: string; release: { id: string; sha256: string; revision: string }; source: string; messageId: string; input: unknown }

function isSamePin(a: { id: string; sha256: string; revision: string }, b: { id: string; sha256: string; revision: string }) {
  return a.id === b.id && a.sha256 === b.sha256 && a.revision === b.revision
}

function recordOf(event: QueuedReleaseLocalEvent, existing: ReleaseLocalInboxRecord | undefined): ReleaseLocalInboxRecord {
  const at = new Date().toISOString()
  return { format: 'jevable.ai/local-release-inbox', version: 1, eventSha256: event.eventSha256, runId: event.runId,
    release: event.release, source: event.source, messageId: event.messageId,
    state: existing?.state ?? 'pending', attempts: existing?.attempts ?? 0,
    ...(existing?.lastStatus !== undefined ? { lastStatus: existing.lastStatus } : {}),
    ...(existing?.lastCode !== undefined ? { lastCode: existing.lastCode } : {}),
    ...(existing?.lastObservedAt !== undefined ? { lastObservedAt: existing.lastObservedAt } : {}),
    createdAt: existing?.createdAt ?? at, updatedAt: at }
}

/** Queue one admitted event as exact pinned bytes plus a pending record. Re-queueing
 * the same bytes is idempotent; the inbox never opens workflow storage. */
export async function queueReleaseLocalEvent(directory: string, event: QueuedReleaseLocalEvent, bytes: Uint8Array) {
  const path = await inboxDirectory(directory, true)
  const recordPath = join(path, event.eventSha256 + '.json'), eventPath = join(path, event.eventSha256 + '.event')
  if (bytes.length > maxEventBytes || createHash('sha256').update(bytes).digest('hex') !== event.eventSha256) throw refuse()
  let existing: ReleaseLocalInboxRecord | undefined
  try { await privateFile(recordPath); existing = recordSchema.parse(JSON.parse(await readFile(recordPath, 'utf8'))) }
  catch (error) {
    if (error instanceof WorkflowRuntimeError) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof z.ZodError) && !(error instanceof SyntaxError)) throw refuse()
    existing = undefined
  }
  if (existing && (existing.runId !== event.runId || !isSamePin(existing.release, event.release))) throw refuse('conflict')
  try {
    await privateFile(eventPath)
    if (!(await readFile(eventPath)).equals(Buffer.from(bytes))) throw refuse('conflict')
  } catch (error) {
    if (error instanceof WorkflowRuntimeError) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw refuse()
    await writePrivate(eventPath, bytes)
  }
  const record = recordOf(event, existing)
  if (existing) await replacePrivate(recordPath, Buffer.from(JSON.stringify(record) + '\n'))
  else await writePrivate(recordPath, Buffer.from(JSON.stringify(record) + '\n'))
  return { record, created: !existing }
}

export interface LoadedReleaseLocalInboxEntry { record: ReleaseLocalInboxRecord; recordPath: string; eventPath: string; eventBytes: Buffer }

/** Load and fully re-verify every inbox entry before any delivery attempt. */
export async function loadReleaseLocalInbox(directory: string) {
  const path = await inboxDirectory(directory, false), names = await readdir(path)
  const entries: LoadedReleaseLocalInboxEntry[] = []
  for (const name of names) {
    if (name === LOCK || name.endsWith('.tmp') || name.endsWith('.event')) continue
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) throw refuse('corrupt')
    const sha256 = name.slice(0, -'.json'.length)
    const recordPath = join(path, name), eventPath = join(path, sha256 + '.event')
    let record: ReleaseLocalInboxRecord
    try { await privateFile(recordPath); record = recordSchema.parse(JSON.parse(await readFile(recordPath, 'utf8'))) }
    catch (error) { if (error instanceof WorkflowRuntimeError) throw error; throw refuse('corrupt') }
    await privateFile(eventPath)
    const eventBytes = await readFile(eventPath)
    if (eventBytes.length > maxEventBytes || createHash('sha256').update(eventBytes).digest('hex') !== record.eventSha256
      || record.eventSha256 !== sha256) throw refuse('corrupt')
    entries.push({ record, recordPath, eventPath, eventBytes })
  }
  entries.sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt) || a.record.eventSha256.localeCompare(b.record.eventSha256))
  return { path, entries }
}

/** Persist one delivery observation. Terminal states stop retrying; uncertain outcomes
 * keep the entry replayable under its original identity. */
export async function updateReleaseLocalInboxEntry(entry: LoadedReleaseLocalInboxEntry,
  observation: { state: ReleaseLocalInboxState; status?: string; code?: string }) {
  const record = recordSchema.parse({ ...entry.record, state: observation.state, attempts: entry.record.attempts + 1,
    ...(observation.status !== undefined ? { lastStatus: observation.status, lastObservedAt: new Date().toISOString() }
      : entry.record.lastObservedAt !== undefined ? { lastObservedAt: entry.record.lastObservedAt } : {}),
    ...(observation.code !== undefined ? { lastCode: observation.code } : entry.record.lastCode !== undefined ? { lastCode: entry.record.lastCode } : {}),
    updatedAt: new Date().toISOString() })
  await replacePrivate(entry.recordPath, Buffer.from(JSON.stringify(record) + '\n'))
  return record
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/** Cooperative single-scheduler exclusion in a trusted private directory: a live owner
 * refuses with `busy`; a provably exited owner is replaced. Not hostile-process fencing. */
export async function acquireReleaseLocalInboxLock(directory: string): Promise<() => Promise<void>> {
  const path = await inboxDirectory(directory, false), lockPath = join(path, LOCK)
  const release = async () => { try { await unlink(lockPath) } catch { /* best-effort release in a trusted directory */ } }
  const claim = async () => {
    try { await writePrivate(lockPath, Buffer.from(JSON.stringify(lockSchema.parse(
      { schemaVersion: 1, kind: 'JevableLocalInboxLock', pid: process.pid, startedAt: new Date().toISOString() })) + '\n')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error }
    return true
  }
  if (await claim()) return release
  let lock: z.infer<typeof lockSchema>
  try { await privateFile(lockPath); lock = lockSchema.parse(JSON.parse(await readFile(lockPath, 'utf8'))) }
  catch (error) { if (error instanceof WorkflowRuntimeError) throw error; throw refuse('corrupt') }
  // Only a provably exited owner is replaced; an unknown/live pid keeps refusing.
  if (!alive(lock.pid)) { await unlink(lockPath).catch(() => {}); if (await claim()) return release }
  throw refuse('busy')
}
