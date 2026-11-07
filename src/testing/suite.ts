import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { parseTest, testIdentitySchema, type TestIdentity } from './schema.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { withSuiteObservation, type SuiteObservationIdentity, type SuiteObservation, type SuiteCaseReporter } from './suite-observation.ts'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const selectionSchema = z.strictObject({ title: z.string().trim().min(1).max(256),
  failurePolicy: z.enum(['stop', 'continue']), concurrency: z.number().int().min(1).max(8).optional(),
  tests: z.array(testIdentitySchema).min(1).max(100) })
const suiteSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('JevableTestSuite'),
  title: selectionSchema.shape.title, failurePolicy: selectionSchema.shape.failurePolicy,
  concurrency: selectionSchema.shape.concurrency,
  entries: z.array(z.strictObject({ test: testIdentitySchema, runId: z.uuid() })).min(1).max(100),
}).refine(value => new Set(value.entries.map(entry => entry.runId)).size === value.entries.length)
export type TestSuite = z.infer<typeof suiteSchema>
export type TestSuiteSelection = z.infer<typeof selectionSchema>
export { selectionSchema as testSuiteSelectionSchema, suiteSchema as testSuiteSchema }
export const TEST_SUITE_MAX_BYTES = 100000

/** Preparation allocates run identities only; save this manifest before any dispatch. */
export function createTestSuite(value: TestSuiteSelection) {
  const selection = parseTest(selectionSchema, value, TEST_SUITE_MAX_BYTES)
  return inspectTestSuite({ schemaVersion: 1, kind: 'JevableTestSuite', title: selection.title, failurePolicy: selection.failurePolicy,
    ...(selection.concurrency === undefined ? {} : { concurrency: selection.concurrency }),
    entries: selection.tests.map(test => ({ test, runId: randomUUID() })) })
}
export function inspectTestSuite(value: unknown) {
  const suite = parseTest(suiteSchema, value, TEST_SUITE_MAX_BYTES)
  return { suite, sha256: createHash('sha256').update(JSON.stringify(suite)).digest('hex') }
}

export interface TestSuiteHost {
  observeTestSuite?(identity: SuiteObservationIdentity): SuiteObservation | undefined
  testResult(runId: string): unknown | Promise<unknown>
  testCase(id: string): unknown | Promise<unknown>
  project(id: string): unknown | Promise<unknown>
  runTest(test: TestIdentity, runId: string): unknown | Promise<unknown>
}
const status = z.enum(['completed', 'failed', 'cancelled', 'executing', 'waiting', 'paused'])
const resultSchema = z.object({ schemaVersion: z.literal(1), test: testIdentitySchema,
  assessment: z.enum(['passed', 'failed', 'pending', 'uncertain']), workflowStatus: status,
  terminal: z.boolean(), observedRunUpdatedAt: z.iso.datetime(),
  checks: z.array(z.object({ matched: z.boolean(), available: z.boolean() })).min(1).max(64),
  run: z.object({ id: z.uuid(), test: testIdentitySchema, revision: hash, checkpointSha256: hash, status, updatedAt: z.iso.datetime() }),
})
const caseSchema = z.object({ id: z.uuid(), generation: z.number().int().positive(), sha256: hash, status: z.enum(['draft', 'accepted']),
  archived: z.boolean().optional(),
  definition: z.object({ project: z.object({ id: z.uuid(), generation: z.number().int().positive(), revision: hash }) }) })
const projectSchema = z.object({ id: z.uuid(), generation: z.number().int().positive(), acceptedRevision: hash, archived: z.boolean() })
export interface SuiteEntryResult {
  index: number; test: TestIdentity; runId: string; observation: 'not-observed' | 'retained' | 'submitted';
  result?: { assessment: 'passed' | 'failed' | 'pending' | 'uncertain'; workflowStatus: z.infer<typeof status>; terminal: boolean;
    revision: string; checkpointSha256: string; observedRunUpdatedAt: string; matchedChecks: number; totalChecks: number };
  error?: { stage: 'read' | 'preflight' | 'submission'; code: string; execution: 'not-requested' | 'may-have-started; inspect-retained-run' };
}
export type SuiteStatus = 'passed' | 'failed' | 'pending' | 'attention' | 'uncertain' | 'blocked' | 'interrupted'
export interface TestSuiteReport {
  schemaVersion: 1; suiteSha256: string; mode: 'run' | 'result'; status: SuiteStatus; failurePolicy: 'stop' | 'continue';
  concurrency?: number;
  entries: SuiteEntryResult[]; consistency: 'per-run-observations; not-an-atomic-snapshot';
}
const knownErrors = new Set(['not-found', 'conflict', 'archived', 'busy', 'corrupt', 'closed', 'limit', 'invalid-command',
  'ownership-lost', 'commit-uncertain', 'unavailable', 'request-timeout', 'transport-uncertain', 'protocol-mismatch', 'unauthorized', 'instance-mismatch'])
