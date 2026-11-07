import { afterEach, describe, expect, it, vi } from 'vitest'
import Client from 'pg/lib/client.js'
import { PostgresJournal, JournalError } from '../src/storage/postgres.ts'
import { TransactionStatistics } from '../src/storage/transaction-statistics.ts'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
const database = { host: '127.0.0.1', port: 5432, database: 'fixture', user: 'fixture', password: 'PRIVATE_PASSWORD',
  namespace: 'fixture', initialize: false, tls: { mode: 'loopback-test' as const } }

// Exact journal control flow against a SQL client double. Never calls a real connection, schema or provider.
async function fixture(options: { hold?: 'read' | 'commit'; readFailure?: Error; commitFailure?: Error; beginFailure?: Error } = {}) {
  const entered = deferred(), held = deferred(), statements: string[] = []
  let ownerId = '', opened = false, reads = 0, commits = 0
  vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined as never)
  const end = vi.spyOn(Client.prototype, 'end').mockResolvedValue(undefined as never)
  vi.spyOn(Client.prototype, 'query').mockImplementation((async (text: string, values?: unknown[]) => {
    statements.push(text); let rows: unknown[] = []
    if (opened && text === 'BEGIN' && options.beginFailure) throw options.beginFailure
    if (text === 'SHOW server_version_num') rows = [{ server_version_num: '170011' }]
    if (text.includes('pg_try_advisory_lock')) rows = [{ held: true }]
    if (text.includes('to_regclass')) rows = [{ present: 'jevable_journal.meta' }]
    if (text.startsWith('SELECT format,version,epoch')) rows = [{ format: 'jevable.pg-journal/v1', version: 1, epoch: '0' }]
    if (text.startsWith('UPDATE jevable_journal.meta')) { ownerId = String(values![1]); rows = [{ epoch: '1' }] }
    if (text.startsWith('SELECT owner_id,epoch')) rows = [{ owner_id: ownerId, epoch: '1' }]
    if (text.startsWith('SELECT\n        (SELECT count')) rows = [{ records: 0, events: 0, batches: 0 }]
    if (text.startsWith('INSERT INTO jevable_journal.events')) rows = [{ sequence: '1' }]
    if (text === 'SELECT clock_timestamp()::text AS at') rows = [{ at: '2026-10-03T00:00:00Z' }]
    if (opened && text.startsWith('SELECT version,deleted')) {
      if (++reads === 1) {
        if (options.hold === 'read') { entered.resolve(); await held.promise }
        if (options.readFailure) throw options.readFailure
      }
    }
    if (opened && text === 'COMMIT' && ++commits === 1) {
      if (options.hold === 'commit') { entered.resolve(); await held.promise }
      if (options.commitFailure) throw options.commitFailure
    }
    return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }
  }) as never)
  const journal = await PostgresJournal.open(database); opened = true; statements.length = 0
  cleanup.push(async () => { held.resolve(); await journal.close() })
  return { journal, entered, held, statements, end }
}

