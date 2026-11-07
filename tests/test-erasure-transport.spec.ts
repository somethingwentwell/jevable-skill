import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { LocalRuntime } from '../src/runtime/local.ts'
import { dispatchOperation, runtimeOperationSchema } from '../src/http/operations.ts'
import { startRuntimeService } from '../src/http/service.ts'
import { RuntimeClient } from '../src/http/client.ts'
import { main } from '../src/cli.ts'
import { prepareTestErasureReview, testHistorySha256 } from '../src/testing/erasure.ts'
import { testErasureCommandSchema } from '../src/testing/erasure-write.ts'
import { PreviewSession } from '../src/preview/session.ts'
import { ReleaseSession } from '../src/releases/service-session.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { createTlsFixture, fixturePort } from '../scripts/tls-fixture.mjs'
import { showSchema } from '../src/contracts.ts'

const yaml = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const actor = 'fixture:erasure-host', token = '1'.repeat(64)
const closes: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
async function cli(...args: string[]) {
  let stdout = '', stderr = ''
  const code = await main(args, { out: text => { stdout += text }, err: text => { stderr += text } })
  return { code, result: stdout ? JSON.parse(stdout) : undefined, error: stderr ? JSON.parse(stderr) : undefined }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-erasure-transport-'))
  const owner = await LocalRuntime.open({ dataDirectory: join(directory, 'state') })
  closes.push(() => owner.close())
  const call = (value: unknown) => dispatchOperation({ storage: 'sqlite', runtime: owner }, value, actor) as Promise<any>
  const project = owner.editProject({ operation: 'create', title: 'Transport fixture', yaml, actor })
  const definition = { title: 'PRIVATE_TRANSPORT_TITLE', project: { id: project.id, generation: 1, revision: project.acceptedRevision },
    input: 'PRIVATE_TRANSPORT_INPUT', expectations: [{ kind: 'status' as const, value: 'completed' as const }] }
  const draft = owner.editTest({ operation: 'create', definition, actor })
  const archive = () => owner.editTest({ operation: 'archive', id: draft.id, expectedGeneration: owner.testCase(draft.id).generation,
    reviewedSha256: draft.sha256, archived: true, actor })
  const request = () => {
    const review = prepareTestErasureReview(owner.testHistory(draft.id))
    return { requestId: randomUUID(), test: review.test, reviewedHistorySha256: review.historySha256 }
  }
  return { directory, owner, call, project, definition, draft, archive, request }
}

