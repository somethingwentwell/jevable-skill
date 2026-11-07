import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { constants, type BigIntStats } from 'node:fs'
import { open, stat, statfs } from 'node:fs/promises'
import { currentOwnerContext } from '../src/runtime/owner-context.ts'
vi.mock('node:fs/promises', () => ({ open: vi.fn(), stat: vi.fn(), statfs: vi.fn() }))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const bootId = '34df7911-f150-4a92-a8ce-9f009f1ca061'
const info = { dev: 11n, ino: 22n } as BigIntStats
const files: { path: string; close: ReturnType<typeof vi.fn> }[] = []
const text = new Map<string, string | Buffer>()
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  vi.mocked(statfs).mockResolvedValue({ type: 0xef53n } as never)
  vi.mocked(stat).mockResolvedValue({ dev: 4n, ino: 4026531836n } as never)
  text.set('/proc/sys/kernel/random/boot_id', bootId + '\n'); text.set('/proc/self/stat', `${process.pid} (fixture) ignored`)
  vi.mocked(open).mockImplementation(async (path, flags) => {
    expect(flags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const close = vi.fn(async () => {}); files.push({ path: String(path), close })
    return { close, async read(buffer: Buffer) { const bytes = Buffer.from(text.get(String(path))!); bytes.copy(buffer); return { bytesRead: Math.min(bytes.length, buffer.length), buffer } } } as never
  })
})
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.resetAllMocks(); files.splice(0); text.clear() })

it.each([0xef53n, 0x58465342n, 0x9123683en, 0x01021994n])('admits conservative local Linux filesystem %s with exact kernel identity', async type => {
  vi.mocked(statfs).mockResolvedValue({ type } as never)
  expect(await currentOwnerContext('/private-fixture', info)).toEqual({ platform: 'linux', bootId,
    pidNamespace: { dev: '4', ino: '4026531836' }, filesystemType: String(type), directory: { dev: '11', ino: '22' } })
  expect(files.map(f => f.path)).toEqual(['/proc/sys/kernel/random/boot_id', '/proc/self/stat'])
  expect(files.every(f => f.close.mock.calls.length === 1)).toBe(true)
  expect(vi.mocked(stat).mock.calls.map(c => c[0])).toEqual(['/proc/self/ns/pid', `/proc/${process.pid}/ns/pid`])
})
it.each(['darwin', 'win32', 'freebsd'])('keeps %s nonrecoverable without OS helpers or probing procfs', async value => {
  Object.defineProperty(process, 'platform', { value, configurable: true })
  expect(await currentOwnerContext('/private-fixture', info)).toBeNull()
  expect(statfs).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled()
})
it.each([0x6969n, 0x794c7630n, 0x65735546n, 12345n])('refuses remote/overlay/unknown filesystem %s before kernel reads', async type => {
  vi.mocked(statfs).mockResolvedValue({ type } as never)
  expect(await currentOwnerContext('/private-fixture', info)).toBeNull(); expect(open).not.toHaveBeenCalled()
})
it.each(['invalid', 'x'.repeat(129), ''])('refuses invalid or unbounded boot identity %s and closes its descriptor', async value => {
  text.set('/proc/sys/kernel/random/boot_id', value)
  expect(await currentOwnerContext('/private-fixture', info)).toBeNull(); expect(files.every(f => f.close.mock.calls.length === 1)).toBe(true)
})
it('refuses non-UTF8 identity and a procfs view with a different self PID', async () => {
  text.set('/proc/sys/kernel/random/boot_id', Buffer.from([0xff]))
  expect(await currentOwnerContext('/private-fixture', info)).toBeNull()
  text.set('/proc/sys/kernel/random/boot_id', bootId + '\n'); text.set('/proc/self/stat', `${process.pid + 1} (other)`)
  expect(await currentOwnerContext('/private-fixture', info)).toBeNull(); expect(stat).not.toHaveBeenCalled()
})
it('refuses differing namespace links and denied identity reads', async () => {
  vi.mocked(stat).mockResolvedValueOnce({ dev: 4n, ino: 44n } as never).mockResolvedValueOnce({ dev: 4n, ino: 45n } as never)
  expect(await currentOwnerContext('/private-fixture', info)).toBeNull()
  vi.mocked(open).mockRejectedValueOnce(Object.assign(Error('denied'), { code: 'EPERM' }))
  expect(await currentOwnerContext('/private-fixture', info)).toBeNull()
})
