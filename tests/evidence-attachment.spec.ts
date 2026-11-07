import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { zipSync, unzipSync } from 'fflate'
import { LocalRuntime } from '../src/runtime/index.ts'
import { createEvidenceZip } from '../src/evidence/index.ts'
import { EVIDENCE_ATTACHMENT_LIMIT } from '../src/evidence/attachment.ts'
import { createProjectZip, createProjectZipWithEvidence, readProjectZip } from '../src/packages/index.ts'
import { main } from '../src/cli.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const owners: LocalRuntime[] = []
afterEach(async () => { for (const owner of owners.splice(0)) await owner.close(); vi.restoreAllMocks() })
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const dir = () => mkdtemp(join(tmpdir(), 'jevable-evidence-attachment-'))
async function owner() { const dataDirectory = await dir(), runtime = await LocalRuntime.open({ dataDirectory }); owners.push(runtime); return { runtime, dataDirectory } }
async function fixture() {
  const { runtime, dataDirectory } = await owner()
  const project = runtime.editProject({ operation: 'create', yaml: echo, title: 'Project', actor: 'fixture' })
  const draft = runtime.editTest({ operation: 'create', actor: 'fixture', definition: { title: 'PRIVATE_TEST_TITLE',
    project: { id: project.id, generation: 1, revision: project.acceptedRevision }, input: 'PRIVATE_INPUT',
    expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'PRIVATE_EXPECTED' }] } })
  const test = runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256, actor: 'PRIVATE_REVIEWER' })
  const result = await runtime.runTest({ id: test.id, generation: test.generation, sha256: test.sha256 }, randomUUID())
  runtime.setCredential('secret/key', 'SECRET_NEVER_INCLUDED', 0, 'fixture')
  const selection = { schemaVersion: 1 as const, runs: [{ id: result.run.id, revision: result.run.revision }] }
  return { runtime, dataDirectory, project, test, run: result.run, selection }
}
async function editArchive(bytes: Uint8Array, change: (files: Record<string, Uint8Array>, manifest: any) => void) {
  const files = unzipSync(bytes), manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString())
  change(files, manifest); files['manifest.json'] = Buffer.from(JSON.stringify(manifest)); return zipSync(files)
}

