import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { CliJobLifetime, CliJobInterruptedError, openJobOperations } from '../src/cli/job-lifetime.ts'
import type { CliOperations } from '../src/cli/operations.ts'

function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(storage: 'sqlite' | 'postgres' = 'sqlite') {
  const signals = new EventEmitter(), report = vi.fn(), lifetime = new CliJobLifetime(report, signals)
  const owner: CliOperations = { storage, call: vi.fn(async () => ({ status: 'completed' })), close: vi.fn(async () => {}) }
  const open = vi.fn(async () => owner)
  return { signals, report, lifetime, owner, open }
}
const read = { operation: 'runs.list' } as const

describe('direct CLI owner lifetime', () => {
  it.each(['sqlite', 'postgres'] as const)('holds %s ownership from startup through async close without implicitly cancelling', async storage => {
    const f = fixture(storage), opening = gate<CliOperations>(), closing = gate()
    f.open.mockImplementation(() => opening.promise)
    vi.mocked(f.owner.close).mockImplementation(() => closing.promise)
    const pending = openJobOperations(storage === 'postgres' ? { storage, 'database-file': '/private/explicit.json' } : {}, f.lifetime, f.open)
    expect(f.signals.listenerCount('SIGTERM')).toBe(1)
    opening.resolve(f.owner)
    const host = await pending
    expect(await host.call(read)).toEqual({ status: 'completed' })
    const closed = host.close()
    f.signals.emit('SIGTERM'); f.signals.emit('SIGINT'); f.signals.emit('SIGTERM')
    expect(f.lifetime.exitCode).toBe(143); expect(f.report).toHaveBeenCalledTimes(1)
    expect(f.owner.close).toHaveBeenCalledTimes(1); expect(f.owner.call).toHaveBeenCalledTimes(1)
    expect(host.close()).toBe(closed)
    expect(f.signals.listenerCount('SIGINT')).toBe(1)
    closing.resolve(); await closed
    expect(f.signals.listenerCount('SIGINT')).toBe(0); expect(f.signals.listenerCount('SIGTERM')).toBe(0)
  })

  it.each(['SIGINT', 'SIGTERM'] as const)('retains %s received during startup and refuses dispatch while still closing the opened owner', async signal => {
    const f = fixture(), opening = gate<CliOperations>()
    f.open.mockImplementation(() => opening.promise)
    const pending = openJobOperations({}, f.lifetime, f.open)
    f.signals.emit(signal)
    expect(f.owner.close).not.toHaveBeenCalled()
    opening.resolve(f.owner)
    const host = await pending
    await expect(host.call(read)).rejects.toBeInstanceOf(CliJobInterruptedError)
    expect(f.owner.call).not.toHaveBeenCalled()
    await host.close()
    expect(f.lifetime.exitCode).toBe(signal === 'SIGINT' ? 130 : 143)
    expect(f.report.mock.calls[0]![0]).toMatchObject({ status: 'draining', signal, execution: 'not-cancelled' })
    expect(f.signals.listenerCount(signal)).toBe(0)
    await expect(openJobOperations({}, f.lifetime, f.open)).rejects.toBeInstanceOf(CliJobInterruptedError)
    expect(f.open).toHaveBeenCalledTimes(1)
  })

  it('allows an admitted operation to settle, stops only future dispatch and never replays or closes it concurrently', async () => {
    const f = fixture(), settle = gate<unknown>()
    vi.mocked(f.owner.call).mockImplementation(() => settle.promise)
    const host = await openJobOperations({}, f.lifetime, f.open), admitted = host.call(read)
    f.signals.emit('SIGINT'); f.signals.emit('SIGTERM')
    expect(f.owner.call).toHaveBeenCalledTimes(1); expect(f.owner.close).not.toHaveBeenCalled()
    await expect(host.call(read)).rejects.toBeInstanceOf(CliJobInterruptedError)
    settle.resolve({ id: 'retained', status: 'waiting' })
    expect(await admitted).toEqual({ id: 'retained', status: 'waiting' })
    await host.close()
    expect(f.owner.call).toHaveBeenCalledTimes(1); expect(f.lifetime.exitCode).toBe(130)
  })

  it('releases only its own listeners after startup failure and preserves the original error', async () => {
    const f = fixture(), external = vi.fn(), error = new Error('startup refused')
    f.signals.on('SIGINT', external); f.open.mockRejectedValue(error)
    await expect(openJobOperations({}, f.lifetime, f.open)).rejects.toBe(error)
    expect(f.signals.listeners('SIGINT')).toEqual([external]); expect(f.signals.listenerCount('SIGTERM')).toBe(0)
    f.lifetime.dispose(); expect(f.signals.listeners('SIGINT')).toEqual([external])
  })

  it('retains close failure without adding retry, forced cleanup or a leaked handler', async () => {
    const f = fixture(), error = new Error('cleanup refused')
    vi.mocked(f.owner.close).mockRejectedValue(error)
    const host = await openJobOperations({}, f.lifetime, f.open)
    await expect(host.close()).rejects.toBe(error)
    await expect(host.close()).rejects.toBe(error)
    expect(f.owner.close).toHaveBeenCalledTimes(1); expect(f.signals.listenerCount('SIGTERM')).toBe(0)
  })

  it.each([
    { endpoint: 'https://explicit.invalid', 'token-file': '/private/token' },
    { runtime: 'docker', 'owner-file': '/private/owner', 'owner-sha256': 'a'.repeat(64), 'container-id': 'b'.repeat(64), 'token-file': '/private/token' },
  ])('selected service %j never installs local-owner signal handlers or changes its authority', async values => {
    const f = fixture(), host = await openJobOperations(values, f.lifetime, f.open)
    expect(host).toBe(f.owner); expect(f.signals.listenerCount('SIGINT')).toBe(0); expect(f.signals.listenerCount('SIGTERM')).toBe(0)
    expect(f.lifetime.exitCode).toBeUndefined(); expect(f.report).not.toHaveBeenCalled()
    await host.call(read); await host.close()
    expect(f.owner.call).toHaveBeenCalledExactlyOnceWith(read)
  })

  it('invalid mixed selection refuses before handlers, storage or remote observation', async () => {
    const f = fixture()
    await expect(openJobOperations({ storage: 'postgres', 'database-file': '/must-not-read', 'data-dir': '/must-not-create' }, f.lifetime, f.open)).rejects.toThrow()
    expect(f.open).not.toHaveBeenCalled(); expect(f.signals.listenerCount('SIGINT')).toBe(0)
  })

  it('a nested local ownership lease keeps handlers until the last cleanup and release is idempotent', () => {
    const f = fixture(), first = f.lifetime.hold(), second = f.lifetime.hold()
    first(); first(); expect(f.signals.listenerCount('SIGTERM')).toBe(1)
    second(); expect(f.signals.listenerCount('SIGTERM')).toBe(0)
    expect(f.lifetime.exitCode).toBeUndefined()
  })
})
