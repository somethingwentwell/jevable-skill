import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { PostgresRunStore } from '../src/runtime/postgres-store.ts'
import { PostgresProjectStore } from '../src/projects/postgres-store.ts'
import { ProjectLedger } from '../src/projects/ledger.ts'
import { compileLocalRun, initialCheckpoint } from '../src/runtime/run-evaluator.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { withDomainWrite } from '../src/storage/domain-owner.ts'
import type { PostgresJournal } from '../src/storage/postgres.ts'
import type { LocalRun } from '../src/runtime/run-types.ts'

const graph = compileLocalRun(await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8'), DEFAULT_COMPILER_LIMITS)
const at = '2026-01-01T00:00:00.000Z'
function fixture(count = 1) {
  const signal = new AbortController(), ids = Array.from({ length: count }, () => randomUUID()).sort()
  const runs = new Map<string, LocalRun>(ids.map(id => { const record: LocalRun = { schemaVersion: 1, id, yaml: graph.source.yaml,
    revision: graph.source.revision, input: 'PRIVATE_INPUT', createdAt: at, updatedAt: at, startedPaused: true,
    state: initialCheckpoint(graph), loopDeadlines: {} }; return [id, record] }))
  const pageCalls: (string | undefined)[] = [], reads: string[] = []
  const journal = {
    signal: signal.signal,
    page: async (collection: string, after: string | undefined, limit: number) => {
      expect(collection).toBe('runs'); expect(limit).toBe(100); pageCalls.push(after)
      const matches = ids.filter(id => !after || id > after), page = matches.slice(0, limit)
      return { records: page.map(key => ({ key })), nextCursor: matches.length > limit ? page.at(-1) : null }
    },
    get: async (collection: string, id: string) => {
      expect(collection).toBe('runs'); reads.push(id)
      return { key: id, version: '1', value: { format: 'jevable.pg-run/v1', record: runs.get(id) } }
    },
    events: async (after: string) => ({ cursor: '1', events: after === '0' ? [{ sequence: '1', kind: 'run-created',
      data: { format: 'jevable.pg-run-event/v1', version: '1', at, data: { revision: graph.source.revision, startedPaused: true } } }] : [] }),
  } as unknown as PostgresJournal
  return { journal, signal, ids, runs, pageCalls, reads, store: new PostgresRunStore(journal) }
}

// This is domain ownership/checkpoint qualification with a journal double, NOT real PostgreSQL SQL/lock testing.
describe('PostgreSQL activity domain boundary', () => {
  it('checks every retained run across all source pages and never dispatches or truncates', async () => {
    const f = fixture(102), report = await f.store.activity(async () => [])
    expect(report).toMatchObject({ storage: 'postgres', runs: { total: 102, byStatus: { paused: 102 },
      firstRetainedRun: { id: f.ids[0], status: 'paused' } } })
    expect(f.pageCalls).toEqual([undefined, f.ids[99]])
    expect(f.reads).toEqual(f.ids); expect(JSON.stringify(report)).not.toContain('PRIVATE_INPUT')
  })
  it('holds the shared domain gate while projects and every run page are read, then releases it', async () => {
    const f = fixture(), phases: string[] = []
    let entered!: () => void, finish!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { finish = resolve })
    const pending = f.store.activity(async () => { phases.push('projects'); entered(); await held; return [] })
    await started
    const mutation = withDomainWrite(f.journal, async () => { phases.push('mutation') })
    await Promise.resolve(); expect(phases).toEqual(['projects']); expect(f.pageCalls).toEqual([])
    finish(); expect((await pending).runs.total).toBe(1); await mutation
    expect(phases).toEqual(['projects', 'mutation'])
  })
  it('uses replayed project ledgers under the caller gate and does not nest ownership gates', async () => {
    const f = fixture(), ledger = new ProjectLedger(DEFAULT_COMPILER_LIMITS.source, 4_000_000)
    const created = ledger.apply({ operation: 'create', title: 'PRIVATE_TITLE', yaml: graph.source.yaml, actor: 'PRIVATE_ACTOR' })
    const records = async (kind: string, limit: number) => {
      expect(kind).toBe('projects'); expect(limit).toBe(1000)
      return [{ key: created.project.id, version: '1', value: { format: 'jevable.pg-project/v1', generation: 1, record: created.record } }]
    }
    Object.assign(f.journal, { records })
    const projects = new PostgresProjectStore(f.journal, DEFAULT_COMPILER_LIMITS.source)
    expect((await f.store.activity(() => projects.activity())).projects).toEqual({ total: 1, active: 1, archived: 0,
      origins: { authored: 1, duplicated: 0, projectBundle: 0, vendor: 0 } })
    created.record.changes[0]!.actor = ''
    await expect(f.store.activity(() => projects.activity())).rejects.toHaveProperty('code', 'corrupt')
    expect(await withDomainWrite(f.journal, async () => 'released')).toBe('released')
  })
  it('refuses corrupt non-first run history and duplicate/repeated page identities instead of returning partial totals', async () => {
    const f = fixture(2); f.runs.get(f.ids[1]!)!.input = 42
    await expect(f.store.activity(async () => [])).rejects.toHaveProperty('code', 'corrupt')
    const duplicate = fixture()
    duplicate.journal.page = async () => ({ records: [{ key: duplicate.ids[0]! }, { key: duplicate.ids[0]! }], nextCursor: null }) as never
    await expect(duplicate.store.activity(async () => [])).rejects.toHaveProperty('code', 'corrupt')
  })
  it('refuses owner loss both before admission and during an otherwise empty observation', async () => {
    const f = fixture(); f.signal.abort(new Error('owner lost'))
    await expect(f.store.activity(async () => [])).rejects.toThrow('owner lost'); expect(f.pageCalls).toEqual([])
    const mid = fixture(0)
    await expect(mid.store.activity(async () => { mid.signal.abort(new Error('lost during read')); return [] })).rejects.toThrow('lost during read')
  })
  it('enforces the owner run limit without silently counting a prefix', async () => {
    const f = fixture(2), bounded = new PostgresRunStore(f.journal, DEFAULT_COMPILER_LIMITS, 4_000_000, 1)
    await expect(bounded.activity(async () => [])).rejects.toHaveProperty('code', 'limit')
  })
})