describe('standalone owner draft erasure transport', () => {
  it('prepares private-history pins without mutation, eligibility or invented reference counts', async () => {
    const f = await fixture(), before = f.owner.testHistory(f.draft.id)
    const review = await f.call({ operation: 'tests.erasure-review', id: f.draft.id })
    expect(review).toMatchObject({ test: { id: f.draft.id, generation: 1, sha256: f.draft.sha256 },
      historySha256: testHistorySha256(before), intrinsicReasons: ['not-archived'], eligibility: 'not-assessed',
      referenceFacts: 'not-discovered', authority: 'none', storageMutation: 'not-performed' })
    expect(review).not.toHaveProperty('eligible'); expect(review).not.toHaveProperty('references')
    for (const secret of ['PRIVATE_TRANSPORT_TITLE', 'PRIVATE_TRANSPORT_INPUT', actor]) expect(JSON.stringify(review)).not.toContain(secret)
    expect(f.owner.testHistory(f.draft.id)).toEqual(before); expect(f.owner.list()).toEqual([])
    f.archive()
    expect((await f.call({ operation: 'tests.erasure-review', id: f.draft.id })).intrinsicReasons).toEqual([])
  })
  it('uses exact full-history/case pins, host attribution, immutable request retry and retained project references', async () => {
    const f = await fixture(); f.archive(); const request = f.request()
    const command = { operation: 'tests.erase', request: { ...request, confirmId: f.draft.id } }
    const receipt = await f.call(command)
    expect(receipt).toMatchObject({ requestId: request.requestId, test: request.test, historySha256: request.reviewedHistorySha256,
      actor, status: 'logically-removed', securePhysicalErasure: false })
    for (const secret of ['PRIVATE_TRANSPORT_TITLE', 'PRIVATE_TRANSPORT_INPUT']) expect(JSON.stringify(receipt)).not.toContain(secret)
    expect(await f.call(command)).toEqual(receipt)
    expect(await f.call({ operation: 'tests.erasure', requestId: request.requestId.toUpperCase() })).toEqual(receipt)
    expect(f.owner.testCases()).toEqual([]); expect(() => f.owner.testHistory(f.draft.id)).toThrow('not-found')
    await expect(f.call({ ...command, request: { ...command.request, requestId: randomUUID() } })).rejects.toThrow('conflict')
    await expect(dispatchOperation({ storage: 'sqlite', runtime: f.owner }, command, 'different:host')).rejects.toThrow('conflict')
    f.owner.editProject({ operation: 'archive', id: f.project.id, expectedGeneration: 1, archived: true, actor })
    expect(() => f.owner.deleteProject(f.project.id, 2, actor)).toThrow('referenced')
  })
  it.each(['actor', 'references', 'unknown'])('rejects caller %s in strict nested removal requests', async field => {
    const f = await fixture(); f.archive(); const request = f.request(), before = f.owner.testHistory(f.draft.id)
    await expect(f.call({ operation: 'tests.erase', request: { ...request, confirmId: f.draft.id, [field]: field === 'actor' ? 'spoof' : {} } })).rejects.toThrow('invalid-command')
    expect(f.owner.testHistory(f.draft.id)).toEqual(before)
  })
  it('refuses wrong confirmation, stale guards and accepted history without removing evidence', async () => {
    const f = await fixture(), stale = f.request(); f.archive(); const current = f.request()
    await expect(f.call({ operation: 'tests.erase', request: { ...current, confirmId: randomUUID() } })).rejects.toThrow('invalid-command')
    await expect(f.call({ operation: 'tests.erase', request: { ...stale, confirmId: f.draft.id } })).rejects.toThrow('conflict')
    const generated = f.owner.generateTests({ id: randomUUID(), project: f.definition.project, limit: 1, actor })
    const candidate = generated.snapshot.cases[0]!
    f.owner.editTest({ operation: 'archive', id: candidate.id, expectedGeneration: 1, reviewedSha256: candidate.sha256, archived: true, actor })
    const review = prepareTestErasureReview(f.owner.testHistory(candidate.id))
    expect(review.eligibility).toBe('not-assessed'); expect(review).not.toHaveProperty('references')
    await expect(f.call({ operation: 'tests.erase', request: { requestId: randomUUID(), test: review.test,
      reviewedHistorySha256: review.historySha256, confirmId: candidate.id } })).rejects.toThrow('referenced')
    expect(f.owner.testGeneration(generated.snapshot.id)).toEqual(generated)
    const accepted = f.owner.editTest({ operation: 'create', definition: f.definition, actor })
    f.owner.editTest({ operation: 'accept', id: accepted.id, expectedGeneration: 1, reviewedSha256: accepted.sha256, actor })
    f.owner.editTest({ operation: 'archive', id: accepted.id, expectedGeneration: 2, reviewedSha256: accepted.sha256, archived: true, actor })
    const pinned = prepareTestErasureReview(f.owner.testHistory(accepted.id))
    expect(pinned.intrinsicReasons).toEqual(['accepted-history'])
    await expect(f.call({ operation: 'tests.erase', request: { requestId: randomUUID(), test: pinned.test,
      reviewedHistorySha256: pinned.historySha256, confirmId: accepted.id } })).rejects.toThrow('referenced')
    expect(f.owner.testHistory(accepted.id).versions).toHaveLength(3)
  })
  it('uses real authenticated HTTP and explicit CLI endpoint selection without opening a second storage owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-erasure-http-')), tokenFile = join(directory, 'token')
    await writeFile(tokenFile, token, { mode: 0o600 })
    const tls = await createTlsFixture(directory), port = await fixturePort()
    const service = await startRuntimeService({ token, actor, runtime: { dataDirectory: join(directory, 'state') }, port,
      tls: { publicOrigin: `https://127.0.0.1:${port}`, bindAddress: '127.0.0.1', certificateFile: tls.cert, privateKeyFile: tls.key } })
    closes.push(async () => { await service.close(); await service.closed })
    const client = new RuntimeClient(service.url, token, 3000, 20_000_000, { ca: tls.ca, expectedInstanceId: service.instanceId })
    const call = async (value: Parameters<RuntimeClient['operation']>[0]) => (await client.operation(value) as { result: any }).result
    const project = await call({ operation: 'projects.command', command: { operation: 'create', title: 'HTTP', yaml } })
    const draft = await call({ operation: 'tests.command', command: { operation: 'create', definition: {
      title: 'Private HTTP case', project: { id: project.id, generation: 1, revision: project.acceptedRevision },
      input: 'private-http', expectations: [{ kind: 'status', value: 'completed' }] } } })
    await call({ operation: 'tests.command', command: { operation: 'archive', id: draft.id, expectedGeneration: 1, reviewedSha256: draft.sha256, archived: true } })
    const flags = ['--endpoint', service.url, '--token-file', tokenFile, '--instance-id', service.instanceId, '--ca-file', tls.cert]
    const prepared = await cli('tests', 'erasure-review', draft.id, ...flags)
    expect(prepared.code, JSON.stringify(prepared.error)).toBe(0)
    const request = { requestId: randomUUID(), test: prepared.result.test, reviewedHistorySha256: prepared.result.historySha256 }
    const file = join(directory, 'request.json'); await writeFile(file, JSON.stringify(request), { mode: 0o600 })
    await expect(new RuntimeClient(service.url, '2'.repeat(64), 3000, 20_000_000, { ca: tls.ca }).operation({ operation: 'tests.erase', request: { ...request, confirmId: draft.id } })).rejects.toMatchObject({ status: 401 })
    const removed = await cli('tests', 'erase', file, '--confirm-delete', draft.id, ...flags)
    expect(removed.code, JSON.stringify(removed.error)).toBe(0); expect(removed.result.actor).toBe(actor)
    expect((await cli('tests', 'erase', file, '--confirm-delete', draft.id, ...flags)).result).toEqual(removed.result)
    expect((await cli('tests', 'erasure', request.requestId, ...flags)).result).toEqual(removed.result)
    expect((await call({ operation: 'tests.list' })).tests).toEqual([])
    await expect(new RuntimeClient(service.url, token, 3000, 20_000_000, { ca: tls.ca, expectedInstanceId: randomUUID() })
      .operation({ operation: 'tests.erasure', requestId: request.requestId })).rejects.toMatchObject({ code: 'instance-mismatch' })
  })
  it('runs the same direct CLI path with host-fixed local attribution and reopens receipts', async () => {
    const f = await fixture(); f.archive(); const request = f.request(), file = join(f.directory, 'request.json')
    await writeFile(file, JSON.stringify(request), { mode: 0o600 }); await f.owner.close()
    const flags = ['--data-dir', join(f.directory, 'state')]
    const removed = await cli('tests', 'erase', file, '--confirm-delete', f.draft.id, ...flags)
    expect(removed.code, JSON.stringify(removed.error)).toBe(0); expect(removed.result.actor).toBe(`local:${userInfo().username}`)
    expect((await cli('tests', 'erasure', request.requestId, ...flags)).result).toEqual(removed.result)
    expect((await cli('tests', 'erase', file, '--confirm-delete', f.draft.id, ...flags)).result).toEqual(removed.result)
  })
  it('keeps owner removal unavailable to scoped preview and exact-release adapters', async () => {
    const f = await fixture(); f.archive(); const request = f.request()
    const preview = await PreviewSession.create({ call: f.call }, yaml)
    const release = f.owner.createRelease({ id: randomUUID(), projectId: f.project.id, expectedGeneration: 1,
      revision: f.project.acceptedRevision, version: '1.0.0', runtime: { version: CORE_VERSION, sha256: 'c'.repeat(64) }, actor })
    const exact = new ReleaseSession({ storage: 'sqlite', runtime: f.owner }, release.snapshot, actor)
    for (const operation of [{ operation: 'tests.erase', request: { ...request, confirmId: f.draft.id } },
      { operation: 'tests.erasure-review', id: f.draft.id }, { operation: 'tests.erasure', requestId: request.requestId }]) {
      await expect(preview.operation(operation)).rejects.toThrow('invalid-command')
      await expect(exact.operation(operation)).rejects.toThrow('invalid-command')
    }
    expect(f.owner.testHistory(f.draft.id).versions).toHaveLength(2)
    expect(exact.capabilities().operations).not.toContain('tests.erase')
  })
  it('publishes the strict consuming request schema, separate from confirmation and actor', () => {
    const request = { requestId: randomUUID(), test: { id: randomUUID(), generation: 2, sha256: 'a'.repeat(64) }, reviewedHistorySha256: 'b'.repeat(64) }
    expect(testErasureCommandSchema.safeParse(request).success).toBe(true)
    for (const key of ['actor', 'confirmId', 'references']) expect(testErasureCommandSchema.safeParse({ ...request, [key]: 'x' }).success).toBe(false)
    expect(runtimeOperationSchema.safeParse({ operation: 'tests.erase', request }).success).toBe(false)
    expect(runtimeOperationSchema.safeParse({ operation: 'tests.erase', request: { ...request, confirmId: request.test.id } }).success).toBe(true)
    const schema = showSchema('test-erasure-request').schema
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties!)).toEqual(['requestId', 'test', 'reviewedHistorySha256'])
  })
})
