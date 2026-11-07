import { z } from 'zod'
import type { Project } from '../projects/ledger.ts'
import type { LocalRun } from './run-types.ts'
import { WorkflowRuntimeError } from './errors.ts'

export const ACTIVITY_LIMITS = Object.freeze({ projects: 1000, runs: 100000, projectChanges: 1000000 })
const count = z.number().int().min(0).max(ACTIVITY_LIMITS.projectChanges)
const states = z.strictObject({ paused: count, executing: count, waiting: count, completed: count, failed: count, cancelled: count })
const reviews = z.strictObject({ proposed: count, accepted: count, rejected: count })
const origins = z.strictObject({ authored: count, duplicated: count, projectBundle: count, vendor: count })
const recordedInstant = z.iso.datetime().refine(value => Number.isFinite(Date.parse(value)))
const firstRun = z.strictObject({ id: z.uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/u), createdAt: recordedInstant,
  status: z.enum(['paused', 'executing', 'waiting', 'completed', 'failed', 'cancelled']) })
const runMetadata = firstRun.extend({ createdAt: recordedInstant, triggerMode: z.literal('api').optional(),
  project: z.strictObject({ id: z.uuid(), generation: z.number().int().positive() }).optional(),
  release: z.strictObject({ id: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).optional() })
function compareInstants(left: string, right: string) {
  const difference = Date.parse(left) - Date.parse(right)
  if (difference !== 0) return difference
  // Date.parse truncates finer fractions. Compare the retained sub-millisecond tail before UUIDs.
  const tail = (value: string) => (/\.(\d+)Z$/u.exec(value)?.[1]?.slice(3) ?? '').replace(/0+$/u, '')
  const a = tail(left), b = tail(right), width = Math.max(a.length, b.length)
  const paddedA = a.padEnd(width, '0'), paddedB = b.padEnd(width, '0')
  return paddedA < paddedB ? -1 : paddedA > paddedB ? 1 : 0
}
const projectMetadata = z.strictObject({ id: z.uuid(), generation: z.number().int().min(1).max(1000), archived: z.boolean(),
  origin: z.enum(['authored', 'duplicated', 'projectBundle', 'vendor']),
  proposals: z.strictObject({ pending: count, accepted: count, rejected: count, importedHistory: count }), localActions: reviews })

/** Counts are retained installation state, not account/billing/lifetime totals or proof of live execution. */
export const activityReportSchema = z.strictObject({ schemaVersion: z.literal(1), storage: z.enum(['sqlite', 'postgres']),
  observedAt: z.iso.datetime(), scope: z.literal('selected-owner-retained-data'),
  consistency: z.literal('single-owner-coherent-observation'),
  projects: z.strictObject({ total: count, active: count, archived: count, origins }),
  proposals: z.strictObject({ total: count, pending: count, accepted: count, rejected: count,
    importedHistory: count, localActions: reviews }),
  imports: z.strictObject({ projectBundle: count, vendor: count, basis: z.literal('retained-project-origin') }),
  runs: z.strictObject({ total: count, byStatus: states, links: z.strictObject({ project: count, release: count, unlinked: count }),
    triggerSelection: z.strictObject({ api: count, defaultLocal: count }), firstRetainedRun: firstRun.nullable() }),
  privacy: z.literal('counts-and-first-run-identifiers; no-payloads-actors-or-credentials'),
  execution: z.literal('not-started-resumed-approved-or-cancelled'), billing: z.literal(false), lifetimeTotals: z.literal(false),
}).superRefine((value, ctx) => {
  const sum = (v: Record<string, number>) => Object.values(v).reduce((a, b) => a + b, 0)
  if (value.projects.total > ACTIVITY_LIMITS.projects || value.runs.total > ACTIVITY_LIMITS.runs
    || value.projects.total !== value.projects.active + value.projects.archived || value.projects.total !== sum(value.projects.origins)
    || value.imports.projectBundle !== value.projects.origins.projectBundle || value.imports.vendor !== value.projects.origins.vendor
    || value.proposals.total !== value.proposals.pending + value.proposals.accepted + value.proposals.rejected
    || value.proposals.importedHistory + value.proposals.localActions.proposed !== value.proposals.total
    || value.proposals.localActions.accepted > value.proposals.accepted || value.proposals.localActions.rejected > value.proposals.rejected
    || value.runs.total !== sum(value.runs.byStatus) || value.runs.total !== sum(value.runs.links)
    || value.runs.total !== sum(value.runs.triggerSelection) || (value.runs.total === 0) !== (value.runs.firstRetainedRun === null)
    || value.runs.firstRetainedRun && value.runs.byStatus[value.runs.firstRetainedRun.status] === 0)
    ctx.addIssue({ code: 'custom', message: 'Inconsistent retained activity counts.' })
})
export type ActivityReport = z.infer<typeof activityReportSchema>
export type ActivityProject = { id: string; generation: number; archived: boolean; origin: keyof z.infer<typeof origins>;
  proposals: { pending: number; accepted: number; rejected: number; importedHistory: number }; localActions: z.infer<typeof reviews> }
export type ActivityRun = Pick<LocalRun, 'id' | 'revision' | 'createdAt' | 'triggerMode' | 'project' | 'release'> & { status: LocalRun['state']['status'] }

/** Called only with an already decoded/replayed owned ledger. Foreign history is not local authoring activity. */
export function activityProject(project: Project, vendor: boolean): ActivityProject {
  const imported = project.changes.findLastIndex(change => change.operation === 'import')
  const local = project.changes.slice(imported + 1), localProposals = new Set(local.filter(change => change.operation === 'propose').map(change => change.proposalId))
  const proposals = { pending: 0, accepted: 0, rejected: 0, importedHistory: 0 }
  for (const proposal of project.proposals) { proposals[proposal.status]++; if (!localProposals.has(proposal.id)) proposals.importedHistory++ }
  return { id: project.id, generation: project.generation, archived: project.archived,
    origin: imported >= 0 ? 'projectBundle' : vendor ? 'vendor' : project.changes[0]?.operation === 'create' && project.changes[0].copiedFrom ? 'duplicated' : 'authored',
    proposals, localActions: { proposed: localProposals.size, accepted: local.filter(c => c.operation === 'accept').length,
      rejected: local.filter(c => c.operation === 'reject').length } }
}
export function activityRun(run: LocalRun): ActivityRun {
  return { id: run.id, revision: run.revision, createdAt: run.createdAt, status: run.state.status,
    ...(run.project ? { project: run.project } : {}), ...(run.release ? { release: run.release } : {}),
    ...(run.triggerMode ? { triggerMode: run.triggerMode } : {}) }
}

/** Bounded metadata only. Never reads storage, calls a provider, dispatches execution or exports telemetry. */
export function createActivityReport(storage: ActivityReport['storage'], projects: readonly ActivityProject[], runs: readonly ActivityRun[]): ActivityReport {
  if (projects.length > ACTIVITY_LIMITS.projects || runs.length > ACTIVITY_LIMITS.runs) throw new WorkflowRuntimeError('limit')
  const result: ActivityReport = { schemaVersion: 1, storage, observedAt: new Date().toISOString(), scope: 'selected-owner-retained-data',
    consistency: 'single-owner-coherent-observation', projects: { total: projects.length, active: 0, archived: 0,
      origins: { authored: 0, duplicated: 0, projectBundle: 0, vendor: 0 } },
    proposals: { total: 0, pending: 0, accepted: 0, rejected: 0, importedHistory: 0, localActions: { proposed: 0, accepted: 0, rejected: 0 } },
    imports: { projectBundle: 0, vendor: 0, basis: 'retained-project-origin' },
    runs: { total: runs.length, byStatus: { paused: 0, executing: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0 },
      links: { project: 0, release: 0, unlinked: 0 }, triggerSelection: { api: 0, defaultLocal: 0 }, firstRetainedRun: null },
    privacy: 'counts-and-first-run-identifiers; no-payloads-actors-or-credentials', execution: 'not-started-resumed-approved-or-cancelled', billing: false, lifetimeTotals: false }
  const projectIds = new Set(), runIds = new Set()
  for (const project of projects) {
    if (!projectMetadata.safeParse(project).success || projectIds.has(project.id)) throw new WorkflowRuntimeError('corrupt'); projectIds.add(project.id)
    result.projects[project.archived ? 'archived' : 'active']++; result.projects.origins[project.origin]++
    for (const key of ['pending', 'accepted', 'rejected', 'importedHistory'] as const) result.proposals[key] += project.proposals[key]
    for (const key of ['proposed', 'accepted', 'rejected'] as const) result.proposals.localActions[key] += project.localActions[key]
  }
  result.proposals.total = result.proposals.pending + result.proposals.accepted + result.proposals.rejected
  result.imports.projectBundle = result.projects.origins.projectBundle; result.imports.vendor = result.projects.origins.vendor
  for (const run of runs) {
    if (!runMetadata.safeParse(run).success || runIds.has(run.id) || run.project && run.release) throw new WorkflowRuntimeError('corrupt'); runIds.add(run.id)
    result.runs.byStatus[run.status]++; result.runs.links[run.project ? 'project' : run.release ? 'release' : 'unlinked']++
    result.runs.triggerSelection[run.triggerMode === 'api' ? 'api' : 'defaultLocal']++
    const first = result.runs.firstRetainedRun
    if (!first || compareInstants(run.createdAt, first.createdAt) < 0 || compareInstants(run.createdAt, first.createdAt) === 0
      && (run.id.toLowerCase() < first.id.toLowerCase() || run.id.toLowerCase() === first.id.toLowerCase() && run.id < first.id))
      result.runs.firstRetainedRun = { id: run.id, revision: run.revision, createdAt: run.createdAt, status: run.status }
  }
  const parsed = activityReportSchema.safeParse(result)
  if (!parsed.success) throw new WorkflowRuntimeError('corrupt')
  return parsed.data
}
