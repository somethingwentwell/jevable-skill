import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { PostgresJournal, JournalError } from '../src/storage/postgres.ts'
import type { JournalTransactionObserver } from '../src/storage/transaction-observation.ts'

// SQL-client double executing the actual journal queue, not real PostgreSQL qualification.
function fixture() {
  const client = new EventEmitter() as EventEmitter & { query: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
  const journal = new (PostgresJournal as any)(client, { namespace: 'PRIVATE_NAMESPACE' }) as PostgresJournal
  Object.assign(journal, { state: 'open', epoch: '1' })
  client.query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT owner_id') ? [{ owner_id: journal.ownerId, epoch: '1' }] : [] }))
  client.end = vi.fn(async () => {})
  const enqueue = <T>(work: () => Promise<T>, kind: 'read' | 'write' = 'read'): Promise<T> => (journal as any).enqueue(work, kind)
  const statements = () => client.query.mock.calls.map(([sql]) => sql)
  return { journal, client, enqueue, statements }
}
function held() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
function observe(journal: PostgresJournal) {
  const end = vi.fn(), begin = vi.fn(() => ({ end }))
  journal.setTransactionObserver(begin)
  return { begin, end }
}

describe('standalone journal transaction observation', () => {
  it('is off by default, does not reconstruct history, and disabling performs no SQL', async () => {
    const f = fixture(), value = { private: 'PRIVATE_PAYLOAD' }
    expect(await f.enqueue(async () => value)).toBe(value)
    expect(f.statements()).toEqual(['BEGIN', 'SELECT owner_id,epoch FROM jevable_journal.meta WHERE namespace=$1 FOR UPDATE', 'COMMIT'])
    const hook = observe(f.journal); expect(hook.begin).not.toHaveBeenCalled()
    f.journal.setTransactionObserver(undefined); expect(await f.enqueue(async () => value)).toBe(value)
    expect(hook.begin).not.toHaveBeenCalled(); expect(f.client.query).toHaveBeenCalledTimes(6)
  })
  it.each(['read', 'write'] as const)('passes only %s and acknowledged; preserves return identity and SQL', async kind => {
    const f = fixture(), hook = observe(f.journal), value = { secret: 'PRIVATE_PAYLOAD' }
    expect(await f.enqueue(async () => value, kind)).toBe(value)
    expect(hook.begin.mock.calls).toEqual([[kind]])
    expect(hook.end.mock.calls).toEqual([['acknowledged']])
    expect(f.client.query).toHaveBeenCalledTimes(3)
    expect(f.journal.queueOccupancy()).toEqual({ waiting: 0, active: 0 })
    expect(JSON.stringify([hook.begin.mock.calls, hook.end.mock.calls])).not.toContain('PRIVATE_')
  })
  it('preserves a domain error object and rollback, never exposes it to the hook', async () => {
    const f = fixture(), hook = observe(f.journal), error = new JournalError('conflict')
    await expect(f.enqueue(async () => { throw error }, 'write')).rejects.toBe(error)
    expect(f.statements().at(-1)).toBe('ROLLBACK'); expect(f.journal.status().state).toBe('open')
    expect(hook.end.mock.calls).toEqual([['failed-before-commit']])
  })
  it('sanitizes a raw work error and loses ownership without exposing private diagnostics', async () => {
    const f = fixture(), hook = observe(f.journal)
    await expect(f.enqueue(async () => { throw Error('PRIVATE_ERROR') })).rejects.toMatchObject({ code: 'unavailable' })
    expect(f.statements().at(-1)).toBe('ROLLBACK'); expect(f.client.end).toHaveBeenCalledTimes(1)
    expect(f.journal.status().state).toBe('lost'); expect(hook.end.mock.calls).toEqual([['failed-before-commit']])
  })
  it.each(['commit-refusal', 'loss-after-ack'] as const)('retains commit-uncertain for %s; never claims rollback', async failure => {
    const f = fixture(), hook = observe(f.journal), query = f.client.query.getMockImplementation()!
    f.client.query.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') {
        if (failure === 'commit-refusal') throw Error('PRIVATE_COMMIT_ERROR')
        f.client.emit('error', Error('PRIVATE_LOSS'))
      }
      return Reflect.apply(query, undefined, [sql])
    })
    await expect(f.enqueue(async () => 'value', 'write')).rejects.toMatchObject({ code: 'commit-uncertain' })
    expect(f.statements()).not.toContain('ROLLBACK'); expect(hook.end.mock.calls).toEqual([['commit-uncertain']])
  })
  it.each(['begin-throw', 'end-throw', 'end-getter', 'bad-end', 'begin-rejection', 'end-rejection', 'cross-realm-begin', 'cross-realm-end'])(
    'isolates invalid %s callbacks without changing the transaction', async failure => {
      const f = fixture(), value = { private: 'PRIVATE_PAYLOAD' }
      const reject = () => Promise.reject(Error('PRIVATE_OBSERVER_ERROR'))
      const foreignReject = () => runInNewContext('Promise.reject(new Error("PRIVATE_FOREIGN_ERROR"))')
      const observer = (() => {
        if (failure === 'begin-throw') throw Error('PRIVATE_BEGIN')
        if (failure === 'begin-rejection') return reject()
        if (failure === 'cross-realm-begin') return foreignReject()
        if (failure === 'end-getter') return Object.defineProperty({}, 'end', { get() { throw Error('PRIVATE_GETTER') } })
        if (failure === 'bad-end') return { end: 7 }
        return { end() {
          if (failure === 'end-throw') throw Error('PRIVATE_END')
          if (failure === 'end-rejection') return reject()
          if (failure === 'cross-realm-end') return foreignReject()
        } }
      }) as JournalTransactionObserver
      f.journal.setTransactionObserver(observer)
      expect(await f.enqueue(async () => value)).toBe(value)
      await new Promise(resolve => setImmediate(resolve)) // Native rejected hooks must not produce unhandled rejections.
      expect(f.client.query).toHaveBeenCalledTimes(3); expect(f.client.end).not.toHaveBeenCalled()
    })
  it('never assimilates arbitrary thenables from begin or end', async () => {
    const f = fixture(), then = vi.fn(() => { throw Error('PRIVATE_THENABLE') })
    const returned = Object.defineProperty({}, 'then', { get: then })
    const end = vi.fn(() => returned)
    f.journal.setTransactionObserver(() => Object.defineProperty({ end }, 'then', { get: then }))
    expect(await f.enqueue(async () => 'ok')).toBe('ok'); expect(end).toHaveBeenCalledOnce(); expect(then).not.toHaveBeenCalled()
  })
  it('does not let throwing hooks replace a domain error', async () => {
    const f = fixture(), error = new JournalError('limit')
    f.journal.setTransactionObserver(() => ({ end() { throw Error('PRIVATE_HOOK') } }))
    await expect(f.enqueue(async () => { throw error })).rejects.toBe(error)
    expect(f.statements().at(-1)).toBe('ROLLBACK')
  })
  it('starts at dequeue, not admission; refuses observer changes while work is active or waiting', async () => {
    const f = fixture(), hook = observe(f.journal), gate = held(), entered = held()
    const first = f.enqueue(async () => { entered.release(); await gate.promise; return 1 })
    const second = f.enqueue(async () => 2, 'write')
    expect(hook.begin).not.toHaveBeenCalled(); expect(f.journal.queueOccupancy()).toEqual({ waiting: 2, active: 0 })
    expect(() => f.journal.setTransactionObserver(undefined)).toThrow('busy')
    await entered.promise; expect(hook.begin.mock.calls).toEqual([['read']]); expect(hook.end).not.toHaveBeenCalled()
    expect(f.journal.queueOccupancy()).toEqual({ waiting: 1, active: 1 })
    expect(() => f.journal.setTransactionObserver(undefined)).toThrow('busy')
    gate.release(); expect(await Promise.all([first, second])).toEqual([1, 2])
    expect(hook.begin.mock.calls).toEqual([['read'], ['write']]); expect(hook.end).toHaveBeenCalledTimes(2)
    expect(() => f.journal.setTransactionObserver(undefined)).not.toThrow()
  })
  it('does not observe or query queued work that loses ownership before BEGIN', async () => {
    const f = fixture(), hook = observe(f.journal), gate = held(), entered = held(), work = vi.fn(async () => 2)
    const first = f.enqueue(async () => { entered.release(); await gate.promise; return 1 })
    const second = f.enqueue(work).catch(error => error)
    await entered.promise; f.client.emit('error', Error('PRIVATE_LOSS')); gate.release()
    await expect(first).rejects.toMatchObject({ code: 'commit-uncertain' })
    expect(await second).toMatchObject({ code: 'ownership-lost' }); expect(work).not.toHaveBeenCalled()
    expect(hook.begin).toHaveBeenCalledOnce(); expect(hook.end.mock.calls).toEqual([['commit-uncertain']])
    expect(f.client.query).toHaveBeenCalledTimes(3)
  })
  it.each(['closed', 'closing', 'lost'] as const)('refuses configuration and new admission when %s', async state => {
    const f = fixture(), hook = observe(f.journal); Object.assign(f.journal, { state })
    expect(() => f.journal.setTransactionObserver(undefined)).toThrow(state === 'lost' ? 'ownership-lost' : 'closed')
    await expect(f.enqueue(async () => 1)).rejects.toMatchObject({ code: state === 'lost' ? 'ownership-lost' : 'closed' })
    expect(f.client.query).not.toHaveBeenCalled(); expect(hook.begin).not.toHaveBeenCalled()
  })
  it('rejects invalid configuration without SQL', () => {
    const f = fixture(); expect(() => f.journal.setTransactionObserver(7 as never)).toThrow('invalid-command')
    expect(f.client.query).not.toHaveBeenCalled()
  })
  it('suppression preserves synchronous return/error and exact asynchronous return identity', async () => {
    const f = fixture(), value = {}, error = Error('PRIVATE_WORK')
    expect(f.journal.withTransactionObservationsSuppressed(() => value)).toBe(value)
    expect(() => f.journal.withTransactionObservationsSuppressed(() => { throw error })).toThrow(error)
    const promise = Promise.resolve(value)
    expect(f.journal.withTransactionObservationsSuppressed(() => promise)).toBe(promise)
    const hook = observe(f.journal); await f.enqueue(async () => value); expect(hook.begin).toHaveBeenCalledOnce()
  })
  it('captures suppression at admission even when dequeued after the scope exits; counts real SQL', async () => {
    const f = fixture(), hook = observe(f.journal), gate = held(), entered = held()
    f.journal.enableTransactionMetrics()
    const first = f.enqueue(async () => { entered.release(); await gate.promise })
    await entered.promise
    const suppressed = f.journal.withTransactionObservationsSuppressed(() => f.enqueue(async () => 2, 'write'))
    const normal = f.enqueue(async () => 3, 'write')
    gate.release(); expect(await Promise.all([first, suppressed, normal])).toEqual([undefined, 2, 3])
    expect(hook.begin.mock.calls).toEqual([['read'], ['write']]); expect(hook.end).toHaveBeenCalledTimes(2)
    expect(f.client.query).toHaveBeenCalledTimes(9)
    const stats = f.journal.transactionMetrics(); expect(stats.available).toBe(true)
    if (!stats.available) throw Error('unavailable')
    expect(stats.values.reduce((sum, value) => sum + value.transactions, 0)).toBe(3)
  })
  it('suppression spans awaited work, is request-local, and never suppresses a different journal', async () => {
    const f = fixture(), other = fixture(), hook = observe(f.journal), otherHook = observe(other.journal), gate = held()
    const suppressed = f.journal.withTransactionObservationsSuppressed(async () => { await gate.promise; return f.enqueue(async () => 1) })
    const normal = f.enqueue(async () => 2)
    await f.journal.withTransactionObservationsSuppressed(() => other.enqueue(async () => 3))
    gate.release(); expect(await Promise.all([suppressed, normal])).toEqual([1, 2])
    expect(hook.begin).toHaveBeenCalledOnce(); expect(otherHook.begin).toHaveBeenCalledOnce()
    expect(f.client.query).toHaveBeenCalledTimes(6); expect(other.client.query).toHaveBeenCalledTimes(3)
  })
})
