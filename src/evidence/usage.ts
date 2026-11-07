import { z } from 'zod'
import { createHash } from 'node:crypto'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { prepareEvidenceDownload } from './download.ts'
import { inspectEvidenceSelection, evidenceSelectionSchema, EVIDENCE_PACKAGE_LIMITS } from './package.ts'
import { usageIdentitySchema, USAGE_IDENTITY_FORMAT, type UsageIdentity } from './usage-identity.ts'

export const USAGE_REPORT_LIMITS = Object.freeze({ runs: EVIDENCE_PACKAGE_LIMITS.runs, calls: 10000, groups: 1000, sourceBytes: 64_000_000, reportBytes: 16_000_000 })
export interface UsageReportHost {
  exportRun(id: string, includePrivate: boolean): unknown | Promise<unknown>
  /** Opt-in checked requested-provider/model projection; no private payloads or endpoint/credential routes. */
  exportUsageRun?(id: string): unknown | Promise<unknown>
}
const instant = z.iso.datetime({ precision: 3 }).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
const recordedInstant = z.iso.datetime().refine(value => Number.isFinite(Date.parse(value)))
function laterThan(left: string, right: string) {
  const difference = Date.parse(left) - Date.parse(right)
  if (difference !== 0) return difference > 0
  // Window bounds are integral milliseconds. Keep finer retained fractions for the future-time guard.
  const tail = (value: string) => (/\.(\d+)Z$/u.exec(value)?.[1]?.slice(3) ?? '').replace(/0+$/u, '')
  const a = tail(left), b = tail(right), width = Math.max(a.length, b.length)
  return a.padEnd(width, '0') > b.padEnd(width, '0')
}
const windowSchema = z.strictObject({ from: instant, before: instant }).refine(value => Date.parse(value.from) < Date.parse(value.before))
/** Shared consuming grammar, including strict run pins and usage-only refinements. */
export const usageSelectionSchema = evidenceSelectionSchema.safeExtend({ window: windowSchema.optional(),
  groupBy: z.enum(['provider', 'provider-model']).optional() })
  .refine(value => new Set(value.runs.map(run => run.id.toLowerCase())).size === value.runs.length)
/** Usage-only scope; evidence ZIP selections retain their original strict grammar. */
export function inspectUsageSelection(value: unknown) {
  let detached: unknown
  try {
    const encoded = JSON.stringify(value)
    if (!encoded) throw new WorkflowRuntimeError('invalid-command')
    if (Buffer.byteLength(encoded) > EVIDENCE_PACKAGE_LIMITS.selectionBytes) throw new WorkflowRuntimeError('limit')
    detached = JSON.parse(encoded)
  } catch (error) {
    if (error instanceof WorkflowRuntimeError) throw error
    throw new WorkflowRuntimeError('invalid-command')
  }
  const parsed = usageSelectionSchema.safeParse(detached)
  if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
  const base = inspectEvidenceSelection({ schemaVersion: 1, runs: parsed.data.runs })
  const selection = { ...base.selection, ...(parsed.data.window ? { window: parsed.data.window } : {}),
    ...(parsed.data.groupBy ? { groupBy: parsed.data.groupBy } : {}) }
  return { selection, sha256: createHash('sha256').update(JSON.stringify(selection)).digest('hex') }
}
export type UsageSelection = ReturnType<typeof inspectUsageSelection>['selection']
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const status = z.enum(['pending', 'failed', 'completed'])
const callSchema = z.object({ nodeId: z.string().min(1).max(4096), attemptId: z.uuid(),
  intentAt: z.string().optional(),
  usageIdentity: usageIdentitySchema.optional(),
  scope: z.object({ loop: z.string().min(1).max(4096), index: integer }).optional(),
  evidence: z.enum(['recorded', 'not-recorded']), evidenceSchemaVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  status: status.optional(), usage: z.object({ tries: integer.min(1).max(10), inputTokens: integer.optional(), outputTokens: integer.optional() }).optional(),
  policy: z.object({ kind: z.literal('transient-http-v1'), maxAttempts: integer.min(2).max(10) }).optional(),
  tries: z.array(z.object({ id: z.uuid(), number: integer.min(1).max(10), status })).min(1).max(10).optional(),
})
const snapshotSchema = z.object({ run: z.object({ updatedAt: z.iso.datetime() }),
  models: z.object({ format: z.literal('jevable.model-history/v1'), source: z.literal('configured-model-store'),
    usageIdentities: z.literal(USAGE_IDENTITY_FORMAT).optional(),
    calls: z.array(callSchema).max(USAGE_REPORT_LIMITS.calls) }).optional() })
