import { z } from 'zod'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { apiTriggerModeSchema, triggerMetadata } from '../runtime/trigger.ts'
import type { AsyncRun, AsyncRunOptions } from '../runtime/async-run.ts'
import type { LocalRuntime } from '../runtime/local.ts'
import type { PostgresRuntime } from '../runtime/postgres.ts'
import type { LocalRun } from '../runtime/run-types.ts'
import { inspectRelease } from '../releases/snapshot.ts'

const id = z.uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/u)
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const asyncRunPolicySchema = z.strictObject({ maxConcurrentRuns: z.number().int().min(1).max(64) })
export type AsyncRunPolicy = z.infer<typeof asyncRunPolicySchema>
export const asyncReleasePinSchema = z.strictObject({ id, sha256: hash, revision: hash })
const start = { id, input: z.json(), paused: z.boolean().optional(), triggerMode: apiTriggerModeSchema.optional() }
export const asyncRunRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('workflow'), ...start, yaml: z.string() }),
  z.strictObject({ kind: z.literal('project'), ...start, project: z.strictObject({ id, generation, revision: hash }) }),
  z.strictObject({ kind: z.literal('release'), ...start, release: asyncReleasePinSchema }),
])
export type AsyncRunRequest = z.input<typeof asyncRunRequestSchema>
export const asyncRunMetadataSchema = z.strictObject({ id, revision: hash,
  status: z.enum(['paused', 'executing', 'waiting', 'completed', 'failed', 'cancelled']),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), triggerMode: apiTriggerModeSchema.optional(),
  startedPaused: z.literal(true).optional(), project: z.strictObject({ id, generation }).optional(),
  release: z.strictObject({ id, sha256: hash }).optional(), test: z.strictObject({ id, generation, sha256: hash }).optional(),
})
export const asyncRunReceiptSchema = z.strictObject({ format: z.literal('jevable.ai/async-run'), schemaVersion: z.literal(1),
  instanceId: id, observation: z.enum(['created', 'retained', 'read']), run: asyncRunMetadataSchema })
export type AsyncRunReceipt = z.infer<typeof asyncRunReceiptSchema>

/** Deliberate metadata projection: no source, input/output, actor, node payload or completion promise. */
export function asyncRunReceipt(instanceId: string, run: LocalRun, observation: AsyncRunReceipt['observation']): AsyncRunReceipt {
  return asyncRunReceiptSchema.parse({ format: 'jevable.ai/async-run', schemaVersion: 1, instanceId, observation,
    run: { id: run.id, revision: run.revision, status: run.state.status, createdAt: run.createdAt, updatedAt: run.updatedAt,
      ...triggerMetadata(run), ...(run.startedPaused ? { startedPaused: true } : {}),
      ...(run.project ? { project: run.project } : {}), ...(run.release ? { release: run.release } : {}), ...(run.test ? { test: run.test } : {}) } })
}

type Methods = 'runAsync' | 'runProjectAsync' | 'runReleaseAsync' | 'show' | 'release'
type Runtime = Pick<LocalRuntime, Methods> | Pick<PostgresRuntime, Methods>
export interface AsyncRunHost {
  start(value: unknown): Promise<AsyncRun>
  show(id: string): Promise<LocalRun>
}

/** Trusted owned SDK adapter only. The HTTP transport independently controls opt-in/authentication/lifetime. */
export class AsyncRunSession implements AsyncRunHost {
  private readonly pinnedRelease: ReturnType<typeof inspectRelease> | undefined
  constructor(private readonly runtime: Runtime, snapshot?: unknown) {
    this.pinnedRelease = snapshot === undefined ? undefined : inspectRelease(snapshot)
  }
  async start(value: unknown): Promise<AsyncRun> {
    const parsed = asyncRunRequestSchema.safeParse(value)
    if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
    const request = parsed.data
    if (this.pinnedRelease && request.kind !== 'release') throw new WorkflowRuntimeError('invalid-command')
    const options: AsyncRunOptions = { id: request.id, ...(request.paused === undefined ? {} : { paused: request.paused }), ...triggerMetadata(request) }
    if (request.kind === 'workflow') return this.runtime.runAsync(request.yaml, request.input, options)
    if (request.kind === 'project') return this.runtime.runProjectAsync(request.project.id, request.project.generation, request.project.revision, request.input, options)
    // An exact-release service compares all pins before reading any caller-selected owner release.
    if (this.pinnedRelease && (request.release.id !== this.pinnedRelease.snapshot.id || request.release.sha256 !== this.pinnedRelease.sha256
      || request.release.revision !== this.pinnedRelease.snapshot.workflow.revision)) throw new WorkflowRuntimeError('conflict')
    const release = this.pinnedRelease ?? await this.runtime.release(request.release.id)
    if (release.sha256 !== request.release.sha256 || release.snapshot.workflow.revision !== request.release.revision)
      throw new WorkflowRuntimeError('conflict')
    return this.runtime.runReleaseAsync(release.snapshot, request.input, options)
  }
  async show(value: string): Promise<LocalRun> {
    const parsed = id.safeParse(value)
    if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
    const run = await this.runtime.show(parsed.data)
    if (this.pinnedRelease && (run.release?.id !== this.pinnedRelease.snapshot.id || run.release.sha256 !== this.pinnedRelease.sha256
      || run.revision !== this.pinnedRelease.snapshot.workflow.revision)) throw new WorkflowRuntimeError('not-found')
    return run
  }
}
