import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID, webcrypto } from 'node:crypto'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { LocalRuntime } from '../src/runtime/local.ts'
import { createUsageReport } from '../src/evidence/usage.ts'
import { previewUsageTools, projectPreviewUsage, type PreviewUsageQuery } from '../src/preview/usage.ts'

// Synthetic accounting snapshots on an actual echo envelope, not model/browser qualification.
const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const closes: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
const window = { from: '2020-01-01T00:00:00.000Z', before: '2020-01-02T00:00:00.000Z' }
function recorded(status: 'completed' | 'failed' | 'pending' = 'completed', tries = 1) {
  return { nodeId: 'model', attemptId: randomUUID(), evidence: 'recorded', evidenceSchemaVersion: tries === 1 ? 1 : 2, status,
    ...(status === 'completed' ? { usage: { tries, inputTokens: 0, outputTokens: 0 } } : {}),
    ...(tries === 1 ? {} : { policy: { kind: 'transient-http-v1', maxAttempts: 10 },
      tries: Array.from({ length: tries }, (_, i) => ({ id: randomUUID(), number: i + 1, status: i === tries - 1 ? status : 'failed' })) }) }
}
const unrecorded = () => ({ nodeId: 'custom', attemptId: randomUUID(), evidence: 'not-recorded' })
async function fixture(calls: unknown[] | null = [], options: Pick<PreviewUsageQuery, 'window' | 'groupBy'> = {}) {
  const runtime = await LocalRuntime.open({ dataDirectory: join(await mkdtemp(join(tmpdir(), 'jevable-preview-accounting-')), 'state') })
  closes.push(() => runtime.close())
  const run = await runtime.run(source, 'PRIVATE_INPUT'), envelope: any = structuredClone(await runtime.exportRun(run.id))
  if (calls === null) delete envelope.snapshot.models
  else envelope.snapshot.models.calls = calls
  if (options.groupBy) {
    envelope.snapshot.privacy.modelIdentities = 'included-by-explicit-usage-request'
    if (envelope.snapshot.models) envelope.snapshot.models.usageIdentities = 'requested-provider-model/v1'
  }
  envelope.checksum.value = createHash('sha256').update(JSON.stringify(envelope.snapshot)).digest('hex')
  const query = { runId: run.id, revision: run.revision, ...options }
  const report = await createUsageReport({ exportRun: () => envelope, exportUsageRun: () => envelope },
    { schemaVersion: 1, runs: [{ id: run.id, revision: run.revision }], ...options })
  return { query, report, payload: await projectPreviewUsage(query, report) }
}
const serializedTools = () => runInNewContext(`(${previewUsageTools.toString()})()`, { crypto: webcrypto, TextEncoder, Uint8Array })
describe('preview accounting conservation (synthetic reports, not browser evidence)', () => {
  it.each(['completed', 'failed', 'pending'] as const)('preserves every supported retry count for %s', async status => {
    const f = await fixture(Array.from({ length: 10 }, (_, i) => recorded(status, i + 1)))
    expect(f.payload.summary.recordedTries).toBe(55)
    expect(f.payload.summary.failedOrPendingTries).toBe(status === 'completed' ? 45 : 55)
    expect(await serializedTools().admit(f.query, f.payload)).toEqual(f.payload)
  })
  it.each([[], [unrecorded()], null])('preserves empty/unrecorded/unavailable accounting: %j', async calls => {
    const f = await fixture(calls)
    expect(f.payload.summary.recordedTries).toBe(0)
    expect(await serializedTools().admit(f.query, f.payload)).toEqual(f.payload)
  })
  it.each(['provider', 'provider-model'] as const)('preserves known, unknown and unlocated %s groups', async groupBy => {
    const identity = { provider: '__proto__', model: 'm'.repeat(256) }
    const f = await fixture([{ ...recorded('completed', 10), usageIdentity: identity, intentAt: window.from },
      { ...recorded('pending'), usageIdentity: identity }, unrecorded()], { groupBy, window })
    expect(f.payload.summary.recordedTries).toBe(10)
    expect(f.payload.windowCoverage).toMatchObject({ observedModelIntents: 3, unlocatedModelIntents: 2 })
    expect(await serializedTools().admit(f.query, f.payload)).toEqual(f.payload)
    const missing = await fixture(null, { groupBy, window })
    expect(await serializedTools().admit(missing.query, missing.payload)).toEqual(missing.payload)
  })
  it.each(['orphan', 'unrecorded-tries', 'completed-retry-without-failure', 'completed-success-marked-failed',
    'failed-without-tries', 'pending-without-tries', 'eleven-tries', 'unavailable-with-window-intents'])(
    'refuses impossible aggregate accounting: %s', async fault => {
      const calls = fault === 'orphan' ? [] : fault === 'unrecorded-tries' ? [unrecorded()] : fault.startsWith('failed') ? [recorded('failed')]
        : fault.startsWith('pending') ? [recorded('pending')] : fault.startsWith('unavailable') ? null : [recorded('completed', fault === 'eleven-tries' ? 10 : 1)]
      const f = await fixture(calls, fault.startsWith('unavailable') ? { window } : {}), v: any = structuredClone(f.payload)
      if (fault === 'orphan' || fault === 'unrecorded-tries' || fault === 'completed-retry-without-failure') v.summary.recordedTries++
      if (fault === 'completed-success-marked-failed') {
        v.summary.failedOrPendingTries = 1
        v.summary.inputTokens.coverage = v.summary.outputTokens.coverage = 'partial'
      }
      if (fault === 'failed-without-tries' || fault === 'pending-without-tries') v.summary.recordedTries = v.summary.failedOrPendingTries = 0
      if (fault === 'eleven-tries') { v.summary.recordedTries++; v.summary.failedOrPendingTries++ }
      if (fault === 'unavailable-with-window-intents') { v.windowCoverage.observedModelIntents = 1; v.windowCoverage.outsideWindow = 1 }
      await expect(serializedTools().admit(f.query, v)).rejects.toThrow('Usage cannot be safely matched')
    })
  it.each(['unknown-recorded', 'known-unrecorded', 'known-unavailable', 'padded-provider', 'long-model', 'empty-bucket'])(
    'refuses impossible opted-in group provenance: %s', async fault => {
      const groupBy = 'provider-model', calls = fault === 'known-unavailable' ? null : fault === 'known-unrecorded' ? [unrecorded()]
        : fault === 'empty-bucket' ? [] : [{ ...recorded(), usageIdentity: { provider: 'p', model: 'm' } }]
      const f = await fixture(calls, { groupBy }), v: any = structuredClone(f.payload)
      if (fault === 'empty-bucket') v.groups.push({ key: { provider: 'p', model: 'm' }, summary: structuredClone(v.summary), unlocatedModelIntents: 0 })
      else if (fault === 'unknown-recorded') v.groups[0].key = { provider: null, model: null }
      else if (fault === 'known-unrecorded' || fault === 'known-unavailable') v.groups[0].key = { provider: 'p', model: 'm' }
      else if (fault === 'padded-provider') v.groups[0].key.provider = ' p '
      else v.groups[0].key.model = 'm'.repeat(257)
      await expect(serializedTools().admit(f.query, v)).rejects.toThrow('Usage cannot be safely matched')
    })
})
