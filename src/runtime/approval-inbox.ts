import { z } from 'zod'
import { WorkflowRuntimeError } from './errors.ts'
import { localRunSchema, loopScope, type LocalRun } from './run-types.ts'

export const approvalPageSchema = z.strictObject({ after: z.uuid().optional(), limit: z.number().int().min(1).max(200).default(100) })
export type ApprovalPage = z.input<typeof approvalPageSchema>
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const status = z.enum(['paused', 'waiting', 'executing', 'completed', 'failed', 'cancelled'])
const metadata = z.object({ id: z.uuid(), revision: hash, status })
const pageSchema = z.object({ runs: z.array(metadata).max(200), nextCursor: z.uuid().nullable() })
export interface ApprovalInboxHost {
  listRuns(page: z.output<typeof approvalPageSchema>): unknown | Promise<unknown>
  showRun(id: string): LocalRun | Promise<LocalRun>
}
export const APPROVAL_INBOX_LIMITS = Object.freeze({ runs: 200, readBytes: 64_000_000, reportBytes: 4_000_000 })
const fail = (code: 'corrupt' | 'limit' | 'invalid-command' = 'corrupt'): never => { throw new WorkflowRuntimeError(code) }

/** One metadata page, then verified current reads of waiting candidates only. Never execute or settle expiry. */
export async function createApprovalInbox(host: ApprovalInboxHost, value: ApprovalPage = {}) {
  const parsed = approvalPageSchema.safeParse(value)
  if (!parsed.success) return fail('invalid-command')
  const page = parsed.data, result = pageSchema.safeParse(await host.listRuns(page))
  if (!result.success) return fail()
  const { runs, nextCursor } = result.data
  if (runs.length > page.limit || runs.some((run, index) => run.id <= (index ? runs[index - 1]!.id : page.after ?? ''))
    || nextCursor !== null && (runs.length !== page.limit || nextCursor !== runs.at(-1)?.id)) return fail()
  const tasks = []
  let bytes = 0, changedCandidates = 0
  for (const selected of runs) {
    if (selected.status !== 'waiting') continue
    const raw = await host.showRun(selected.id)
    let encoded: string
    try { encoded = JSON.stringify(raw) } catch { return fail() }
    if (!encoded) return fail()
    bytes += Buffer.byteLength(encoded)
    if (bytes > APPROVAL_INBOX_LIMITS.readBytes) return fail('limit')
    const parsedRun = localRunSchema.safeParse(raw)
    if (!parsedRun.success) return fail()
    const run = parsedRun.data
    if (run.id !== selected.id || run.revision !== selected.revision) return fail()
    if (run.state.status !== 'waiting') { changedCandidates++; continue }
    const observedAt = new Date().toISOString(), state = run.state
    const loopDeadline = state.scope ? run.loopDeadlines[state.scope.loop] : undefined
    if (state.scope && (!Number.isSafeInteger(loopDeadline) || loopDeadline! < 0 || loopDeadline! > 8.64e15)) return fail()
    // A verified core read supplies the source/checkpoint validation; project only explicit task metadata.
    const task = z.strictObject({ runId: z.uuid(), revision: hash, nodeId: z.string().min(1).max(4096), attemptId: z.uuid(),
      expiresAt: z.iso.datetime(), observedAt: z.iso.datetime(), observedRunUpdatedAt: z.iso.datetime(),
      scope: loopScope.optional(), loopExpiresAt: z.iso.datetime().optional(),
      loopExpiry: z.enum(['not-expired-at-observation', 'expired-at-observation']).optional(),
      project: z.object({ id: z.uuid(), generation: z.number().int().positive() }).optional(),
      release: z.object({ id: z.uuid(), sha256: hash }).optional(),
      test: z.object({ id: z.uuid(), generation: z.number().int().positive(), sha256: hash }).optional(),
      cancellationRequested: z.boolean(), expiry: z.enum(['not-expired-at-observation', 'expired-at-observation']),
    }).safeParse({ runId: run.id, revision: run.revision, nodeId: state.next, attemptId: state.attempt.id,
      expiresAt: state.expiresAt, observedAt, observedRunUpdatedAt: run.updatedAt,
      ...(state.scope ? { scope: state.scope, loopExpiresAt: new Date(loopDeadline!).toISOString(),
        loopExpiry: loopDeadline! <= Date.parse(observedAt) ? 'expired-at-observation' : 'not-expired-at-observation' } : {}),
      ...(run.project ? { project: run.project } : {}), ...(run.release ? { release: run.release } : {}), ...(run.test ? { test: run.test } : {}),
      cancellationRequested: run.cancellation !== undefined,
      expiry: Date.parse(state.expiresAt) <= Date.parse(observedAt) ? 'expired-at-observation' : 'not-expired-at-observation' })
    if (!task.success || state.attempt.nodeId !== state.next) return fail()
    tasks.push(task.data)
  }
  const report = { schemaVersion: 1, format: 'jevable.ai/approval-inbox' as const, tasks, nextCursor,
    scannedRuns: runs.length, changedCandidates, page,
    consistency: 'live-run-keyset; not-a-snapshot; restart-scan-to-find-new-waits-behind-cursor' as const,
    emptyPage: 'follow-nextCursor-even-when-tasks-is-empty' as const,
    authority: 'listing-does-not-authorize-decisions; inspect-current-task-before-deciding' as const,
    expiry: 'observational-only; no-expired-wait-is-settled-by-listing' as const,
    privacy: 'review-payloads-titles-actions-actors-credentials-excluded; identifiers-retained' as const,
    execution: 'not-started-or-resumed' as const }
  if (Buffer.byteLength(JSON.stringify(report)) > APPROVAL_INBOX_LIMITS.reportBytes) return fail('limit')
  return report
}
export type ApprovalInbox = Awaited<ReturnType<typeof createApprovalInbox>>
