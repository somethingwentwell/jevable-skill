import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { runServiceProcess } from '../src/http/process.ts'

function fixture() {
  const done = Promise.withResolvers<void>(); let closed = false
  const service = { url: 'http://127.0.0.1:1234', instanceId: randomUUID(), protocol: 'fixture', transport: 'loopback-http',
    listener: { address: '127.0.0.1', port: 1234 }, closed: done.promise,
    close: vi.fn(async () => ({ status: closed ? 'closed' as const : 'draining' as const, activeRequests: closed ? 0 : 1 })) }
  return { service, done, finish() { closed = true; done.resolve() } }
}

describe('CLI service lifetime', () => {
  it.each([false, true])('uses preview readiness only after startup and suppresses it when startup was cancelled: %s', async cancel => {
    const f = fixture(), start = Promise.withResolvers<typeof f.service>(), signals = new EventEmitter(), receipts: any[] = []
    const ready = vi.fn(service => ({ status: 'ready', servesHtml: true, url: service.url, storage: 'postgres', execution: 'not-run' }))
    const task = runServiceProcess(() => start.promise, 'postgres', value => receipts.push(value), 1, signals, ready)
    if (cancel) signals.emit('SIGTERM')
    start.resolve(f.service); await Promise.resolve()
    if (cancel) expect(ready).not.toHaveBeenCalled()
    else { expect(receipts[0]).toMatchObject({ servesHtml: true, execution: 'not-run' }); signals.emit('SIGTERM') }
    f.finish(); await task
    expect(receipts.at(-1)).toMatchObject({ status: 'closed', storage: 'postgres', ...(cancel ? { startupCancelled: true } : {}) })
    expect(signals.listenerCount('SIGTERM')).toBe(0)
  })
  it('seals once on repeated signals, waits after a draining receipt and removes handlers after closure', async () => {
    const f = fixture(), signals = new EventEmitter(), receipts: any[] = []
    const task = runServiceProcess(async () => f.service, 'postgres', value => receipts.push(value), 1, signals)
    await Promise.resolve(); expect(receipts[0].status).toBe('ready')
    signals.emit('SIGTERM'); signals.emit('SIGINT'); signals.emit('SIGTERM')
    await Promise.resolve(); expect(f.service.close).toHaveBeenCalledTimes(1)
    expect(receipts.map(r => r.status)).toEqual(['ready', 'draining'])
    expect(signals.listenerCount('SIGTERM')).toBe(1)
    f.finish(); expect(await task).toBe(0)
    expect(receipts.map(r => r.status)).toEqual(['ready', 'draining', 'closed'])
    expect(signals.listenerCount('SIGTERM')).toBe(0); expect(signals.listenerCount('SIGINT')).toBe(0)
  })
  it('remembers shutdown during startup and never emits a misleading ready receipt', async () => {
    const f = fixture(), start = Promise.withResolvers<typeof f.service>(), signals = new EventEmitter(), receipts: any[] = []
    const task = runServiceProcess(() => start.promise, 'postgres', value => receipts.push(value), 1, signals)
    signals.emit('SIGINT'); signals.emit('SIGTERM'); start.resolve(f.service)
    await Promise.resolve(); expect(f.service.close).toHaveBeenCalledTimes(1)
    f.finish(); await task
    expect(receipts.some(r => r.status === 'ready')).toBe(false)
    expect(receipts.at(-1)).toMatchObject({ status: 'closed', startupCancelled: true, storage: 'postgres' })
  })
  it('removes handlers when startup fails', async () => {
    const signals = new EventEmitter(), emit = vi.fn()
    await expect(runServiceProcess(async () => { throw Error('startup') }, 'postgres', emit, 1, signals)).rejects.toThrow('startup')
    expect(emit).not.toHaveBeenCalled(); expect(signals.listenerCount('SIGINT')).toBe(0)
  })
  it('closes storage even if the readiness output sink fails', async () => {
    const f = fixture(), signals = new EventEmitter()
    f.service.close.mockImplementation(async () => { f.finish(); return { status: 'closed', activeRequests: 0 } })
    await expect(runServiceProcess(async () => f.service, 'sqlite', () => { throw Error('sink') }, 1, signals)).rejects.toThrow('sink')
    expect(f.service.close).toHaveBeenCalled(); expect(signals.listenerCount('SIGTERM')).toBe(0)
  })
  it('removes handlers even when drain and final cleanup fail', async () => {
    const f = fixture(), signals = new EventEmitter()
    f.service.close.mockImplementation(async () => { f.done.reject(Error('shutdown')); throw Error('shutdown') })
    const task = runServiceProcess(async () => f.service, 'postgres', () => {}, 1, signals)
    await Promise.resolve(); signals.emit('SIGTERM')
    await expect(task).rejects.toThrow('shutdown'); expect(signals.listenerCount('SIGTERM')).toBe(0)
  })
})
