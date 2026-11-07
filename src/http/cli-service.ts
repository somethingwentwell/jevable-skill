import { userInfo } from 'node:os'
import { localRuntimeOptions } from '../telemetry/options.ts'
import { storageSelection, postgresRuntimeOptions } from '../cli/runtime.ts'
import { tlsOptionsFromFlags } from './tls.ts'
import { runServiceProcess } from './process.ts'
import { readBoundedFile } from '../files.ts'
import { inspectRelease } from '../releases/snapshot.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { readHttpRateLimitsFile } from './rate-limits.ts'
import { readReleaseWebhookFile } from './webhook-options.ts'
import { readCliRateCoordinator } from './cli-rate-coordinator.ts'
import type { PostgresHttpRateCoordinator } from './postgres-rate-limits.ts'

export class RuntimeStartupError extends Error {
  constructor(readonly code: string) {
    super(`Jevable PostgreSQL startup failed: ${code}. Check the selected private configuration and retained state. No fallback was attempted.`)
  }
}
export class RuntimeServiceUsageError extends Error {
  constructor() { super('Invalid runtime service options. Select sqlite with --data-dir or postgres with --database-file; see jevable --help for limits.') }
}

export async function serveFromCli(values: Record<string, string | boolean | undefined>, token: string, emit: (value: unknown) => void) {
  const storage = storageSelection(values)
  const integer = (value: string | boolean | undefined, fallback: number, min: number, max: number) => {
    if (value === undefined) return fallback
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))
      || Number(value) < min || Number(value) > max) throw new RuntimeServiceUsageError()
    return Number(value)
  }
  const port = integer(values.port, 0, 0, 65535), drainWaitMs = integer(values['drain-wait-ms'], 5000, 1, 60000)
  const asyncRuns = values['async-concurrency'] === undefined ? undefined
    : { maxConcurrentRuns: integer(values['async-concurrency'], 1, 1, 64) }
  const coordinatorOptions = await readCliRateCoordinator(values)
  const rateLimits = await readHttpRateLimitsFile(values['rate-limits-file'])
  const tls = tlsOptionsFromFlags(values), actor = `local:${userInfo().username}`
  const releaseFile = values['release-file'], releaseHash = values['release-sha256']
  if ((values['reviewer-decisions'] || values['caller-operations']) && releaseFile !== undefined) throw new RuntimeServiceUsageError()
  if ((releaseFile !== undefined || releaseHash !== undefined) && (typeof releaseFile !== 'string' || !releaseFile
    || typeof releaseHash !== 'string' || !/^[a-f0-9]{64}$/u.test(releaseHash))) throw new RuntimeServiceUsageError()
  if (values['webhooks-file'] !== undefined && (releaseFile === undefined || !asyncRuns)) throw new RuntimeServiceUsageError()
  const webhooks = await readReleaseWebhookFile(values['webhooks-file'])
  let coordinator: PostgresHttpRateCoordinator | undefined
  try { return await runServiceProcess(async () => {
    let release
    if (typeof releaseFile === 'string') {
      const text = await readBoundedFile(releaseFile, 4_000_000)
      let value: unknown
      try { value = JSON.parse(text) } catch { throw new WorkflowRuntimeError('invalid-command') }
      const inspected = inspectRelease(value)
      if (inspected.sha256 !== releaseHash) throw new WorkflowRuntimeError('conflict')
      release = { snapshot: inspected.snapshot }
    }
    const selected = storage === 'postgres' ? { storage: 'postgres' as const, runtime: await postgresRuntimeOptions(values) }
      : { storage: 'sqlite' as const, runtime: await localRuntimeOptions(values) }
    if (coordinatorOptions) {
      const { PostgresHttpRateCoordinator, PostgresHttpRateCoordinatorError } = await import('./postgres-rate-limits.ts')
      try { coordinator = await PostgresHttpRateCoordinator.open(coordinatorOptions) }
      catch (error) { throw new RuntimeStartupError(error instanceof PostgresHttpRateCoordinatorError ? error.code : 'unavailable') }
    }
    const admission = coordinator ? { coordinatedRateLimits: coordinator.admission() } : {}
    if (selected.storage === 'postgres') {
      // Strict runtime validation still occurs before connecting. The file is not an ambient PG configuration source.
      const { startPostgresRuntimeService } = await import('./postgres.ts')
      const { JournalError } = await import('../storage/postgres.ts')
      try { return await startPostgresRuntimeService({ runtime: selected.runtime,
        token, actor, port, ...admission, ...(tls ? { tls } : {}), ...(release ? { release } : {}), ...(asyncRuns ? { asyncRuns } : {}), ...(webhooks ? { webhooks } : {}), ...(rateLimits ? { rateLimits } : {}), reviewerDecisions: values['reviewer-decisions'] === true, callerOperations: values['caller-operations'] === true }) }
      catch (error) { if (error instanceof JournalError) throw new RuntimeStartupError(error.code); throw error }
    }
    const { startRuntimeService } = await import('./service.ts')
    return startRuntimeService({ runtime: selected.runtime, token, actor, port, ...admission, ...(tls ? { tls } : {}), ...(release ? { release } : {}), ...(asyncRuns ? { asyncRuns } : {}), ...(webhooks ? { webhooks } : {}), ...(rateLimits ? { rateLimits } : {}), reviewerDecisions: values['reviewer-decisions'] === true, callerOperations: values['caller-operations'] === true })
  }, storage, emit, drainWaitMs) } finally { await coordinator?.close() }
}
