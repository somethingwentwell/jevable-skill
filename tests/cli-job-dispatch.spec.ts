import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { main } from '../src/cli.ts'
import type { CliOperations } from '../src/cli/operations.ts'

const mocks = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../src/cli/operations.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/cli/operations.ts')>(), openCliOperations: mocks.open,
}))
afterEach(() => { vi.clearAllMocks() })

it.each(['SIGINT', 'SIGTERM'] as const)('main drains an admitted direct job after %s, emits its settled result and returns conventional signal status', async signal => {
  const beforeInt = process.listeners('SIGINT'), beforeTerm = process.listeners('SIGTERM'), id = randomUUID()
  let output = '', error = ''
  const owner: CliOperations = { storage: 'sqlite', call: vi.fn(async command => {
    expect(command.operation).toBe('runs.start')
    const before = signal === 'SIGINT' ? beforeInt : beforeTerm
    const handler = process.listeners(signal).find(listener => !before.includes(listener))!
    expect(handler).toBeTypeOf('function'); handler(signal)
    expect(owner.close).not.toHaveBeenCalled()
    return { schemaVersion: 1, id, status: 'completed' }
  }), close: vi.fn(async () => {}) }
  mocks.open.mockResolvedValue(owner)
  const exit = await main(['run', 'examples/echo.yaml', '--input', 'examples/echo-input.json', '--id', id],
    { out: text => { output += text }, err: text => { error += text } })
  expect(exit).toBe(signal === 'SIGINT' ? 130 : 143)
  expect(JSON.parse(output)).toEqual({ schemaVersion: 1, id, status: 'completed' })
  expect(JSON.parse(error)).toMatchObject({ status: 'draining', signal, execution: 'not-cancelled' })
  expect(owner.call).toHaveBeenCalledTimes(1); expect(owner.close).toHaveBeenCalledTimes(1)
  expect(process.listeners('SIGINT')).toEqual(beforeInt); expect(process.listeners('SIGTERM')).toEqual(beforeTerm)
})

it('signal during owner opening refuses dispatch, closes that owner and leaves no result suggesting execution', async () => {
  const before = process.listeners('SIGINT'), call = vi.fn(), close = vi.fn(async () => {})
  mocks.open.mockImplementation(async () => {
    process.listeners('SIGINT').find(listener => !before.includes(listener))!('SIGINT')
    return { storage: 'sqlite', call, close }
  })
  let output = '', error = ''
  expect(await main(['run', 'examples/echo.yaml', '--input', 'examples/echo-input.json'],
    { out: text => { output += text }, err: text => { error += text } })).toBe(130)
  expect(call).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1); expect(output).toBe('')
  expect(JSON.parse(error)).toMatchObject({ status: 'draining', execution: 'not-cancelled' })
  expect(process.listeners('SIGINT')).toEqual(before)
})

it('cleanup failure still reports a sanitized operational error and never claims successful release', async () => {
  mocks.open.mockResolvedValue({ storage: 'sqlite', call: async () => ({ runs: [] }), close: async () => { throw Error('PRIVATE_CLOSE_DETAIL') } })
  let error = ''
  expect(await main(['runs', 'list'], { out: () => {}, err: text => { error += text } })).toBe(1)
  expect(JSON.parse(error)).toMatchObject({ status: 'error', code: 'operation-failed' })
  expect(error).not.toContain('PRIVATE_CLOSE_DETAIL')
})

it.each([['--help'], ['capabilities'], ['schemas', 'list'], ['run', '--help', '--json']].map(args => ({ args })))('offline $args never opens a local owner or installs signal handlers', async ({ args }) => {
  const beforeInt = process.listeners('SIGINT'), beforeTerm = process.listeners('SIGTERM')
  expect(await main(args, { out: () => {}, err: () => {} })).toBe(0)
  expect(mocks.open).not.toHaveBeenCalled()
  expect(process.listeners('SIGINT')).toEqual(beforeInt); expect(process.listeners('SIGTERM')).toEqual(beforeTerm)
})