const fail = (code: 'corrupt' | 'limit' = 'corrupt'): never => { throw new WorkflowRuntimeError(code) }
function counters() {
  return { modelIntents: 0, unavailableHistories: 0, unrecordedCalls: 0, completedCalls: 0, failedCalls: 0, pendingCalls: 0,
    recordedTries: 0, failedOrPendingTries: 0, inputReportingCalls: 0, outputReportingCalls: 0, input: 0n, output: 0n }
}
type Counters = ReturnType<typeof counters>
function accumulate(target: Counters, source: Counters) {
  for (const key of Object.keys(target) as (keyof Counters)[]) {
    if (key === 'input' || key === 'output') target[key] += source[key]
    else target[key] += source[key]
  }
}
type Group = { key: { provider: string | null; model?: string | null }; counts: Counters; unlocated: number }
type Groups = Map<string, Group>
function grouping(map: Groups, by: 'provider' | 'provider-model', identity?: UsageIdentity) {
  const key = { provider: identity?.provider ?? null, ...(by === 'provider-model' ? { model: identity?.model ?? null } : {}) }
  const encoded = JSON.stringify(key)
  let value = map.get(encoded)
  if (!value) {
    if (map.size >= USAGE_REPORT_LIMITS.groups) return fail('limit')
    value = { key, counts: counters(), unlocated: 0 }; map.set(encoded, value)
  }
  return value
}
function grouped(map: Groups) {
  return [...map.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([, value]) => ({ key: value.key, summary: summary(value.counts, value.unlocated), unlocatedModelIntents: value.unlocated }))
}
function summary(counts: Counters, unlocatedModelIntents = 0) {
  const { input, output, inputReportingCalls, outputReportingCalls, ...calls } = counts
  const tokenSummary = (sum: bigint, reportingCalls: number) => {
    const complete = unlocatedModelIntents === 0 && counts.unavailableHistories === 0 && counts.unrecordedCalls === 0 && counts.failedOrPendingTries === 0
      && counts.pendingCalls === 0 && counts.failedCalls === 0 && reportingCalls === counts.completedCalls
    return { reportedTokens: reportingCalls || complete ? String(sum) : null, reportingCalls,
      completedCallsWithoutField: counts.completedCalls - reportingCalls,
      coverage: complete ? 'complete-for-observed-intents' as const : reportingCalls ? 'partial' as const : 'unavailable' as const }
  }
  return { ...calls, inputTokens: tokenSummary(input, inputReportingCalls), outputTokens: tokenSummary(output, outputReportingCalls) }
}

