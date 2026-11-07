import { describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createPostgresRunEvidence } from '../src/runtime/postgres-evidence.ts'
import type { PostgresRunEvent } from '../src/runtime/postgres-reader.ts'
import { compileLocalRun, initialCheckpoint } from '../src/runtime/run-evaluator.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import type { LocalRun } from '../src/runtime/run-types.ts'

const graph = compileLocalRun(await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8'), DEFAULT_COMPILER_LIMITS)
const at = '2026-09-29T00:00:00.000Z', run: LocalRun = { schemaVersion: 1, id: randomUUID(), yaml: graph.source.yaml,
  revision: graph.source.revision, input: 'PRIVATE_INPUT', createdAt: at, updatedAt: at, startedPaused: true,
  state: initialCheckpoint(graph), loopDeadlines: {} }
const first: PostgresRunEvent = { sequence: '9007199254740993', version: '1', kind: 'run-created', at,
  data: { revision: run.revision, startedPaused: true } }
const project = (events: PostgresRunEvent[] = [first], version = String(events.length), privateData = false) => createPostgresRunEvidence(run, events, version, privateData)

describe('PostgreSQL v2 evidence identity and projection', () => {
  it('preserves large decimal sequence identities, exact private journal and stable checksums', () => {
    const result = project()
    expect(result.schemaVersion).toBe(2); expect(result.snapshot.schemaVersion).toBe(2)
    expect(result.snapshot.storage).toEqual({ kind: 'postgres', recordVersion: '1' })
    expect(result.snapshot.boundary).toMatchObject({ sequenceEncoding: 'decimal-int64', firstSequence: first.sequence, lastSequence: first.sequence })
    expect(result.snapshot.journal[0]).toMatchObject({ sequence: first.sequence, version: '1' })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_INPUT'); expect(result.snapshot).not.toHaveProperty('private')
    expect(result.checksum.value).toBe(createHash('sha256').update(JSON.stringify(result.snapshot)).digest('hex'))
    expect(project()).toEqual(result)
    expect(project([first], '1', true).snapshot.private).toEqual({ run, journal: [first] })
  })
  it('compares decimal identities numerically and preserves permitted sequence gaps', () => {
    const events = [{ ...first, sequence: '9' }, { ...first, sequence: '101', version: '2' }]
    expect(project(events).snapshot.journal.map(e => e.sequence)).toEqual(['9', '101'])
    expect(() => project([{ ...first, sequence: '101' }, { ...first, sequence: '9', version: '2' }])).toThrow('corrupt')
  })
  it.each(['0', '-1', '01', '1.0', '1e3', '9223372036854775807', '9007199254740993 ', 'NaN'])('refuses malformed or unsupported sequence %s', value => {
    expect(() => project([{ ...first, sequence: value }])).toThrow('corrupt')
  })
  it('refuses duplicate/order/version/timestamp corruption and invalid privacy flags', () => {
    expect(() => project([])).toThrow('corrupt')
    expect(() => project([first, { ...first, version: '2' }])).toThrow('corrupt')
    expect(() => project([{ ...first, version: '2' }])).toThrow('corrupt')
    expect(() => project([first], '2')).toThrow('corrupt')
    expect(() => project([{ ...first, at: '2026-09-28T00:00:00.000Z' }])).toThrow('corrupt')
    expect(() => project([first], '1', 'true' as unknown as boolean)).toThrow('invalid-command')
  })
  it('enforces event and private artifact budgets without truncating', () => {
    expect(() => project(Array(50001).fill(first))).toThrow('limit')
    expect(() => createPostgresRunEvidence({ ...run, input: 'x'.repeat(16_000_000) }, [first], '1', true)).toThrow('limit')
  })
})
