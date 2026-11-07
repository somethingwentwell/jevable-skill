import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { callerBinding, callerBindingSchema, verifyCallerBinding } from '../src/access/caller.ts'
import { issueGrantRecord, grantMetadata, grantHistory, revokeGrantRecord, prepareGrantToken } from '../src/access/grants.ts'
import { admitGrantAction } from '../src/access/actions.ts'
import { RunLedger } from '../src/runtime/run-ledger.ts'
import { validateRunTransition } from '../src/runtime/run-transition.ts'
import { executionCheckpointHash, runTrace, type LocalRun } from '../src/runtime/run-types.ts'
import { compileLocalRun, initialCheckpoint } from '../src/runtime/run-evaluator.ts'
import { DEFAULT_COMPILER_LIMITS as limits } from '../src/limits.ts'
import { inspectRelease } from '../src/releases/snapshot.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { PostgresRunStore } from '../src/runtime/postgres-store.ts'
import type { PostgresJournal } from '../src/storage/postgres.ts'

const graph = compileLocalRun(await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8'), limits)
const at = '2026-10-02T00:00:00.000Z', expiresAt = '2026-10-03T00:00:00.000Z'
function fixture() {
  const release = inspectRelease({ format: 'jevable.ai/release', schemaVersion: 1, id: randomUUID(), version: '1.0.0', createdAt: at,
    createdBy: 'owner:test', project: { id: randomUUID(), generation: 1 }, workflow: { yaml: graph.source.yaml, revision: graph.source.revision },
    runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  const pin = { id: release.snapshot.id, sha256: release.sha256, revision: graph.source.revision }, p = prepareGrantToken(randomUUID())
  const grant = issueGrantRecord({ id: p.id, tokenSha256: p.tokenSha256, expiresAt, actor: 'owner:test',
    scope: { kind: 'caller', release: pin, permissions: ['read', 'start'] } }, at)
  const caller = callerBinding(admitGrantAction(grant, { id: p.id, tokenSha256: p.tokenSha256 }, { kind: 'start', release: pin }, { kind: 'release', release: pin }, at))
  const run: LocalRun = { schemaVersion: 1, id: randomUUID(), yaml: graph.source.yaml, revision: pin.revision, input: 'private',
    createdAt: at, updatedAt: at, state: initialCheckpoint(graph), startedPaused: true, loopDeadlines: {},
    release: { id: pin.id, sha256: pin.sha256 }, caller }
  const evidence = { release, grant: grantMetadata(grant, at), events: [{ kind: 'run-created', data: { revision: run.revision, startedPaused: true, release: run.release, caller } }] }
  return { run, evidence, grant }
}
describe('durable authenticated caller creation evidence', () => {
  it('validates immutable historical scope, independent of current expired/revoked status', () => {
    const f = fixture(), ledger = new RunLedger(limits), original = structuredClone(f)
    expect(ledger.check(f.run, f.evidence).source.revision).toBe(f.run.revision)
    const revoked = revokeGrantRecord(f.grant, { id: f.grant.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' }, at)
    expect(ledger.check(f.run, { ...f.evidence, grant: grantMetadata(revoked, expiresAt) }).source.revision).toBe(f.run.revision)
    expect(ledger.check(f.run, { ...f.evidence, grant: grantMetadata(f.grant, expiresAt) }).source.revision).toBe(f.run.revision)
    expect(f).toEqual(original)
  })
  it.each(['actor', 'id', 'time', 'scope', 'release', 'revision', 'project', 'test', 'no-grant', 'other-grant', 'issued-later', 'expired-earlier', 'revoked-earlier'] as const)(
    'refuses %s substitution even if both snapshot and creation event are changed together', damage => {
      const f = fixture(), run = structuredClone(f.run), metadata = structuredClone(f.evidence.grant)
      if (!run.caller) throw Error('fixture caller')
      if (damage === 'actor') run.caller.actor = 'owner:forged'
      if (damage === 'id') { run.caller.grantId = randomUUID(); run.caller.actor = `grant:${run.caller.grantId}` }
      if (damage === 'time') run.caller.at = '2026-10-02T00:00:01.000Z'
      if (damage === 'scope') run.caller.scope.permissions = ['start']
      if (damage === 'release') run.caller.scope.release.sha256 = 'b'.repeat(64)
      if (damage === 'revision') run.caller.scope.release.revision = 'c'.repeat(64)
      if (damage === 'project') run.project = { id: randomUUID(), generation: 1 }
      if (damage === 'test') run.test = { id: randomUUID(), generation: 1, sha256: 'd'.repeat(64) }
      if (damage === 'other-grant') metadata.id = randomUUID()
      if (damage === 'issued-later') metadata.issuedAt = '2026-10-02T00:00:01.000Z'
      if (damage === 'expired-earlier') { metadata.issuedAt = '2026-10-01T00:00:00.000Z'; metadata.expiresAt = at; metadata.status = 'expired' }
      if (damage === 'revoked-earlier') { metadata.issuedAt = '2026-10-01T00:00:00.000Z'; metadata.generation = 2; metadata.status = 'revoked'
        metadata.revocation = { requestId: randomUUID(), previousGeneration: 1, actor: 'owner:test', at: '2026-10-01T23:59:59.999Z' } }
      expect(() => verifyCallerBinding(run, damage === 'no-grant' ? undefined : metadata)).toThrow('corrupt')
    })
  it('requires matching creation evidence and binds control checkpoint identity to authenticated provenance', () => {
    const f = fixture(), ledger = new RunLedger(limits), without = { ...f.run }; delete without.caller
    expect(executionCheckpointHash(f.run)).not.toBe(executionCheckpointHash(without))
    expect(() => ledger.check(without, f.evidence)).toThrow('corrupt')
    const evidence = { ...f.evidence, events: [{ kind: 'run-created', data: { revision: f.run.revision, startedPaused: true, release: f.run.release } }] }
    expect(() => ledger.check(f.run, evidence)).toThrow('corrupt')
    const segment = { operation: 'resume' as const, at, trace: runTrace.parse({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }) }
    expect(() => validateRunTransition(f.run, { ...without, traceSegments: [segment] }, 'execution-segment', segment, graph, limits)).toThrow('conflict')
  })
  it.each([{ actor: 'forged' }, { token: 'raw-secret' }, { scope: { kind: 'owner' } }])('refuses expanded private binding: %j', patch => {
    const f = fixture(); expect(callerBindingSchema.safeParse({ ...f.run.caller, ...patch }).success).toBe(false)
  })
  it.each(['valid', 'revoked', 'missing', 'changed-history'] as const)('PostgreSQL verified reader resolves %s historical grant without nesting its domain gate (journal double)', async kind => {
    const f = fixture(), grant = kind === 'revoked' ? revokeGrantRecord(f.grant,
      { id: f.grant.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' }, at) : f.grant
    const release = f.evidence.release, projectId = release.snapshot.project.id
    const rows = new Map<string, unknown>([
      [`runs/${f.run.id}`, { key: f.run.id, version: '1', value: { format: 'jevable.pg-run/v1', record: f.run } }],
      [`releases/${release.snapshot.id}`, { key: release.snapshot.id, version: '1', value: { format: 'jevable.pg-release/v1', ...release } }],
      [`release-versions/${projectId}/1.0.0`, { key: `${projectId}/1.0.0`, version: '1', value: { format: 'jevable.pg-release-version/v1',
        projectId, version: '1.0.0', firstReleaseId: release.snapshot.id } }],
    ])
    if (kind !== 'missing') rows.set(`access-grants/${grant.id}`, { key: grant.id, version: String(grant.generation), value: grant })
    const history = structuredClone([grantHistory(f.grant), ...(grant.revocation ? [grantHistory(grant, f.grant)] : [])])
    if (kind === 'changed-history') history[0]!.record.issuer = 'forged'
    const journal = { signal: new AbortController().signal,
      get: async (collection: string, key: string) => structuredClone(rows.get(`${collection}/${key}`)),
      events: async (after: string, _limit: number, collections: string[]) => {
        if (collections[0] === 'access-grants') return { events: history.map((data, i) => ({ sequence: String(i + 1), kind: data.kind, batchId: data.requestId, data })), cursor: String(history.length) }
        return { events: after === '0' ? [{ sequence: '1', kind: 'run-created', data: { format: 'jevable.pg-run-event/v1', version: '1', at, data: f.evidence.events[0]!.data } }] : [], cursor: '1' }
      },
    } as unknown as PostgresJournal
    const reader = new PostgresRunStore(journal)
    if (kind === 'missing' || kind === 'changed-history') await expect(reader.get(f.run.id)).rejects.toHaveProperty('code', 'corrupt')
    else expect((await reader.get(f.run.id)).record).toEqual(f.run)
  })
})