describe('PostgreSQL transaction queue occupancy', () => {
  it.each(['read', 'commit'] as const)('tracks actual transaction occupancy through held %s without snapshot SQL', async hold => {
    const f = await fixture({ hold }), first = f.journal.get('runs', 'PRIVATE_FIRST')
    await f.entered.promise
    const second = f.journal.get('runs', 'PRIVATE_SECOND'), before = [...f.statements]
    expect(f.journal.queueOccupancy()).toEqual({ waiting: 1, active: 1 })
    const snapshot = f.journal.queueOccupancy(); snapshot.waiting = 100
    expect(f.journal.queueOccupancy()).toEqual({ waiting: 1, active: 1 }); expect(f.statements).toEqual(before)
    f.held.resolve(); expect(await first).toBeUndefined(); expect(await second).toBeUndefined()
    expect(f.journal.queueOccupancy()).toEqual({ waiting: 0, active: 0 })
    expect(f.statements.filter(s => s === 'BEGIN')).toHaveLength(2)
    expect(f.statements.filter(s => s === 'COMMIT')).toHaveLength(2)
    expect(f.journal.status().state).toBe('open')
  })
  it('releases a rolled-back refusal before allowing queued work, without losing ownership', async () => {
    const f = await fixture({ hold: 'read', readFailure: new JournalError('conflict') })
    const first = f.journal.get('runs', 'first'), rejected = expect(first).rejects.toHaveProperty('code', 'conflict')
    await f.entered.promise; const second = f.journal.get('runs', 'second')
    expect(f.journal.queueOccupancy()).toEqual({ waiting: 1, active: 1 })
    f.held.resolve(); await rejected; expect(await second).toBeUndefined()
    expect(f.journal.queueOccupancy()).toEqual({ waiting: 0, active: 0 })
    expect(f.statements.filter(s => s === 'ROLLBACK')).toHaveLength(1); expect(f.journal.signal.aborted).toBe(false)
  })
  it('preserves commit uncertainty and settles queued owner-loss refusals without another transaction', async () => {
    const f = await fixture({ hold: 'commit', commitFailure: Error('PRIVATE_COMMIT_ERROR') })
    const first = f.journal.get('runs', 'first'), rejected = expect(first).rejects.toHaveProperty('code', 'commit-uncertain')
    await f.entered.promise
    const second = f.journal.get('runs', 'second'), refused = expect(second).rejects.toHaveProperty('code', 'ownership-lost')
    expect(f.journal.queueOccupancy()).toEqual({ waiting: 1, active: 1 })
    f.held.resolve(); await rejected; await refused
    expect(f.journal.queueOccupancy()).toEqual({ waiting: 0, active: 0 }); expect(f.journal.signal.aborted).toBe(true)
    expect(f.statements.filter(s => s === 'BEGIN')).toHaveLength(1); expect(f.statements).not.toContain('ROLLBACK')
  })
  it('does not admit closed or invalid operations, while draining already admitted transactions', async () => {
    const f = await fixture({ hold: 'read' }), first = f.journal.get('runs', 'first')
    await f.entered.promise; const second = f.journal.get('runs', 'second'), closing = f.journal.close()
    expect(f.journal.status().state).toBe('closing'); expect(f.journal.queueOccupancy()).toEqual({ waiting: 1, active: 1 })
    await expect(f.journal.get('runs', 'refused')).rejects.toHaveProperty('code', 'closed')
    expect(() => f.journal.get('runs', '')).toThrow('invalid-command')
    expect(f.journal.queueOccupancy()).toEqual({ waiting: 1, active: 1 })
    f.held.resolve(); await first; await second; await closing
    expect(f.journal.queueOccupancy()).toEqual({ waiting: 0, active: 0 }); expect(f.journal.status().state).toBe('closed')
    expect(f.end).toHaveBeenCalledTimes(1)
  })
  it('counts no rejected pre-admission work and retains only numeric process-local metadata', async () => {
    const f = await fixture()
    expect(() => f.journal.get('unsupported' as never, 'PRIVATE_KEY')).toThrow('invalid-command')
    expect(f.journal.queueOccupancy()).toEqual({ waiting: 0, active: 0 })
    await f.journal.get('runs', 'PRIVATE_KEY')
    expect(JSON.stringify(f.journal.queueOccupancy())).not.toContain('PRIVATE_')
    expect(Object.keys(f.journal.queueOccupancy()).sort()).toEqual(['active', 'waiting'])
  })
})