function code(error: unknown) {
  const value = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return typeof value === 'string' && knownErrors.has(value) ? value : 'operation-failed'
}
/** Shared retained-assessment admission for read-only suite projections. */
export function readSuiteEntryResult(value: unknown, entry: SuiteEntryResult): NonNullable<SuiteEntryResult['result']> {
  const parsed = resultSchema.safeParse(value)
  if (!parsed.success) throw new WorkflowRuntimeError('corrupt')
  const r = parsed.data, terminal = ['completed', 'failed', 'cancelled'].includes(r.workflowStatus)
  const allMatched = r.checks.every(check => check.matched && check.available)
  if (r.run.id !== entry.runId || !isDeepStrictEqual(r.test, entry.test) || !isDeepStrictEqual(r.run.test, entry.test)
    || r.run.status !== r.workflowStatus || r.run.updatedAt !== r.observedRunUpdatedAt || r.terminal !== terminal
    || (terminal && !['passed', 'failed'].includes(r.assessment)) || (r.workflowStatus === 'executing' && r.assessment !== 'uncertain')
    || (r.workflowStatus === 'paused' && r.assessment !== 'pending')
    || r.checks.some(check => check.matched && !check.available)
    || (r.assessment === 'passed' && !allMatched) || (r.assessment === 'failed' && allMatched)) throw new WorkflowRuntimeError('conflict')
  return { assessment: r.assessment, workflowStatus: r.workflowStatus, terminal, revision: r.run.revision,
    checkpointSha256: r.run.checkpointSha256, observedRunUpdatedAt: r.observedRunUpdatedAt,
    matchedChecks: r.checks.filter(check => check.matched).length, totalChecks: r.checks.length }
}
function state(entries: SuiteEntryResult[]): SuiteStatus {
  if (entries.some(entry => entry.error)) return 'blocked'
  if (entries.some(entry => entry.result?.assessment === 'uncertain')) return 'uncertain'
  if (entries.some(entry => entry.result && !entry.result.terminal)) return 'attention'
  if (entries.some(entry => entry.result?.assessment === 'failed')) return 'failed'
  if (entries.some(entry => !entry.result)) return 'pending'
  return 'passed'
}
async function observe(host: TestSuiteHost, suite: TestSuite, signal?: AbortSignal) {
  const entries: SuiteEntryResult[] = suite.entries.map((entry, index) => ({ index, test: entry.test, runId: entry.runId, observation: 'not-observed' }))
  for (const row of entries) {
    if (signal?.aborted) break
    try { row.result = readSuiteEntryResult(await host.testResult(row.runId), row); row.observation = 'retained' }
    catch (error) {
      if (code(error) !== 'not-found') { row.error = { stage: 'read', code: code(error), execution: 'not-requested' }; break }
    }
  }
  return entries
}
function report(suite: TestSuite, sha256: string, entries: SuiteEntryResult[], mode: 'run' | 'result', override?: SuiteStatus): TestSuiteReport {
  return { schemaVersion: 1, suiteSha256: sha256, mode, status: override ?? state(entries), failurePolicy: suite.failurePolicy,
    ...(suite.concurrency === undefined ? {} : { concurrency: suite.concurrency }),
    entries, consistency: 'per-run-observations; not-an-atomic-snapshot' }
}
/** Read saved assessments, including missing runs. No acceptance or execution is performed. */
export async function testSuiteResult(host: TestSuiteHost, value: unknown) {
  const { suite, sha256 } = inspectTestSuite(value)
  return withSuiteObservation(host, { sha256, mode: 'result', failurePolicy: suite.failurePolicy,
    entries: suite.entries.length, concurrency: suite.concurrency ?? 1 }, async () =>
    report(suite, sha256, await observe(host, suite), 'result'))
}
/** Whole-batch review preflight, then bounded guarded dispatch. Completed work is never rolled back. */
export async function runTestSuite(host: TestSuiteHost, value: unknown, reviewedSha256: string, options: { signal?: AbortSignal } = {}) {
  const { suite, sha256 } = inspectTestSuite(value)
  if (reviewedSha256 !== sha256) throw new WorkflowRuntimeError('conflict')
  const signal = options.signal
  if (Object.keys(options).some(key => key !== 'signal') || (signal !== undefined && !(signal instanceof AbortSignal))) throw new WorkflowRuntimeError('invalid-command')
  return withSuiteObservation(host, { sha256, mode: 'run', failurePolicy: suite.failurePolicy,
    entries: suite.entries.length, concurrency: suite.concurrency ?? 1 }, cases => executeSuite(host, suite, sha256, cases, signal))
}
async function executeSuite(host: TestSuiteHost, suite: TestSuite, sha256: string, cases: SuiteCaseReporter, signal?: AbortSignal) {
  const options = { signal }
  const entries = await observe(host, suite, options.signal)
  if (options.signal?.aborted) return report(suite, sha256, entries, 'run', 'interrupted')
  if (entries.some(row => row.error)) return report(suite, sha256, entries, 'run', 'blocked')
  // Existing historical runs are assessed under their saved pins; current edits
  // only prevent new execution. No model admission or readiness is claimed here.
  for (const row of entries) {
    if (options.signal?.aborted) return report(suite, sha256, entries, 'run', 'interrupted')
    if (row.result || row.error) continue
    try {
      const test = caseSchema.parse(await host.testCase(row.test.id)), pin = test.definition.project
      if (test.archived) throw new WorkflowRuntimeError('archived')
      if (test.id !== row.test.id || test.generation !== row.test.generation || test.sha256 !== row.test.sha256 || test.status !== 'accepted') throw new WorkflowRuntimeError('conflict')
      const project = projectSchema.parse(await host.project(pin.id))
      if (project.archived) throw new WorkflowRuntimeError('archived')
      if (project.id !== pin.id || project.generation !== pin.generation || project.acceptedRevision !== pin.revision) throw new WorkflowRuntimeError('conflict')
    } catch (error) { row.error = { stage: 'preflight', code: code(error), execution: 'not-requested' } }
  }
  if (entries.some(row => row.error)) return report(suite, sha256, entries, 'run', 'blocked')
  // Unfinished retained work anywhere in the manifest requires inspection before
  // admitting additional cases, even if the manifest orders a new case first.
  if (entries.some(row => row.result && !row.result.terminal)) return report(suite, sha256, entries, 'run')
  // Only new, preflight-admitted cases enter this process-local queue. Reads and
  // retained assessments are not executions, and stopping discards waiting work.
  if ((suite.concurrency ?? 1) > 1 && suite.failurePolicy === 'stop' && entries.some(row => row.result?.assessment === 'failed'))
    return report(suite, sha256, entries, 'run')
  const queue = suiteDispatchQueue(host, entries, cases, signal)
  try {
    if ((suite.concurrency ?? 1) > 1) return await runParallel(suite, sha256, entries, queue, options.signal)
    for (const row of entries) {
      if (options.signal?.aborted) return report(suite, sha256, entries, 'run', 'interrupted')
      if (!row.result) {
        try { row.observation = 'submitted'; row.result = await queue.submit(row) }
        catch (error) {
          row.error = { stage: 'submission', code: code(error), execution: 'may-have-started; inspect-retained-run' }
          return report(suite, sha256, entries, 'run', 'blocked')
        }
      }
      if (!row.result.terminal || (row.result.assessment === 'failed' && suite.failurePolicy === 'stop')) return report(suite, sha256, entries, 'run')
    }
    return report(suite, sha256, entries, 'run', options.signal?.aborted ? 'interrupted' : undefined)
  } finally { queue.close() }
}

