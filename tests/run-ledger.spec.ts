import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { RunLedger, type RunReplayEvidence } from '../src/runtime/run-ledger.ts'
import { compileLocalRun, initialCheckpoint, advanceCheckpoint, type RunCheckpoint } from '../src/runtime/run-evaluator.ts'
import { stoppedCheckpointHash, runtimeStateSchema, type LocalRun } from '../src/runtime/run-types.ts'
import { ProjectLedger } from '../src/projects/ledger.ts'
import { TestLedger } from '../src/testing/ledger.ts'
import { inspectRelease } from '../src/releases/snapshot.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { LocalRuntime } from '../src/runtime/index.ts'

const yaml = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const graph = compileLocalRun(yaml, DEFAULT_COMPILER_LIMITS), at = '2026-09-29T00:00:00.000Z'
const ledger = () => new RunLedger(DEFAULT_COMPILER_LIMITS)
function fixture(pins: Pick<LocalRun, 'project' | 'release' | 'test'> = {}) {
  const run: LocalRun = { schemaVersion: 1, id: randomUUID(), yaml: graph.source.yaml, revision: graph.source.revision,
    input: 'retained input', createdAt: at, updatedAt: at, startedPaused: true, state: initialCheckpoint(graph), loopDeadlines: {}, ...pins }
  const evidence: RunReplayEvidence = { events: [{ kind: 'run-created', data: { revision: run.revision, startedPaused: true,
    ...(run.project ? { project: run.project } : {}), ...(run.release ? { release: run.release } : {}), ...(run.test ? { test: run.test } : {}) } }] }
  return { run, evidence }
}
const project = () => new ProjectLedger(DEFAULT_COMPILER_LIMITS.source, 4_000_000)
  .apply({ operation: 'create', title: 'Reviewed project', yaml, actor: 'local:author' }).project