describe('PostgreSQL memory-only transaction observations', () => {
  const total = (journal: PostgresJournal, kind: string, outcome: string) => {
    const snapshot = journal.transactionMetrics()
    if (!snapshot.available) throw Error('Unexpected unavailable observations')
    return snapshot.values.find(value => value.kind === kind && value.outcome === outcome)!
  }
  it('is off by default and enabling does no SQL or replay of earlier reads', async () => {
    const f = await fixture(); await f.journal.get('runs', 'PRIVATE_KEY')
    expect(f.journal.transactionMetrics()).toEqual({ available: false })
    const before = [...f.statements]; f.journal.enableTransactionMetrics(); f.journal.enableTransactionMetrics()
    expect(f.statements).toEqual(before)
    expect(total(f.journal, 'read', 'acknowledged')).toMatchObject({ transactions: 0, seconds: 0 })
    await f.journal.get('runs', 'PRIVATE_KEY')
    expect(total(f.journal, 'read', 'acknowledged').transactions).toBe(1)
    const snapshot = f.journal.transactionMetrics(); expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_')
    if (snapshot.available) snapshot.values[0]!.transactions = 999
    expect(total(f.journal, 'read', 'acknowledged').transactions).toBe(1)
  })
  it('publishes only ended active transactions, not queued/in-flight work', async () => {
    const f = await fixture({ hold: 'commit' }); f.journal.enableTransactionMetrics()
    const first = f.journal.get('runs', 'PRIVATE_FIRST'); await f.entered.promise
    const second = f.journal.get('runs', 'PRIVATE_SECOND'), before = [...f.statements]
    expect(total(f.journal, 'read', 'acknowledged').transactions).toBe(0)
    expect(f.statements).toEqual(before); f.held.resolve(); await first; await second
    expect(total(f.journal, 'read', 'acknowledged').transactions).toBe(2)
    expect(total(f.journal, 'read', 'acknowledged').seconds).toBeGreaterThanOrEqual(0)
  })
  it('measures active SQL wait but excludes a later transaction local-queue wait', async () => {
    const f = await fixture({ hold: 'commit' }); f.journal.enableTransactionMetrics()
    let clock = 1000; vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const first = f.journal.get('runs', 'first'); await f.entered.promise
    clock = 2000; const second = f.journal.get('runs', 'second')
    clock = 9000; f.held.resolve(); await first; await second
    expect(total(f.journal, 'read', 'acknowledged')).toMatchObject({ transactions: 2, seconds: 8 })
  })
  it('keeps rollback refusal separate from acknowledged commit and retains owner semantics', async () => {
    const f = await fixture({ readFailure: new JournalError('conflict') }); f.journal.enableTransactionMetrics()
    await expect(f.journal.get('runs', 'PRIVATE_KEY')).rejects.toHaveProperty('code', 'conflict')
    expect(total(f.journal, 'read', 'failed-before-commit').transactions).toBe(1)
    expect(total(f.journal, 'read', 'acknowledged').transactions).toBe(0)
    expect(f.journal.signal.aborted).toBe(false); await f.journal.get('runs', 'again')
    expect(total(f.journal, 'read', 'acknowledged').transactions).toBe(1)
  })
  it('counts an entered path with failed BEGIN, without asserting begun/committed work', async () => {
    const f = await fixture({ beginFailure: Error('PRIVATE_BEGIN_ERROR') }); f.journal.enableTransactionMetrics()
    await expect(f.journal.get('runs', 'PRIVATE_KEY')).rejects.toHaveProperty('code', 'unavailable')
    expect(total(f.journal, 'read', 'failed-before-commit').transactions).toBe(1)
    expect(total(f.journal, 'read', 'acknowledged').transactions).toBe(0)
    expect(f.statements).not.toContain('COMMIT'); expect(f.journal.signal.aborted).toBe(true)
  })
  it('retains commit uncertainty, never counting queued owner-loss refusal as a transaction', async () => {
    const f = await fixture({ hold: 'commit', commitFailure: Error('PRIVATE_FAILURE') }); f.journal.enableTransactionMetrics()
    const first = f.journal.get('runs', 'first'), a = expect(first).rejects.toHaveProperty('code', 'commit-uncertain')
    await f.entered.promise; const second = f.journal.get('runs', 'second'), b = expect(second).rejects.toHaveProperty('code', 'ownership-lost')
    f.held.resolve(); await a; await b
    expect(total(f.journal, 'read', 'commit-uncertain').transactions).toBe(1)
    expect(total(f.journal, 'read', 'failed-before-commit').transactions).toBe(0)
    expect(total(f.journal, 'read', 'acknowledged').transactions).toBe(0)
    expect(f.statements.filter(s => s === 'BEGIN')).toHaveLength(1)
    expect(() => f.journal.enableTransactionMetrics()).toThrow('ownership-lost')
  })
  it('counts an atomic batch as write without recording its changes or payloads', async () => {
    const f = await fixture(); f.journal.enableTransactionMetrics()
    const receipt = await f.journal.commit({ id: randomUUID(), changes: [{ operation: 'put', collection: 'runs', key: 'PRIVATE_KEY', expectedVersion: '0', value: 'PRIVATE_VALUE' }],
      events: [{ collection: 'runs', key: 'PRIVATE_KEY', kind: 'created', data: 'PRIVATE_EVENT' }] })
    expect(receipt.changes[0]!.version).toBe('1')
    expect(total(f.journal, 'write', 'acknowledged').transactions).toBe(1)
    expect(total(f.journal, 'read', 'acknowledged').transactions).toBe(0)
    expect(JSON.stringify(f.journal.transactionMetrics())).not.toContain('PRIVATE_')
  })
  it('contains a diagnostic recording failure without altering commit or queue drainage', async () => {
    const f = await fixture(); f.journal.enableTransactionMetrics()
    vi.spyOn(TransactionStatistics.prototype, 'record').mockImplementation(() => { throw Error('PRIVATE_OBSERVER_ERROR') })
    expect(await f.journal.get('runs', 'PRIVATE_KEY')).toBeUndefined()
    expect(f.journal.transactionMetrics()).toEqual({ available: false })
    expect(f.journal.signal.aborted).toBe(false); expect(f.journal.queueOccupancy()).toEqual({ waiting: 0, active: 0 })
  })
  it('omits pre-admission invalid/closed calls while retaining ended totals after close', async () => {
    const f = await fixture(); f.journal.enableTransactionMetrics()
    expect(() => f.journal.get('runs', '')).toThrow('invalid-command')
    await f.journal.get('runs', 'PRIVATE_KEY'); const before = f.journal.transactionMetrics()
    await f.journal.close(); await expect(f.journal.get('runs', 'refused')).rejects.toHaveProperty('code', 'closed')
    expect(f.journal.transactionMetrics()).toEqual(before)
    expect(() => f.journal.enableTransactionMetrics()).toThrow('closed')
  })
})