/** Read only the explicit, revision-pinned selection. No enumeration, provider calls, pricing or private payload projection. */
export async function createUsageReport(host: UsageReportHost, value: unknown) {
  const { selection, sha256 } = inspectUsageSelection(value)
  if (selection.groupBy && typeof host.exportUsageRun !== 'function') throw new WorkflowRuntimeError('invalid-command')
  const totals = counters(), runs = []
  const allGroups: Groups = new Map()
  let sourceBytes = 0, callCount = 0, totalOutside = 0, totalUnlocated = 0
  for (const selected of selection.runs) {
    const raw = selection.groupBy ? await host.exportUsageRun!(selected.id) : await host.exportRun(selected.id, false)
    // Bound and detach before hashing so mutation during an asynchronous digest cannot change the accounting input.
    let encoded: string
    try { encoded = JSON.stringify(raw) } catch { return fail() }
    if (!encoded) return fail()
    sourceBytes += Buffer.byteLength(encoded)
    if (Buffer.byteLength(encoded) > EVIDENCE_PACKAGE_LIMITS.entryBytes || sourceBytes > USAGE_REPORT_LIMITS.sourceBytes) return fail('limit')
    const envelope = JSON.parse(encoded)
    if (Array.isArray(envelope?.snapshot?.models?.calls) && envelope.snapshot.models.calls.length + callCount > USAGE_REPORT_LIMITS.calls) return fail('limit')
    let admitted
    try { admitted = await prepareEvidenceDownload({ runId: selected.id, revision: selected.revision }, envelope) }
    catch { return fail() }
    const parsed = snapshotSchema.safeParse(envelope.snapshot)
    if (!parsed.success) return fail()
    const snapshot = parsed.data, counts = counters(), ids = new Set<string>(), tryIds = new Set<string>()
    const groups: Groups = new Map()
    if (selection.groupBy && (envelope.snapshot.privacy.modelIdentities !== 'included-by-explicit-usage-request'
      || snapshot.models && snapshot.models.usageIdentities !== USAGE_IDENTITY_FORMAT)) return fail()
    if (!snapshot.models) counts.unavailableHistories = 1
    if (!snapshot.models && selection.groupBy) {
      grouping(groups, selection.groupBy).counts.unavailableHistories++
      grouping(allGroups, selection.groupBy).counts.unavailableHistories++
    }
    const calls = []
    let outside = 0, unlocated = 0
    const located = (call: z.infer<typeof callSchema>) => {
      if (!selection.window) return true
      if (call.intentAt === undefined) {
        unlocated++
        if (selection.groupBy) {
          grouping(groups, selection.groupBy, call.usageIdentity).unlocated++
          grouping(allGroups, selection.groupBy, call.usageIdentity).unlocated++
        }
        return false
      }
      if (!recordedInstant.safeParse(call.intentAt).success || laterThan(call.intentAt, snapshot.run.updatedAt)) return fail()
      const at = Date.parse(call.intentAt)
      if (at < Date.parse(selection.window.from) || at >= Date.parse(selection.window.before)) { outside++; return false }
      return true
    }
    for (const call of snapshot.models?.calls ?? []) {
      if (++callCount > USAGE_REPORT_LIMITS.calls) return fail('limit')
      if (ids.has(call.attemptId.toLowerCase())) return fail()
      ids.add(call.attemptId.toLowerCase())
      const identity = { nodeId: call.nodeId, attemptId: call.attemptId, ...(call.scope ? { scope: call.scope } : {}),
        ...(selection.window && call.intentAt !== undefined ? { intentAt: call.intentAt } : {}),
        ...(selection.groupBy ? { usageIdentity: call.usageIdentity ?? null } : {}) }
      if (call.evidence === 'not-recorded') {
        if (call.status !== undefined || call.usage !== undefined || call.tries !== undefined || call.policy !== undefined || call.evidenceSchemaVersion !== undefined || call.usageIdentity !== undefined) return fail()
        if (!located(call)) continue
        counts.modelIntents++
        counts.unrecordedCalls++
        if (selection.groupBy) {
          for (const map of [groups, allGroups]) {
            const bucket = grouping(map, selection.groupBy); bucket.counts.modelIntents++; bucket.counts.unrecordedCalls++
          }
        }
        calls.push({ ...identity, evidence: call.evidence, recordedTries: null, inputTokens: null, outputTokens: null })
        continue
      }
      if (!call.status || !call.evidenceSchemaVersion || (call.status === 'completed') !== (call.usage !== undefined)) return fail()
      if (selection.groupBy && !call.usageIdentity) return fail()
      if (call.evidenceSchemaVersion === 1) {
        if (call.tries !== undefined || call.policy !== undefined || call.usage && call.usage.tries !== 1) return fail()
      } else {
        if (!call.tries || !call.policy || call.tries.length > call.policy.maxAttempts) return fail()
        for (const [index, attempt] of call.tries.entries()) {
          if (attempt.number !== index + 1 || tryIds.has(attempt.id.toLowerCase()) || index < call.tries.length - 1 && attempt.status !== 'failed') return fail()
          tryIds.add(attempt.id.toLowerCase())
        }
        const last = call.tries.at(-1)!.status
        if (call.status === 'completed' && (last !== 'completed' || call.usage!.tries !== call.tries.length)
          || call.status === 'failed' && last !== 'failed' || call.status === 'pending' && last === 'completed') return fail()
      }
      // Validate all observed accounting before filtering; excluded calls cannot hide corruption.
      if (!located(call)) continue
      counts.modelIntents++
      const tries = call.tries?.length ?? 1
      const incomplete = call.tries?.filter(attempt => attempt.status !== 'completed').length ?? (call.status === 'completed' ? 0 : 1)
      counts.recordedTries += tries; counts.failedOrPendingTries += incomplete
      if (call.status === 'completed') counts.completedCalls++
      else if (call.status === 'pending') counts.pendingCalls++
      else counts.failedCalls++
      const input = call.usage?.inputTokens, output = call.usage?.outputTokens
      if (input !== undefined) { counts.input += BigInt(input); counts.inputReportingCalls++ }
      if (output !== undefined) { counts.output += BigInt(output); counts.outputReportingCalls++ }
      if (selection.groupBy) {
        const single = counters()
        single.modelIntents = 1; single.recordedTries = tries; single.failedOrPendingTries = incomplete
        if (call.status === 'completed') single.completedCalls = 1
        else if (call.status === 'pending') single.pendingCalls = 1
        else single.failedCalls = 1
        if (input !== undefined) { single.input = BigInt(input); single.inputReportingCalls = 1 }
        if (output !== undefined) { single.output = BigInt(output); single.outputReportingCalls = 1 }
        accumulate(grouping(groups, selection.groupBy, call.usageIdentity).counts, single)
        accumulate(grouping(allGroups, selection.groupBy, call.usageIdentity).counts, single)
      }
      calls.push({ ...identity, evidence: call.evidence, status: call.status, recordedTries: tries, failedOrPendingTries: incomplete,
        inputTokens: input === undefined ? null : String(input), outputTokens: output === undefined ? null : String(output) })
    }
    totalOutside += outside; totalUnlocated += unlocated
    accumulate(totals, counts)
    runs.push({ id: selected.id, revision: selected.revision, workflowStatus: admitted.workflowStatus,
      observedRunUpdatedAt: snapshot.run.updatedAt, snapshotSha256: admitted.snapshotSha256,
      modelHistory: snapshot.models ? 'recorded' as const : 'unavailable' as const, summary: summary(counts, unlocated), calls,
      ...(selection.window ? { windowCoverage: { observedModelIntents: ids.size, outsideWindow: outside, unlocatedModelIntents: unlocated } } : {}),
      ...(selection.groupBy ? { groups: grouped(groups) } : {}) })
  }
  const report = { schemaVersion: 1, format: 'jevable.ai/usage-report' as const, selectionSha256: sha256,
    source: 'configured-model-store' as const, consistency: 'per-run-observations; not-an-atomic-snapshot' as const,
    tokenEncoding: 'decimal-integer-string' as const, billing: 'not-estimated; not-provider-account-totals' as const,
    semantics: 'intent-is-not-dispatch; successful-response-usage-counted-once; failed-tries-may-have-unreported-usage' as const,
    privacy: selection.groupBy ? 'payloads-credentials-provider-routes-excluded; requested-provider-model-identities-opted-in; identifiers-retained' as const
      : 'payloads-credentials-provider-routes-excluded; identifiers-retained' as const,
    authenticity: 'retained-evidence-checksums; not-independent-proof' as const, execution: 'not-started-or-resumed' as const,
    ...(selection.window ? { window: { ...selection.window, basis: 'original-model-intent' as const,
      bounds: 'from-inclusive-before-exclusive' as const, retryAllocation: 'entire-call; not-per-try-or-prorated' as const },
      windowCoverage: { observedModelIntents: callCount, outsideWindow: totalOutside, unlocatedModelIntents: totalUnlocated } } : {}),
    ...(selection.groupBy ? { groupBy: selection.groupBy, groupIdentity: 'verified-requested-provider-model; not-billing-or-provider-response-version' as const,
      groups: grouped(allGroups) } : {}),
    summary: summary(totals, totalUnlocated), runs }
  if (Buffer.byteLength(JSON.stringify(report)) > USAGE_REPORT_LIMITS.reportBytes) return fail('limit')
  return report
}
export type UsageReport = Awaited<ReturnType<typeof createUsageReport>>