function suiteDispatchQueue(host: TestSuiteHost, entries: SuiteEntryResult[], cases: SuiteCaseReporter, signal?: AbortSignal) {
  let waiting = entries.filter(row => !row.result).length, running = 0, settled = 0
  const emit = () => cases({ waiting, running, settled })
  const stop = () => { waiting = 0; emit() }
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) waiting = 0
  emit()
  return {
    stop,
    async submit(row: SuiteEntryResult) {
      waiting--; running++; emit()
      try { return readSuiteEntryResult(await host.runTest(row.test, row.runId), row) }
      finally { running--; settled++; emit() }
    },
    close() { signal?.removeEventListener('abort', stop); stop() },
  }
}

/** No detached work: every admitted call settles before returning, even after stop/abort. */
async function runParallel(suite: TestSuite, sha256: string, entries: SuiteEntryResult[], queue: ReturnType<typeof suiteDispatchQueue>, signal?: AbortSignal) {
  let next = 0, stopped = false
  const worker = async () => {
    while (!stopped && !signal?.aborted && next < entries.length) {
      const row = entries[next++]!
      if (row.result) continue
      try {
        row.observation = 'submitted'
        row.result = await queue.submit(row)
        if (!row.result.terminal || (row.result.assessment === 'failed' && suite.failurePolicy === 'stop')) { stopped = true; queue.stop() }
      } catch (error) {
        row.error = { stage: 'submission', code: code(error), execution: 'may-have-started; inspect-retained-run' }
        stopped = true
        queue.stop()
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(suite.concurrency!, entries.length) }, worker))
  return report(suite, sha256, entries, 'run', signal?.aborted ? 'interrupted' : undefined)
}