describe('explicit project ZIP evidence attachment', () => {
  it.each([false, true].flatMap(history => [false, true].flatMap(tests => [false, true].map(privateData => ({ history, tests, privateData })))))(
    'round trips only authoring state ($history history, $tests definitions, $privateData private)', async ({ history, tests, privateData }) => {
      const f = await fixture(), target = await owner(), before = await f.runtime.events(f.run.id)
      const bundle = f.runtime.exportProject(f.project.id, 1, f.project.acceptedRevision, history, tests)
      const evidence = await createEvidenceZip(f.runtime, f.selection, privateData)
      const packed = await createProjectZipWithEvidence(bundle, { bytes: evidence.bytes, sha256: evidence.sha256, includePrivate: privateData })
      const files = unzipSync(packed.bytes), manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString())
      expect(manifest).toMatchObject({ version: 3, bundleVersion: tests ? 2 : 1, evidence: { sha256: evidence.sha256, relationship: 'workflow-revision-only', restoration: 'unsupported' } })
      expect(Object.keys(files)).toHaveLength(6); expect(Buffer.from(files['evidence.zip']!)).toEqual(evidence.bytes)
      const read = await readProjectZip(packed.bytes)
      expect(JSON.parse(read.json)).toEqual(bundle); expect(read.archiveSha256).toBe(sha(packed.bytes))
      expect(read.evidence!.inspection.runs[0]).toMatchObject({ id: f.run.id, assessment: 'failed', workflowStatus: 'completed' })
      expect(JSON.stringify(read.evidence)).not.toContain('PRIVATE_')
      const imported = target.runtime.importProject(read.json, sha(read.json), 'fixture')
      expect(imported.acceptedRevision).toBe(f.project.acceptedRevision)
      expect(target.runtime.list()).toEqual([]); expect(target.runtime.connections()).toEqual([])
      expect(target.runtime.credentialStatus('secret/key').configured).toBe(false)
      expect(target.runtime.testCases().filter(test => test.project.id === imported.id).every(test => test.status === 'draft')).toBe(true)
      expect(await f.runtime.events(f.run.id)).toEqual(before)
      expect((await createProjectZipWithEvidence(bundle, { bytes: evidence.bytes, sha256: evidence.sha256, includePrivate: privateData })).bytes).toEqual(packed.bytes)
      expect(Buffer.from(files['project.json']!).toString()).not.toContain('SECRET_NEVER_INCLUDED')
    })

  it('pins caller buffers, bundle contents and consent before asynchronous inspection', async () => {
    const f = await fixture(), bundle = f.runtime.exportProject(f.project.id, 1, f.project.acceptedRevision)
    const evidence = await createEvidenceZip(f.runtime, f.selection, true), original = Buffer.from(evidence.bytes)
    const input = { bytes: evidence.bytes, sha256: evidence.sha256, includePrivate: true }
    const pending = createProjectZipWithEvidence(bundle, input)
    input.bytes.fill(0); input.sha256 = '0'.repeat(64); input.includePrivate = false; bundle.title = 'MUTATED'
    const packed = await pending, read = await readProjectZip(packed.bytes)
    expect(Buffer.from(unzipSync(packed.bytes)['evidence.zip']!)).toEqual(original)
    expect(JSON.parse(read.json).title).not.toBe('MUTATED'); expect(read.evidence!.attachment.declaredPrivacy).toBe('private-execution-data')
  })

  it('keeps attached historical assessments distinct from subsequently edited test definitions', async () => {
    const f = await fixture()
    f.runtime.editTest({ operation: 'edit', id: f.test.id, expectedGeneration: f.test.generation, actor: 'fixture',
      definition: { ...f.test.definition, title: 'NEW_DEFINITION', expectations: [{ kind: 'status', value: 'completed' }] } })
    const evidence = await createEvidenceZip(f.runtime, f.selection, true)
    const bundle = f.runtime.exportProject(f.project.id, 1, f.project.acceptedRevision, false, true)
    const packed = await createProjectZipWithEvidence(bundle, { bytes: evidence.bytes, sha256: evidence.sha256, includePrivate: true })
    const read = await readProjectZip(packed.bytes), imported = JSON.parse(read.json)
    expect(imported.tests.cases[0].definition.title).toBe('NEW_DEFINITION')
    expect(read.evidence!.inspection.runs[0]).toMatchObject({ assessment: 'failed', test: { generation: f.test.generation, sha256: f.test.sha256 } })
    const nested = unzipSync(unzipSync(packed.bytes)['evidence.zip']!), assessment = JSON.parse(Buffer.from(nested[`tests/${f.run.id}.json`]!).toString())
    expect(assessment.title).toBe('PRIVATE_TEST_TITLE'); expect(assessment.checks[1].expected).toBe('PRIVATE_EXPECTED')
  })

  it.each(['private-consent', 'hash', 'revision', 'mixed-revisions', 'oversize', 'corrupt'] as const)('refuses %s without creating an attachment', async mode => {
    const f = await fixture(), bundle = f.runtime.exportProject(f.project.id, 1, f.project.acceptedRevision)
    if (mode === 'mixed-revisions') {
      const other = await f.runtime.run(echo.replace('name: ', 'name: Different '), 'input')
      f.selection.runs.push({ id: other.id, revision: other.revision })
    }
    const evidence = await createEvidenceZip(f.runtime, f.selection, mode === 'private-consent')
    if (mode === 'revision') bundle.accepted.revision = '0'.repeat(64)
    const bytes = mode === 'oversize' ? Buffer.alloc(EVIDENCE_ATTACHMENT_LIMIT + 1) : mode === 'corrupt' ? Buffer.from('not zip') : evidence.bytes
    await expect(createProjectZipWithEvidence(bundle, { bytes, sha256: mode === 'hash' ? '0'.repeat(64) : sha(bytes) })).rejects.toHaveProperty('code',
      mode === 'private-consent' ? 'invalid-command' : mode === 'oversize' ? 'limit' : mode === 'corrupt' ? 'corrupt' : 'conflict')
  })

  it.each(['missing', 'undeclared', 'descriptor', 'revision', 'privacy', 'nested-corruption'] as const)('refuses %s attachment metadata during import inspection', async mode => {
    const f = await fixture(), bundle = f.runtime.exportProject(f.project.id, 1, f.project.acceptedRevision), evidence = await createEvidenceZip(f.runtime, f.selection)
    const packed = await createProjectZipWithEvidence(bundle, { bytes: evidence.bytes, sha256: evidence.sha256 })
    const bytes = await editArchive(packed.bytes, (files, manifest) => {
      if (mode === 'missing') delete files['evidence.zip']
      if (mode === 'undeclared') { manifest.version = 1; delete manifest.bundleVersion; delete manifest.evidence; manifest.files.pop() }
      if (mode === 'descriptor') manifest.evidence.runs++
      if (mode === 'revision') manifest.evidence.revision = '0'.repeat(64)
      if (mode === 'privacy') manifest.evidence.declaredPrivacy = 'private-execution-data'
      if (mode === 'nested-corruption') {
        files['evidence.zip'] = Buffer.from('internally corrupt but outer checksums match')
        const entry = manifest.files.find((e: any) => e.path === 'evidence.zip')
        entry.bytes = files['evidence.zip'].length; entry.sha256 = sha(files['evidence.zip'])
        manifest.evidence.bytes = entry.bytes; manifest.evidence.sha256 = entry.sha256
      }
    })
    await expect(readProjectZip(bytes)).rejects.toHaveProperty('code', 'invalid-package')
  })

  it('keeps legacy project packages unchanged and refuses unversioned attachments', async () => {
    const f = await fixture(), bundle = f.runtime.exportProject(f.project.id, 1, f.project.acceptedRevision)
    const legacy = createProjectZip(bundle), read = await readProjectZip(legacy)
    expect(read).not.toHaveProperty('evidence')
    const files = unzipSync(legacy); files['evidence.zip'] = (await createEvidenceZip(f.runtime, f.selection)).bytes
    await expect(readProjectZip(zipSync(files))).rejects.toHaveProperty('code', 'invalid-package')
  })

  it('CLI requires exact checksum/private opt-in and does not restore evidence or overwrite on failed validation', async () => {
    const f = await fixture(), directory = await dir(), output = join(directory, 'project.zip'), evidenceFile = join(directory, 'evidence.zip')
    const evidence = await createEvidenceZip(f.runtime, f.selection, true); await writeFile(evidenceFile, evidence.bytes); await writeFile(output, 'preserve-existing')
    await f.runtime.close()
    const out = vi.fn(), err = vi.fn(), args = ['projects', 'export', f.project.id, '--revision', f.project.acceptedRevision,
      '--expected-generation', '1', '--format', 'zip', '--output', output, '--data-dir', f.dataDirectory,
      '--evidence-file', evidenceFile, '--evidence-sha256', evidence.sha256, '--overwrite']
    expect(await main(args, { out, err })).toBe(1); expect(await readFile(output, 'utf8')).toBe('preserve-existing')
    expect(await main([...args, '--include-private-evidence'], { out, err })).toBe(0)
    const receipt = JSON.parse(out.mock.calls.at(-1)![0]); expect(receipt.evidence).toMatchObject({ sha256: evidence.sha256, importStatus: 'not-restored' })
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_'); if (process.platform !== 'win32') expect((await stat(output)).mode & 0o777).toBe(0o600)
    const target = await dir()
    expect(await main(['import', 'inspect', output, '--data-dir', target], { out, err })).toBe(0)
    const review = JSON.parse(out.mock.calls.at(-1)![0]); expect(review.evidence.inspection.runs[0].assessment).toBe('failed')
    expect(JSON.stringify(review.evidence)).not.toContain('PRIVATE_')
    expect(await main(['import', 'project', output, '--reviewed-sha256', review.artifactSha256, '--data-dir', target], { out, err })).toBe(0)
    expect(JSON.parse(out.mock.calls.at(-1)![0]).evidence.importStatus).toBe('not-restored')
    const runtime = await LocalRuntime.open({ dataDirectory: target }); owners.push(runtime)
    expect(runtime.list()).toEqual([]); expect(runtime.projects()).toHaveLength(1)
    expect(runtime.credentialStatus('secret/key').configured).toBe(false)
  })

  it.each(['missing-file', 'missing-hash', 'json', 'bad-hash', 'consent-only'] as const)('rejects incomplete CLI attachment flags (%s) before opening state', async mode => {
    const directory = await dir(), data = join(directory, 'must-not-open'), output = join(directory, 'must-not-write.zip')
    const flags = mode === 'consent-only' ? ['--include-private-evidence'] :
      [...(mode === 'missing-file' ? [] : ['--evidence-file', join(directory, 'missing.zip')]),
        ...(mode === 'missing-hash' ? [] : ['--evidence-sha256', mode === 'bad-hash' ? 'bad' : '0'.repeat(64)])]
    expect(await main(['projects', 'export', randomUUID(), '--revision', '0'.repeat(64), '--expected-generation', '1', '--output', output,
      '--format', mode === 'json' ? 'json' : 'zip', '--data-dir', data, ...flags], { out: vi.fn(), err: vi.fn() })).toBe(2)
    await expect(stat(data)).rejects.toHaveProperty('code', 'ENOENT'); await expect(stat(output)).rejects.toHaveProperty('code', 'ENOENT')
  })
})
