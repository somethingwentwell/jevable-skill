import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { LocalRuntime } from '../src/runtime/index.ts'
import { createEvidenceZip, inspectEvidenceSelection, EVIDENCE_PACKAGE_LIMITS, type EvidenceSelection, type EvidencePackageHost } from '../src/evidence/index.ts'
import { main } from '../src/cli.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const owners: LocalRuntime[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const owner of owners.splice(0)) await owner.close() })
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const entries = (bytes: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(bytes)).map(([path, value]) => [path, Buffer.from(value).toString()]))
const selection = (...runs: { id: string; revision: string }[]): EvidenceSelection => ({ schemaVersion: 1, runs: runs.map(({ id, revision }) => ({ id, revision })) })
async function fixture(source = echo, waiting = false) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-evidence-package-')), runtime = await LocalRuntime.open({ dataDirectory }); owners.push(runtime)
  const project = runtime.editProject({ operation: 'create', yaml: source, title: 'PRIVATE_PROJECT', actor: 'PRIVATE_ACTOR' })
  const draft = runtime.editTest({ operation: 'create', actor: 'PRIVATE_ACTOR', definition: { title: 'PRIVATE_TEST_TITLE',
    project: { id: project.id, generation: project.generation, revision: project.acceptedRevision },
    input: waiting ? { message: 'PRIVATE_REVIEW' } : 'PRIVATE_INPUT',
    expectations: waiting ? [{ kind: 'status', value: 'waiting' }] : [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'PRIVATE_EXPECTED' }] } })
  const test = runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256, actor: 'PRIVATE_REVIEWER' })
  const result = await runtime.runTest({ id: test.id, generation: test.generation, sha256: test.sha256 }, randomUUID())
  return { runtime, dataDirectory, test, run: result.run }
}
describe('selected run and historical test evidence packages', () => {
  it('packages only selected observations with deterministic bytes and an exact checksummed inventory', async () => {
    const { runtime, run } = await fixture(), ordinary = await runtime.run(echo, 'PRIVATE_OTHER')
    await runtime.run(echo, 'PRIVATE_UNSELECTED')
    runtime.setCredential('secret/key', 'SECRET_CREDENTIAL', 0, 'PRIVATE_CREDENTIAL_ACTOR')
    const before = await runtime.events(run.id), picked = selection(run, ordinary), result = await createEvidenceZip(runtime, picked)
    const files = entries(result.bytes), manifest = JSON.parse(files['manifest.json']!)
    expect(Object.keys(files).sort()).toEqual(['README.txt', 'manifest.json', 'selection.json', `runs/${run.id}.json`, `runs/${ordinary.id}.json`, `tests/${run.id}.json`].sort())
    expect(result.sha256).toBe(sha(result.bytes)); expect(result.manifest).toEqual(manifest)
    expect(manifest.selectionSha256).toBe(inspectEvidenceSelection(picked).sha256)
    for (const file of manifest.files) { expect(sha(files[file.path]!)).toBe(file.sha256); expect(Buffer.byteLength(files[file.path]!)).toBe(file.bytes) }
    expect(Object.values(files).join('')).not.toMatch(/PRIVATE_|SECRET_CREDENTIAL/)
    const test = JSON.parse(files[`tests/${run.id}.json`]!)
    expect(test).toMatchObject({ assessment: 'failed', workflowStatus: 'completed', privateInspection: false })
    expect(test).not.toHaveProperty('title'); expect(test).not.toHaveProperty('run')
    expect(test.checks.every((check: object) => !('expected' in check) && !('actual' in check))).toBe(true)
    expect((await createEvidenceZip(runtime, picked)).bytes).toEqual(result.bytes)
    expect(await runtime.events(run.id)).toEqual(before)
  })
  it('requires explicit private inclusion for source, actors, title and expected/actual values', async () => {
    const { runtime, run } = await fixture()
    runtime.setCredential('secret/key', 'SECRET_CREDENTIAL', 0, 'PRIVATE_CREDENTIAL_ACTOR')
    const files = entries((await createEvidenceZip(runtime, selection(run), true)).bytes)
    const test = JSON.parse(files[`tests/${run.id}.json`]!), evidence = JSON.parse(files[`runs/${run.id}.json`]!)
    expect(test.title).toBe('PRIVATE_TEST_TITLE')
    expect(test.checks[1]).toMatchObject({ expected: 'PRIVATE_EXPECTED', actual: 'PRIVATE_INPUT', matched: false })
    expect(evidence.snapshot.private.run.yaml).toBe((await runtime.show(run.id)).yaml)
    expect(evidence.snapshot.private.run.input).toBe('PRIVATE_INPUT')
    expect(Object.values(files).join('')).not.toContain('SECRET_CREDENTIAL')
    expect(JSON.parse(files['manifest.json']!).privacy).toBe('private-execution-data')
  })
  it('uses historical accepted expectations after a case is edited', async () => {
    const { runtime, test, run } = await fixture()
    runtime.editTest({ operation: 'edit', id: test.id, expectedGeneration: test.generation, actor: 'editor',
      definition: { ...test.definition, title: 'NEW_PRIVATE_TITLE', expectations: [{ kind: 'status', value: 'completed' }] } })
    const files = entries((await createEvidenceZip(runtime, selection(run), true)).bytes), saved = JSON.parse(files[`tests/${run.id}.json`]!)
    expect(saved.test.generation).toBe(test.generation); expect(saved.title).toBe('PRIVATE_TEST_TITLE'); expect(saved.assessment).toBe('failed')
  })
  it('does not mistake a matching approval-wait assessment for workflow completion', async () => {
    const { runtime, run } = await fixture(approval, true), before = await runtime.events(run.id)
    const result = await createEvidenceZip(runtime, selection(run)), test = JSON.parse(entries(result.bytes)[`tests/${run.id}.json`]!)
    expect(test).toMatchObject({ assessment: 'passed', workflowStatus: 'waiting', terminal: false })
    expect(await runtime.events(run.id)).toEqual(before)
  })
  it('re-reads a moving test observation without mixing pre-decision checks with completed evidence', async () => {
    const { runtime, run } = await fixture(approval, true); let changed = false
    const host: EvidencePackageHost = { exportRun: (...args) => runtime.exportRun(...args), async testResult(id, inspect) {
      const before = await runtime.testResult(id, inspect)
      if (!changed) {
        changed = true; const waiting = await runtime.show(id)
        if (waiting.state.status !== 'waiting') throw Error('Expected fixture wait')
        await runtime.decide(id, waiting.state.attempt.id, 'approve', 'fixture')
      }
      return before
    } }
    const files = entries((await createEvidenceZip(host, selection(run))).bytes), test = JSON.parse(files[`tests/${run.id}.json`]!)
    expect(test).toMatchObject({ assessment: 'failed', workflowStatus: 'completed', terminal: true })
    expect(JSON.parse(files[`runs/${run.id}.json`]!).snapshot.run.status).toBe('completed')
  })
  it('bounds read retries and returns no partial archive when snapshots keep changing', async () => {
    const { runtime, run } = await fixture(), saved = await runtime.exportRun(run.id); let reads = 0
    const host = { exportRun: vi.fn(async () => {
      const value = structuredClone(saved); value.snapshot.boundary.lastSequence = ++reads
      value.checksum.value = sha(JSON.stringify(value.snapshot)); return value
    }), testResult: (id: string, inspect: boolean) => runtime.testResult(id, inspect) }
    await expect(createEvidenceZip(host, selection(run))).rejects.toHaveProperty('code', 'busy')
    expect(host.exportRun).toHaveBeenCalledTimes(6)
  })
  it.each(['checksum', 'privacy', 'revision', 'identity'])('refuses invalid %s evidence', async kind => {
    const { runtime, run } = await fixture(), saved: any = await runtime.exportRun(run.id)
    if (kind === 'checksum') saved.checksum.value = '0'.repeat(64)
    if (kind === 'privacy') saved.snapshot.privacy.payloads = 'included'
    if (kind === 'revision') saved.snapshot.run.revision = '0'.repeat(64)
    if (kind === 'identity') saved.snapshot.run.id = randomUUID()
    const testResult = vi.fn()
    await expect(createEvidenceZip({ exportRun: () => saved, testResult }, selection(run))).rejects.toHaveProperty('code', 'corrupt')
    expect(testResult).not.toHaveBeenCalled()
  })
  it.each(['test', 'run', 'time', 'assessment', 'private', 'actual'])('rejects incoherent or unexpectedly private test %s metadata', async kind => {
    const { runtime, run } = await fixture(), result: any = await runtime.testResult(run.id)
    if (kind === 'test') result.test = { ...result.test, generation: 99 }
    if (kind === 'run') result.run = { ...result.run, id: randomUUID() }
    if (kind === 'time') result.observedRunUpdatedAt = '2000-01-01T00:00:00.000Z'
    if (kind === 'assessment') result.assessment = 'passed'
    if (kind === 'private') result.privateInspection = true
    if (kind === 'actual') result.checks[0].actual = 'PRIVATE_UNEXPECTED'
    await expect(createEvidenceZip({ exportRun: (...args) => runtime.exportRun(...args), testResult: () => result }, selection(run))).rejects.toHaveProperty('code', 'corrupt')
  })
  it('validates the full explicit selection before reading an owner and detaches it before awaits', async () => {
    const host = { exportRun: vi.fn(), testResult: vi.fn() }, run = { id: randomUUID(), revision: 'a'.repeat(64) }
    for (const picked of [selection(), selection(run, run), { ...selection(run), discover: true }, selection({ ...run, id: '../escape' }),
      selection(...Array.from({ length: 101 }, () => ({ ...run, id: randomUUID() })))]) {
      await expect(createEvidenceZip(host, picked as EvidenceSelection)).rejects.toHaveProperty('code', 'invalid-command')
    }
    await expect(createEvidenceZip(host, selection(run), 'yes' as unknown as boolean)).rejects.toHaveProperty('code', 'invalid-command')
    expect(host.exportRun).not.toHaveBeenCalled()
    const f = await fixture(), picked = selection(f.run), expected = structuredClone(picked)
    const result = await createEvidenceZip({ exportRun: async (...args) => { picked.runs[0]!.revision = '0'.repeat(64); return f.runtime.exportRun(...args) },
      testResult: (...args) => f.runtime.testResult(...args) }, picked)
    expect(JSON.parse(entries(result.bytes)['selection.json']!)).toEqual(expected)
  })
  it('preserves PostgreSQL decimal metadata without converting it to Number', async () => {
    const { runtime, run } = await fixture(), value: any = await runtime.exportRun(run.id)
    value.schemaVersion = 2; value.snapshot.schemaVersion = 2
    value.snapshot.storage = { kind: 'postgres', recordVersion: '9007199254740999' }
    value.snapshot.journal.forEach((event: any, index: number) => { event.sequence = String(9007199254740999n + BigInt(index)); event.version = String(index + 1) })
    value.checksum.value = sha(JSON.stringify(value.snapshot))
    const result = await createEvidenceZip({ exportRun: () => value, testResult: (...args) => runtime.testResult(...args) }, selection(run))
    expect(JSON.parse(entries(result.bytes)[`runs/${run.id}.json`]!).snapshot.journal[0].sequence).toBe('9007199254740999')
  })
  it('exports ordinary paused and cancelled observations without asking for test evidence', async () => {
    const { runtime } = await fixture(), paused = await runtime.run(echo, 'PRIVATE_PAUSED', { paused: true })
    const host = { exportRun: (...args: [string, boolean]) => runtime.exportRun(...args), testResult: vi.fn() }
    const first = await createEvidenceZip(host, selection(paused))
    expect(first.manifest.runs[0]).toMatchObject({ workflowStatus: 'paused' })
    expect(first.manifest.runs[0]).not.toHaveProperty('testPath')
    await runtime.cancel(paused.id, randomUUID(), 'fixture')
    const second = await createEvidenceZip(host, selection(paused))
    expect(second.manifest.runs[0]).toMatchObject({ workflowStatus: 'cancelled' })
    expect(host.testResult).not.toHaveBeenCalled()
  })
  it('detaches test checks before the second evidence read can mutate a host-owned result', async () => {
    const { runtime, run } = await fixture(), saved: any = await runtime.testResult(run.id); let reads = 0
    const host = { exportRun: async (...args: [string, boolean]) => {
      if (++reads === 2) { saved.assessment = 'passed'; saved.checks[1].matched = true; saved.checks[1].actual = 'PRIVATE_INJECTED' }
      return runtime.exportRun(...args)
    }, testResult: () => saved }
    const result = await createEvidenceZip(host, selection(run)), files = entries(result.bytes)
    expect(JSON.parse(files[`tests/${run.id}.json`]!).assessment).toBe('failed')
    expect(Object.values(files).join('')).not.toContain('PRIVATE_INJECTED')
  })
  it('bounds raw selection and assessment bytes before accepting or stripping fields', async () => {
    const host = { exportRun: vi.fn(), testResult: vi.fn() }
    await expect(createEvidenceZip(host, { schemaVersion: 1, runs: [], excess: 'x'.repeat(EVIDENCE_PACKAGE_LIMITS.selectionBytes) } as EvidenceSelection))
      .rejects.toHaveProperty('code', 'limit')
    expect(host.exportRun).not.toHaveBeenCalled()
    const { runtime, run } = await fixture(), saved = await runtime.testResult(run.id)
    await expect(createEvidenceZip({ exportRun: (...args) => runtime.exportRun(...args),
      testResult: () => ({ ...saved, excess: 'x'.repeat(EVIDENCE_PACKAGE_LIMITS.entryBytes) }) }, selection(run)))
      .rejects.toHaveProperty('code', 'limit')
  })
  it('publishes CLI ZIPs privately, refuses overwrite and emits no selected private payloads', async () => {
    const { runtime, run, dataDirectory } = await fixture(), picked = join(dataDirectory, 'selection.json'), output = join(dataDirectory, 'evidence.zip')
    await writeFile(picked, JSON.stringify(selection(run))); await runtime.close()
    const out = vi.fn(), err = vi.fn(), args = ['runs', 'export-bundle', picked, '--output', output, '--data-dir', dataDirectory]
    expect(await main(args, { out, err })).toBe(0)
    const first = await readFile(output), receipt = JSON.parse(out.mock.calls.at(-1)![0])
    expect(receipt).toMatchObject({ status: 'written', runs: 1, testAssessments: 1, privacy: 'metadata-only' })
    expect(receipt.artifact.sha256).toBe(sha(first))
    if (process.platform !== 'win32') expect((await stat(output)).mode & 0o777).toBe(0o600)
    expect(await main(args, { out, err })).toBe(1); expect(await readFile(output)).toEqual(first)
    expect(await main([...args, '--include-private', '--overwrite'], { out, err })).toBe(0)
    expect(Object.values(entries(await readFile(output))).join('')).toContain('PRIVATE_EXPECTED')
    expect(JSON.stringify(out.mock.calls)).not.toContain('PRIVATE_')
  })
})
