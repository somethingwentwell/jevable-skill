import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { SQLiteStatementStatistics, type SQLiteMethod } from './sqlite-statistics.ts'

/** Wrap only this owner's connection; never patch native prototypes or install ambient instrumentation. */
export function observeSQLiteDatabase(database: DatabaseSync, statistics: SQLiteStatementStatistics,
  clock: () => number = () => performance.now()): DatabaseSync {
  const invalidate = () => { try { statistics.invalidate() } catch { /* Diagnostics cannot affect the native call. */ } }
  function observe<T>(method: SQLiteMethod, work: () => T): T {
    let started: number | undefined, returned = false
    try { started = clock() } catch { invalidate() }
    try { const result = work(); returned = true; return result }
    finally {
      if (started !== undefined) {
        try { statistics.record(method, returned ? 'returned' : 'threw', (clock() - started) / 1000) }
        catch { invalidate() }
      }
    }
  }
  function iterator<T extends Iterator<unknown>>(native: T): T {
    const methods = new Map<PropertyKey, unknown>()
    let proxy: T
    proxy = new Proxy(native, { get(target, key) {
      if (key === Symbol.iterator) return () => proxy
      const value = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      if (!methods.has(key)) methods.set(key, key === 'next' || key === 'return'
        ? (...args: unknown[]) => observe(key === 'next' ? 'iterator.next' : 'iterator.return', () => Reflect.apply(value, target, args))
        : value.bind(target))
      return methods.get(key)
    } })
    return proxy
  }
  function statement(native: StatementSync): StatementSync {
    const methods = new Map<PropertyKey, unknown>()
    return new Proxy(native, { get(target, key) {
      const value = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      if (!methods.has(key)) methods.set(key, key === 'iterate'
        ? (...args: unknown[]) => iterator(observe('iterate', () => Reflect.apply(value, target, args) as Iterator<unknown>))
        : key === 'all' || key === 'get' || key === 'run'
          ? (...args: unknown[]) => observe(key, () => Reflect.apply(value, target, args))
          : value.bind(target))
      return methods.get(key)
    } })
  }
  const methods = new Map<PropertyKey, unknown>()
  return new Proxy(database, { get(target, key) {
    const value = Reflect.get(target, key, target)
    if (typeof value !== 'function') return value
    if (!methods.has(key)) methods.set(key, key === 'prepare'
      ? (...args: unknown[]) => statement(observe('prepare', () => Reflect.apply(value, target, args)))
      : key === 'exec' ? (...args: unknown[]) => observe('exec', () => Reflect.apply(value, target, args))
        : value.bind(target))
    return methods.get(key)
  } })
}
