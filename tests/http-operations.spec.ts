import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LocalRuntime } from '../src/runtime/local.ts'
import { dispatchOperation } from '../src/http/operations.ts'
import { operationCapabilities } from '../src/http/operation-host.ts'
import { auditPage, auditPageSchema } from '../src/http/pagination.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const owners: LocalRuntime[] = []
afterEach(async () => { for (const owner of owners.splice(0)) await owner.close() })
async function fixture() {
  const runtime = await LocalRuntime.open({ dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-operations-')) })
  owners.push(runtime)
  // Force every method across an asynchronous boundary, while exercising actual retained SQLite state.
  const asynchronous = new Proxy(runtime, { get(target, key) {
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? async (...args: unknown[]) => { await Promise.resolve(); return value.apply(target, args) } : value
  } })
  const call = (value: unknown) => dispatchOperation({ storage: 'sqlite', runtime: asynchronous }, value, 'local:operation-owner') as Promise<any>
  return { runtime, call }
}

describe('asynchronous management operation boundary', () => {
  it('awaits metadata, import inspection and cancellation instead of serializing promises', async () => {
    const { runtime, call } = await fixture()
    const project = await call({ operation: 'projects.command', command: { operation: 'create', title: 'Async', yaml: echo } })
    expect(await call({ operation: 'projects.list' })).toEqual({ schemaVersion: 1, projects: runtime.projects() })
    const batch = await call({ operation: 'tests.generate', id: randomUUID(), limit: 1,
      project: { id: project.id, generation: project.generation, revision: project.acceptedRevision } })
    expect((await call({ operation: 'tests.list' })).tests).toEqual(runtime.testCases())
    expect((await call({ operation: 'tests.generations' })).generations).toEqual(runtime.testGenerations())
    expect(batch.snapshot.cases).toHaveLength(1)
    const bundle = await call({ operation: 'projects.export', id: project.id, expectedGeneration: project.generation, revision: project.acceptedRevision })
    expect(await call({ operation: 'projects.import.inspect', json: JSON.stringify(bundle) })).toMatchObject({ status: 'review-required', bundle })
    await call({ operation: 'credentials.set', ref: 'fixture/key', value: 'private-value', expectedGeneration: 0 })
    expect(await call({ operation: 'providers.audit' })).toEqual({ schemaVersion: 1, events: runtime.providerAudit() })
    expect(await call({ operation: 'providers.list' })).toEqual({ schemaVersion: 1, connections: runtime.connections() })
    expect(await call({ operation: 'projects.deletions' })).toEqual({ schemaVersion: 1, deletions: [] })
    const waiting = await call({ operation: 'runs.start', id: randomUUID(), yaml: approval, input: { message: 'Review' } })
    const request = { operation: 'runs.cancel', id: waiting.id, requestId: randomUUID() }
    expect(await call(request)).toMatchObject({ id: waiting.id, status: 'cancelled' })
    expect((await call({ operation: 'runs.list' })).runs).toEqual(runtime.list())
    expect((await call({ operation: 'runs.events', id: waiting.id })).schemaVersion).toBe(1)
  })

  it('preserves legacy lists and explicitly pages immutable IDs without duplicates', async () => {
    const { runtime, call } = await fixture()
    const ids = Array.from({ length: 3 }, () => randomUUID()).sort()
    for (const id of [...ids].reverse()) await runtime.run(echo, 'retained', { id })
    expect(await call({ operation: 'runs.list' })).toEqual({ schemaVersion: 1, runs: runtime.list() })
    let after: string | undefined
    const actual: string[] = []
    do {
      const result = await call({ operation: 'runs.list', page: { limit: 1, ...(after ? { after } : {}) } })
      expect(result.schemaVersion).toBe(2); expect(result.runs).toHaveLength(1)
      actual.push(result.runs[0].id); after = result.nextCursor ?? undefined
    } while (after)
    expect(actual).toEqual(ids)
    expect(await call({ operation: 'runs.list', page: { after: ids.at(-1), limit: 1 } })).toEqual({ schemaVersion: 2, runs: [], nextCursor: null })
    expect((await call({ operation: 'runs.list', page: {} })).runs).toHaveLength(3)
    for (const [operation, field] of [['tests.list', 'tests'], ['tests.generations', 'generations'], ['projects.deletions', 'deletions']]) {
      expect(await call({ operation, page: {} })).toEqual({ schemaVersion: 2, [field!]: [], nextCursor: null })
    }
  })

  it('pages audit sequences without converting the request cursor to a lossy number', async () => {
    const { call } = await fixture()
    for (let generation = 0; generation < 3; generation++) await call({ operation: 'credentials.set', ref: 'fixture/key', value: 'private', expectedGeneration: generation })
    const first = await call({ operation: 'providers.audit', page: { limit: 2 } })
    expect(first).toMatchObject({ schemaVersion: 2, sequenceEncoding: 'safe-integer', cursor: '2' })
    expect(first.events.map((e: { sequence: number }) => e.sequence)).toEqual([1, 2])
    const last = await call({ operation: 'providers.audit', page: { after: first.cursor, limit: 2 } })
    expect(last.events.map((e: { sequence: number }) => e.sequence)).toEqual([3])
    expect(await call({ operation: 'providers.audit', page: { after: last.cursor } })).toMatchObject({ events: [], cursor: '3' })
    expect(await call({ operation: 'providers.audit', page: { after: '9007199254740993' } })).toMatchObject({ events: [], cursor: '9007199254740993' })
    expect(JSON.stringify(first)).not.toContain('private')
  })

  it.each([null, { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: '1' }, { after: 'invalid' }, { offset: 2 }])('rejects invalid record pages %j', async page => {
    const { call } = await fixture()
    await expect(call({ operation: 'runs.list', page })).rejects.toMatchObject({ code: 'invalid-command' })
  })

  it('rejects invalid audit cursors safely and refuses unsafe SQLite sequence values', () => {
    for (const after of ['NaN', '01', '-1', '1.5', '1e3', '1 ', '9223372036854775807', '', 1, null]) {
      expect(auditPageSchema.safeParse({ after }).success).toBe(false)
    }
    expect(auditPageSchema.parse({ after: '9223372036854775806' })).toEqual({ after: '9223372036854775806', limit: 100 })
    expect(() => auditPage([{ sequence: Number.MAX_SAFE_INTEGER + 1 }], undefined, 1)).toThrow()
  })

  it('reports backend-specific evidence formats and the explicit live pagination contract', () => {
    expect(operationCapabilities('sqlite')).toMatchObject({ storage: 'sqlite', runEvidenceSchemaVersion: 1, pagination: { required: false } })
    expect(operationCapabilities('postgres')).toMatchObject({ storage: 'postgres', runEvidenceSchemaVersion: 2,
      journalSequenceEncoding: 'decimal-int64', pagination: { required: true, maxLimit: 200, consistency: 'live-keyset; not-a-snapshot' } })
  })
})