describe('backend-independent run replay', () => {
  it('replays a paused checkpoint without mutating the record or resolved evidence', () => {
    const f = fixture(), before = structuredClone(f)
    expect(ledger().check(f.run, f.evidence).source.revision).toBe(f.run.revision)
    expect(f).toEqual(before)
  })

  it('requires exactly one first creation event with identical admitted provenance', () => {
    const f = fixture(), original = f.evidence.events[0]!
    for (const events of [[], [original, original], [{ kind: 'execution-segment', data: {} }, original],
      [{ ...original, data: { revision: '0'.repeat(64), startedPaused: true } }],
      [{ ...original, data: { revision: f.run.revision, startedPaused: true, project: { id: randomUUID(), generation: 1 } } }]]) {
      expect(() => ledger().check(f.run, { events })).toThrow('corrupt')
    }
  })

  it('checks resolved project identity, historical generation, accepted revision and archived status', () => {
    const p = project(), f = fixture({ project: { id: p.id, generation: p.generation } })
    ledger().check(f.run, { ...f.evidence, project: p })
    for (const patch of [{ id: randomUUID() }, { generation: 2 }, { acceptedRevision: '0'.repeat(64) }, { archived: true }]) {
      expect(() => ledger().check(f.run, { ...f.evidence, project: { ...p, ...patch } })).toThrow('corrupt')
    }
    expect(() => ledger().check(f.run, f.evidence)).toThrow('corrupt')
  })

  it('requires the exact accepted saved-test version, input and project pin', () => {
    const p = project(), tests = new TestLedger(DEFAULT_COMPILER_LIMITS, 4_000_000)
    const draft = tests.prepare({ operation: 'create', actor: 'local:author', definition: { title: 'Run case',
      project: { id: p.id, generation: 1, revision: p.acceptedRevision }, input: 'retained input', expectations: [{ kind: 'status', value: 'completed' }] } })
    const accepted = tests.prepare({ operation: 'accept', id: draft.test.id, expectedGeneration: 1, reviewedSha256: draft.test.sha256, actor: 'local:reviewer' }, draft.record).test
    const f = fixture({ project: { id: p.id, generation: 1 }, test: { id: accepted.id, generation: accepted.generation, sha256: accepted.sha256 } })
    ledger().check(f.run, { ...f.evidence, project: p, test: accepted })
    for (const patch of [{ id: randomUUID() }, { generation: 1 }, { status: 'draft' as const }, { sha256: '0'.repeat(64) },
      { definition: { ...accepted.definition, input: 'different input' } }]) {
      expect(() => ledger().check(f.run, { ...f.evidence, project: p, test: { ...accepted, ...patch } })).toThrow('corrupt')
    }
  })

  it('requires the exact immutable release and excludes combined project/release provenance', () => {
    const release = inspectRelease({ format: 'jevable.ai/release', schemaVersion: 1, id: randomUUID(), version: '1.0.0', createdAt: at,
      createdBy: 'local:publisher', project: { id: randomUUID(), generation: 1 }, workflow: { revision: graph.source.revision, yaml: graph.source.yaml },
      runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
    const f = fixture({ release: { id: release.snapshot.id, sha256: release.sha256 } })
    ledger().check(f.run, { ...f.evidence, release })
    expect(() => ledger().check(f.run, { ...f.evidence, release: { ...release, snapshot: { ...release.snapshot, id: randomUUID() } } })).toThrow('corrupt')
    expect(() => ledger().check(f.run, { ...f.evidence, release: { ...release, sha256: '0'.repeat(64) } })).toThrow('corrupt')
    const p = project(), mixed = fixture({ release: f.run.release!, project: { id: p.id, generation: 1 } })
    expect(() => ledger().check(mixed.run, { ...mixed.evidence, project: p, release })).toThrow('corrupt')
  })

  it('recomputes deterministic terminal output rather than trusting the saved result', () => {
    const f = fixture(); let state: RunCheckpoint = initialCheckpoint(graph)
    while (state.status === 'paused') state = advanceCheckpoint(graph, f.run.input, state, DEFAULT_COMPILER_LIMITS.binding.data)
    // A legacy fixture has no settlement journal or recorded route fields.
    f.run.state = { ...state, steps: state.steps.map(({ port: _port, ...step }) => step) }
    ledger().check(f.run, f.evidence)
    if (f.run.state.status !== 'completed') throw Error('Expected completion')
    f.run.state.output = 'forged output'
    expect(() => ledger().check(f.run, f.evidence)).toThrow('corrupt')
  })

  it('preserves control identity and exact cancellation evidence while replaying the stopped checkpoint', () => {
    const f = fixture(), request = { requestId: randomUUID(), expectedCheckpointSha256: 'a'.repeat(64), mode: 'step' as const, actor: 'local:user', at }
    f.run.controlRequests = [request]
    f.evidence.events = [...f.evidence.events, { kind: 'execution-requested', data: request }]
    ledger().check(f.run, f.evidence)
    expect(() => ledger().check(f.run, { ...f.evidence, events: f.evidence.events.slice(0, 1) })).toThrow('corrupt')
    f.run.cancellation = { id: randomUUID(), actor: 'local:user', at }
    if (f.run.state.status !== 'paused') throw Error('Expected pause')
    const cancelled = runtimeStateSchema.parse({ ...f.run.state, status: 'cancelled', previousStatus: 'paused' })
    if (cancelled.status !== 'cancelled') throw Error('Expected cancellation')
    f.run.state = cancelled
    f.evidence.events = [...f.evidence.events, { kind: 'cancellation-requested', data: f.run.cancellation }, { kind: 'run-cancelled', data: {
      requestId: f.run.cancellation.id, previousStatus: 'paused', next: cancelled.next, attemptId: null, checkpointSha256: stoppedCheckpointHash(cancelled) } }]
    ledger().check(f.run, f.evidence)
    expect(() => ledger().check(f.run, { ...f.evidence, events: f.evidence.events.slice(0, -1) })).toThrow('corrupt')
  })

  it('rejects repeated trace spans and broken segment lineage without exporting telemetry', () => {
    const f = fixture(), trace = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 } as NonNullable<LocalRun['traceSegments']>[number]['trace']
    f.run.traceSegments = [{ operation: 'run', at, trace }]
    f.evidence.events = [...f.evidence.events, { kind: 'execution-segment', data: structuredClone(f.run.traceSegments[0]) }]
    ledger().check(f.run, f.evidence)
    expect(() => ledger().check(f.run, { ...f.evidence, events: f.evidence.events.slice(0, 1) })).toThrow('corrupt')
    f.run.traceSegments.push({ operation: 'resume', at, trace, previous: trace })
    f.evidence.events = [...f.evidence.events, { kind: 'execution-segment', data: structuredClone(f.run.traceSegments[1]) }]
    expect(() => ledger().check(f.run, f.evidence)).toThrow('corrupt')
    f.run.traceSegments[1] = { operation: 'resume', at, trace: { ...trace, spanId: 'c'.repeat(16) as typeof trace.spanId } }
    f.evidence.events = [...f.evidence.events.slice(0, -1), { kind: 'execution-segment', data: structuredClone(f.run.traceSegments[1]) }]
    expect(() => ledger().check(f.run, f.evidence)).toThrow('corrupt')
  })

  it.each(['missing', 'duplicate', 'revision', 'project'])('refuses %s creation evidence when reopening an actual SQLite run', async mode => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-run-ledger-')), runtime = await LocalRuntime.open({ dataDirectory })
    const run = await runtime.run(yaml, 'retained input'); await runtime.close()
    const db = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'))
    try {
      if (mode === 'missing') db.prepare("DELETE FROM events WHERE run_id=? AND kind='run-created'").run(run.id)
      else if (mode === 'duplicate') db.prepare("INSERT INTO events(run_id,kind,at,data) SELECT run_id,kind,at,data FROM events WHERE run_id=? AND kind='run-created'").run(run.id)
      else db.prepare("UPDATE events SET data=? WHERE run_id=? AND kind='run-created'").run(JSON.stringify(mode === 'revision'
        ? { revision: '0'.repeat(64) } : { revision: run.revision, project: { id: randomUUID(), generation: 1 } }), run.id)
    } finally { db.close() }
    await expect(LocalRuntime.open({ dataDirectory })).rejects.toMatchObject({ code: 'corrupt' })
  })
})
