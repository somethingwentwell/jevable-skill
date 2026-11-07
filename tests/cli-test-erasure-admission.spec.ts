import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { main } from '../src/cli.ts'

const mocks = vi.hoisted(() => ({ read: vi.fn(), open: vi.fn(), call: vi.fn(), close: vi.fn() }))
vi.mock('../src/files.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/files.ts')>(), readBoundedFile: mocks.read }))
vi.mock('../src/cli/operations.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/cli/operations.ts')>(), openCliOperations: mocks.open }))
const caseId = '0FAF815D-1D4D-4D55-8A63-49D1C28DB911'
const request = () => ({ requestId: randomUUID(), test: { id: caseId, generation: 2, sha256: 'a'.repeat(64) }, reviewedHistorySha256: 'b'.repeat(64) })
async function cli(...args: string[]) {
  let out = '', err = ''
  const code = await main(args, { out: text => { out += text }, err: text => { err += text } })
  return { code, out, err, error: err ? JSON.parse(err) : undefined }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.open.mockResolvedValue({ call: mocks.call, close: mocks.close })
  mocks.read.mockResolvedValue(JSON.stringify(request()))
})
describe('draft erasure CLI admission before authority/storage I/O', () => {
  it.each([
    [], ['--confirm-delete', 'not-uuid'], ['--confirm-delete', caseId, '--endpoint', 'https://not-contacted.invalid', '--data-dir', 'never-opened'],
    ['--confirm-delete', caseId, '--runtime', 'docker'], ['--confirm-delete', caseId, '--storage', 'postgres'],
    ['--confirm-delete', caseId, '--actor', 'spoof'],
  ])('refuses incomplete/malformed/mixed flags %j before file or owner reads', async (...flags) => {
    const result = await cli('tests', 'erase', 'never-read.json', ...flags)
    expect(result.code).toBe(2); expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.open).not.toHaveBeenCalled()
    expect(result.out).toBe(''); expect(result.err).not.toContain('never-read.json')
  })
  it.each(['actor', 'references', 'confirmId', 'extra'])('refuses %s in the request file before opening an owner', async key => {
    mocks.read.mockResolvedValue(JSON.stringify({ ...request(), [key]: 'caller-value' }))
    const result = await cli('tests', 'erase', 'request.json', '--confirm-delete', caseId)
    expect(result.code).not.toBe(0); expect(mocks.open).not.toHaveBeenCalled(); expect(mocks.call).not.toHaveBeenCalled()
    expect(result.err).not.toContain('caller-value')
  })
  it('does not normalize the retained case spelling for exact confirmation', async () => {
    const r = request(); mocks.read.mockResolvedValue(JSON.stringify(r))
    const result = await cli('tests', 'erase', 'request.json', '--confirm-delete', caseId.toLowerCase())
    expect(result.code).not.toBe(0); expect(mocks.read).toHaveBeenCalledWith('request.json', 4096)
    expect(mocks.open).not.toHaveBeenCalled(); expect(mocks.call).not.toHaveBeenCalled()
  })
  it.each(['tests erasure', 'tests erasure-review'])('validates %s UUID without opening an owner', async path => {
    const result = await cli(...path.split(' '), 'not-uuid')
    expect(result.code).toBe(2); expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.open).not.toHaveBeenCalled()
  })
  it('normalizes only the request UUID, submits explicit confirmation and no actor/reference overrides', async () => {
    const r = request(); mocks.read.mockResolvedValue(JSON.stringify({ ...r, requestId: r.requestId.toUpperCase() }))
    const receipt = { schemaVersion: 1, policy: 'archived-draft-v1', requestId: r.requestId, test: r.test,
      historySha256: r.reviewedHistorySha256, project: { id: randomUUID(), generation: 1, revision: 'c'.repeat(64) },
      actor: 'trusted:host', at: new Date().toISOString(), status: 'logically-removed', securePhysicalErasure: false }
    mocks.call.mockResolvedValue(receipt)
    const result = await cli('tests', 'erase', 'request.json', '--confirm-delete', caseId)
    expect(result.code, result.err).toBe(0)
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith({ operation: 'tests.erase', request: { ...r, confirmId: caseId } })
    expect(mocks.close).toHaveBeenCalledTimes(1)
  })
  it.each(['requestId', 'test', 'historySha256', 'status', 'actor'])('refuses a foreign/malformed %s receipt without retry or fallback', async key => {
    const r = request(); mocks.read.mockResolvedValue(JSON.stringify(r))
    const receipt = { schemaVersion: 1, policy: 'archived-draft-v1', requestId: r.requestId, test: r.test,
      historySha256: r.reviewedHistorySha256, project: { id: randomUUID(), generation: 1, revision: 'c'.repeat(64) },
      actor: 'trusted:host', at: new Date().toISOString(), status: 'logically-removed', securePhysicalErasure: false }
    const changes: Record<string, unknown> = { requestId: randomUUID(), test: { ...r.test, id: randomUUID() }, historySha256: 'd'.repeat(64), status: 'completed', actor: '' }
    mocks.call.mockResolvedValue({ ...receipt, [key]: changes[key] })
    const result = await cli('tests', 'erase', 'request.json', '--confirm-delete', caseId)
    expect(result.code).not.toBe(0); expect(result.out).toBe(''); expect(result.error.code).toBe('invalid-response')
    expect(mocks.open).toHaveBeenCalledTimes(1); expect(mocks.call).toHaveBeenCalledTimes(1); expect(mocks.close).toHaveBeenCalledTimes(1)
  })
  it('refuses foreign lookup and review identities without presenting success', async () => {
    const r = request()
    mocks.call.mockResolvedValue({ schemaVersion: 1, policy: 'archived-draft-v1', test: { ...r.test, id: randomUUID() },
      historySha256: r.reviewedHistorySha256, projectId: randomUUID(), intrinsicReasons: [], eligibility: 'not-assessed',
      referenceFacts: 'not-discovered', authority: 'none', storageMutation: 'not-performed', scope: 'archived-manual-never-accepted-draft' })
    const result = await cli('tests', 'erasure-review', caseId)
    expect(result.code).not.toBe(0); expect(result.out).toBe(''); expect(result.error.code).toBe('invalid-response')
  })
})
