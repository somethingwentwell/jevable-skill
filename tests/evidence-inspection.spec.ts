import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, unzipSync } from 'fflate'
import { LocalRuntime } from '../src/runtime/index.ts'
import { createEvidenceZip, inspectEvidenceZip, EVIDENCE_PACKAGE_LIMITS } from '../src/evidence/index.ts'
import { readBoundedZip } from '../src/packages/read-zip.ts'
import { main } from '../src/cli.ts'

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
afterEach(() => vi.restoreAllMocks())
async function fixture(includePrivate = false, waiting = false) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-inspect-evidence-')), runtime = await LocalRuntime.open({ dataDirectory: join(directory, 'state') })
  try {
    const project = runtime.editProject({ operation: 'create', title: 'PRIVATE_PROJECT', yaml: waiting ? approval : echo, actor: 'PRIVATE_ACTOR' })
    const draft = runtime.editTest({ operation: 'create', actor: 'PRIVATE_ACTOR', definition: { title: 'PRIVATE_TITLE',
      project: { id: project.id, generation: project.generation, revision: project.acceptedRevision }, input: waiting ? { message: 'PRIVATE_INPUT' } : 'PRIVATE_INPUT',
      expectations: waiting ? [{ kind: 'status', value: 'waiting' }]
        : [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'PRIVATE_EXPECTED' }] } })
    const test = runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256, actor: 'PRIVATE_ACTOR' })
    const result = await runtime.runTest({ id: test.id, generation: test.generation, sha256: test.sha256 }, randomUUID())
    const ordinary = await runtime.run(echo, 'PRIVATE_OTHER', { paused: true })
    const archive = await createEvidenceZip(runtime, { schemaVersion: 1, runs: [result.run, ordinary].map(({ id, revision }) => ({ id, revision })) }, includePrivate)
    return { directory, archive, id: result.run.id, ordinaryId: ordinary.id }
  } finally { await runtime.close() }
}
const parse = (files: Record<string, Uint8Array>, path: string) => JSON.parse(Buffer.from(files[path]!).toString())
const set = (files: Record<string, Uint8Array>, path: string, value: unknown) => { files[path] = Buffer.from(JSON.stringify(value) + '\n') }
function rehash(files: Record<string, Uint8Array>) {
  const manifest = parse(files, 'manifest.json')
  manifest.files = Object.entries(files).filter(([path]) => path !== 'manifest.json').map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) }))
  set(files, 'manifest.json', manifest)
  return zipSync(files)
}
describe('offline evidence archive inspection', () => {
  it.each([false, true])('reports consistent identity/checksums without private output, private=%s', async includePrivate => {
    const { archive, id, ordinaryId } = await fixture(includePrivate)
    const open = vi.spyOn(LocalRuntime, 'open').mockRejectedValue(Error('Storage must not open during inspection'))
    const report = await inspectEvidenceZip(archive.bytes, archive.sha256)
    expect(report).toMatchObject({ status: 'consistent', artifact: { bytes: archive.bytes.length, sha256: archive.sha256 },
      expectedChecksum: 'matched', declaredPrivacy: includePrivate ? 'private-execution-data' : 'metadata-only',
      privatePayloads: 'not-displayed', authenticity: 'not-verified', runtimeHistoryReplay: 'not-performed', files: 6 })
    expect(report.runs[0]).toMatchObject({ id, assessment: 'failed', terminal: true, workflowStatus: 'completed', checks: { total: 2, matched: 1, available: 2 } })
    expect(report.runs[1]).toMatchObject({ id: ordinaryId, workflowStatus: 'paused' })
    expect(report.runs[1]).not.toHaveProperty('assessment')
    expect(JSON.stringify(report)).not.toContain('PRIVATE_'); expect(open).not.toHaveBeenCalled()
    expect((await inspectEvidenceZip(archive.bytes)).expectedChecksum).toBe('not-provided')
  })
  it('pins the original archive bytes before asynchronous reading even if the caller overwrites its buffer', async () => {
    const { archive } = await fixture(), bytes = Buffer.from(archive.bytes), pending = inspectEvidenceZip(bytes)
    bytes.fill(0)
    expect((await pending).artifact.sha256).toBe(archive.sha256)
  })
  it('preserves a passed approval-wait assessment without claiming completion', async () => {
    const { archive } = await fixture(true, true)
    expect((await inspectEvidenceZip(archive.bytes)).runs[0]).toMatchObject({ assessment: 'passed', workflowStatus: 'waiting', terminal: false })
  })
  it('rejects invalid or mismatched caller checksums before parsing an archive', async () => {
    await expect(inspectEvidenceZip(Buffer.from('not a zip'), 'bad')).rejects.toHaveProperty('code', 'invalid-command')
    await expect(inspectEvidenceZip(Buffer.from('not a zip'), '0'.repeat(64))).rejects.toHaveProperty('code', 'conflict')
    await expect(inspectEvidenceZip(Buffer.alloc(EVIDENCE_PACKAGE_LIMITS.archiveBytes + 1))).rejects.toHaveProperty('code', 'limit')
  })
  it.each(['../manifest.json', '/manifest.json', 'C:/manifest.json', 'folder\\manifest.json', 'run.js', 'runs/../escape.json', 'README.TXT'])('refuses non-allowlisted entry %s without echoing its contents', async path => {
    await expect(inspectEvidenceZip(zipSync({ [path]: Buffer.from('PRIVATE_ARCHIVE_VALUE') }))).rejects.toMatchObject({ code: 'corrupt' })
  })
  it.each(['missing', 'extra', 'duplicate-inventory', 'missing-inventory', 'self-inventory', 'file-hash', 'file-size', 'selection-hash', 'run-order', 'status', 'time', 'run-path', 'test-path', 'test-pin', 'test-assessment'])('rejects manifest/inventory disagreement: %s', async mutation => {
    const { archive } = await fixture(), files = unzipSync(archive.bytes), manifest = parse(files, 'manifest.json')
    if (mutation === 'missing') delete files['README.txt']
    if (mutation === 'extra') files[`runs/${randomUUID()}.json`] = Buffer.from('{}')
    if (mutation === 'duplicate-inventory') manifest.files[1] = manifest.files[0]
    if (mutation === 'missing-inventory') manifest.files.pop()
    if (mutation === 'self-inventory') manifest.files[0].path = 'manifest.json'
    if (mutation === 'file-hash') manifest.files[0].sha256 = '0'.repeat(64)
    if (mutation === 'file-size') manifest.files[0].bytes++
    if (mutation === 'selection-hash') manifest.selectionSha256 = '0'.repeat(64)
    if (mutation === 'run-order') manifest.runs.reverse()
    if (mutation === 'status') manifest.runs[0].workflowStatus = 'waiting'
    if (mutation === 'time') manifest.runs[0].observedRunUpdatedAt = '2000-01-01T00:00:00.000Z'
    if (mutation === 'run-path') manifest.runs[0].evidencePath = `runs/${randomUUID()}.json`
    if (mutation === 'test-path') manifest.runs[0].testPath = `tests/${randomUUID()}.json`
    if (mutation === 'test-pin') manifest.runs[0].test.generation++
    if (mutation === 'test-assessment') manifest.runs[0].assessment = 'passed'
    set(files, 'manifest.json', manifest)
    await expect(inspectEvidenceZip(zipSync(files))).rejects.toHaveProperty('code', 'corrupt')
  })
  it.each(['snapshot-hash', 'revision', 'privacy', 'test-pin', 'run-id', 'observed-time', 'matched', 'private-field', 'unknown-field'])('rejects contradictory companions even after inventory is rehashed: %s', async mutation => {
    const { archive, id } = await fixture(), files = unzipSync(archive.bytes), envelope = parse(files, `runs/${id}.json`), test = parse(files, `tests/${id}.json`)
    if (mutation === 'snapshot-hash') envelope.checksum.value = '0'.repeat(64)
    if (mutation === 'revision') envelope.snapshot.run.revision = '0'.repeat(64)
    if (mutation === 'privacy') envelope.snapshot.privacy.payloads = 'included'
    if (mutation === 'test-pin') test.test.generation++
    if (mutation === 'run-id') test.runId = randomUUID()
    if (mutation === 'observed-time') test.observedRunUpdatedAt = '2000-01-01T00:00:00.000Z'
    if (mutation === 'matched') test.checks[1].matched = true
    if (mutation === 'private-field') test.checks[1].actual = 'PRIVATE_INJECTED'
    if (mutation === 'unknown-field') test.unrecognized = 'PRIVATE_INJECTED'
    set(files, `runs/${id}.json`, envelope); set(files, `tests/${id}.json`, test)
    await expect(inspectEvidenceZip(rehash(files))).rejects.toHaveProperty('code', 'corrupt')
  })
  it('refuses inconsistent private expected/actual checks even when their hashes agree', async () => {
    const { archive, id } = await fixture(true), files = unzipSync(archive.bytes), test = parse(files, `tests/${id}.json`)
    test.checks[1].expected = test.checks[1].actual
    set(files, `tests/${id}.json`, test)
    await expect(inspectEvidenceZip(rehash(files))).rejects.toHaveProperty('code', 'corrupt')
  })
  it('rejects extra well-formed run files even when the manifest inventory includes them', async () => {
    const { archive, id } = await fixture(), files = unzipSync(archive.bytes)
    files[`runs/${randomUUID()}.json`] = files[`runs/${id}.json`]!
    await expect(inspectEvidenceZip(rehash(files))).rejects.toHaveProperty('code', 'corrupt')
  })
  it('does not authenticate a self-consistent archive or attest the privacy label', async () => {
    const { archive, id } = await fixture(), files = unzipSync(archive.bytes), manifest = parse(files, 'manifest.json'), envelope = parse(files, `runs/${id}.json`)
    envelope.snapshot.unknownPublisherClaim = 'PRIVATE_NOT_VERIFIED'
    envelope.checksum.value = sha(JSON.stringify(envelope.snapshot)); manifest.runs[0].snapshotSha256 = envelope.checksum.value
    set(files, `runs/${id}.json`, envelope); set(files, 'manifest.json', manifest)
    const report = await inspectEvidenceZip(rehash(files))
    expect(report).toMatchObject({ status: 'consistent', authenticity: 'not-verified', privacyAttestation: 'not-performed; archive-label-is-a-claim' })
    expect(JSON.stringify(report)).not.toContain('PRIVATE_NOT_VERIFIED')
  })
  it('rejects symlinks, encryption, unsupported compression, duplicates, CRC failures and malformed UTF-8', async () => {
    await expect(inspectEvidenceZip(zipSync({ 'manifest.json': [Buffer.from('target'), { os: 3, attrs: 0o120777 << 16 }] })))
      .rejects.toHaveProperty('code', 'corrupt')
    for (const mode of ['encryption', 'compression', 'crc', 'size']) {
      const bytes = Buffer.from(zipSync({ 'manifest.json': Buffer.from('{}') })), central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
      if (mode === 'encryption') bytes.writeUInt16LE(bytes.readUInt16LE(central + 8) | 1, central + 8)
      else if (mode === 'compression') bytes.writeUInt16LE(99, central + 10)
      else if (mode === 'crc') bytes.writeUInt32LE(0, central + 16)
      else bytes.writeUInt32LE(1, central + 24)
      await expect(inspectEvidenceZip(bytes)).rejects.toHaveProperty('code', 'corrupt')
    }
    const duplicate = Buffer.from(zipSync({ 'README.txt': Buffer.from('a'), 'README.txx': Buffer.from('b') }))
    for (let offset = duplicate.indexOf('README.txx'); offset !== -1; offset = duplicate.indexOf('README.txx')) duplicate.write('README.txt', offset)
    await expect(inspectEvidenceZip(duplicate)).rejects.toHaveProperty('code', 'corrupt')
    const { archive } = await fixture(), files = unzipSync(archive.bytes)
    files['README.txt'] = Buffer.from([0xff]); await expect(inspectEvidenceZip(rehash(files))).rejects.toHaveProperty('code', 'corrupt')
  })
  it('enforces entry/count/total expansion limits in the shared streaming reader', async () => {
    const limits = { archiveBytes: 1000, entryBytes: 8, totalBytes: 12, entries: 2 }
    await expect(readBoundedZip(zipSync({ a: Buffer.alloc(9) }), limits, () => true)).rejects.toHaveProperty('code', 'package-limit')
    await expect(readBoundedZip(zipSync({ a: Buffer.alloc(7), b: Buffer.alloc(7) }), limits, () => true)).rejects.toHaveProperty('code', 'package-limit')
    await expect(readBoundedZip(zipSync({ a: Buffer.alloc(1), b: Buffer.alloc(1), c: Buffer.alloc(1) }), limits, () => true)).rejects.toHaveProperty('code', 'package-limit')
    expect([...(await readBoundedZip(zipSync({ a: Buffer.alloc(6), b: Buffer.alloc(6) }), limits, () => true)).keys()]).toEqual(['a', 'b'])
  })
  it('prints metadata only through CLI, refuses runtime/inspection flags and leaves files unchanged', async () => {
    const { archive, directory } = await fixture(true), file = join(directory, 'private.zip')
    await writeFile(file, archive.bytes, { mode: 0o600 })
    const before = await readdir(directory), out = vi.fn(), err = vi.fn(), args = ['runs', 'inspect-bundle', file, '--sha256', archive.sha256]
    const open = vi.spyOn(LocalRuntime, 'open').mockRejectedValue(Error('Must remain offline'))
    expect(await main(args, { out, err })).toBe(0)
    expect(JSON.parse(out.mock.calls.at(-1)![0])).toMatchObject({ status: 'consistent', privatePayloads: 'not-displayed' })
    expect(await main([...args, '--include-private'], { out, err })).toBe(2)
    expect(await main([...args, '--runtime', 'docker'], { out, err })).toBe(2)
    expect(await main(['runs', 'inspect-bundle', file, '--sha256', '0'.repeat(64)], { out, err })).toBe(1)
    expect(JSON.stringify([out.mock.calls, err.mock.calls])).not.toContain('PRIVATE_')
    expect(open).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual(before); expect(await readFile(file)).toEqual(archive.bytes)
  })
})
