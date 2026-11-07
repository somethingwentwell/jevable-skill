import { describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { unzipSync, zipSync } from 'fflate'
import { LocalRuntime } from '../src/runtime/index.ts'
import { testHash } from '../src/testing/schema.ts'
import { createProjectZip, readProjectZip } from '../src/packages/project-zip.ts'
import { main } from '../src/cli.ts'

const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'jevable-case-transfer-')), runtime = await LocalRuntime.open({ dataDirectory: path })
  const project = runtime.editProject({ operation: 'create', title: 'Transfer', yaml: source, actor: 'local:source' })
  const definition = { title: 'Private test', project: { id: project.id, generation: project.generation, revision: project.acceptedRevision },
    input: 'private test input', expectations: [{ kind: 'status' as const, value: 'completed' as const }, { kind: 'output-equals' as const, value: 'private test input' }] }
  const draft = runtime.editTest({ operation: 'create', definition, actor: 'local:source' })
  const accepted = runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256, actor: 'local:source' })
  return { path, runtime, project, definition, accepted }
}

describe('opt-in saved-test transfer as locally reviewed drafts', () => {
  it('transfers exact recorded-port expectations as fresh drafts and rejects a forged undeclared port', async () => {
    const f = await fixture(), targetPath = await mkdtemp(join(tmpdir(), 'jevable-case-port-target-'))
    const target = await LocalRuntime.open({ dataDirectory: targetPath })
    try {
      const edited = f.runtime.editTest({ operation: 'edit', id: f.accepted.id, expectedGeneration: 2, actor: 'fixture',
        definition: { ...f.definition, expectations: [...f.definition.expectations, { kind: 'node-port-equals', nodeId: 'start', value: 'next' }] } })
      f.runtime.editTest({ operation: 'accept', id: edited.id, expectedGeneration: 3, reviewedSha256: edited.sha256, actor: 'fixture' })
      const bundle = f.runtime.exportProject(f.project.id, 1, f.project.acceptedRevision, false, true)
      if (bundle.version !== 2) throw Error('Expected v2')
      const { json } = await readProjectZip(createProjectZip(bundle))
      const imported = target.importProject(json, sha(json), 'fixture'), summary = target.testCases().find(t => t.project.id === imported.id)!
      const draft = target.testCase(summary.id)
      expect(draft.definition.expectations.at(-1)).toEqual({ kind: 'node-port-equals', nodeId: 'start', value: 'next' })
      expect(draft.status).toBe('draft'); expect(target.list()).toEqual([])
      const accepted = target.editTest({ operation: 'accept', id: draft.id, expectedGeneration: 1, reviewedSha256: draft.sha256, actor: 'fixture' })
      expect((await target.runTest({ id: accepted.id, generation: 2, sha256: accepted.sha256 }, randomUUID())).assessment).toBe('passed')
      const forged = structuredClone(bundle), item = forged.tests.cases[0]!
      item.definition.expectations = [{ kind: 'status', value: 'completed' }, { kind: 'node-port-equals', nodeId: 'start', value: 'false' }]
      item.source.sha256 = testHash(item.definition)
      expect(() => target.inspectProjectImport(JSON.stringify(forged))).toThrow('invalid-command')
      expect(() => target.importProject(JSON.stringify(forged), sha(JSON.stringify(forged)), 'fixture')).toThrow('invalid-command')
      expect(target.projects()).toHaveLength(1)
    } finally { await f.runtime.close(); await target.close() }
  })

  it.each([false, true])('round trips definitions and provenance with history=%s, never imported acceptance or runs', async history => {
    const f = await fixture(), targetPath = await mkdtemp(join(tmpdir(), 'jevable-case-target-'))
    let target = await LocalRuntime.open({ dataDirectory: targetPath })
    try {
      const ordinary = f.runtime.exportProject(f.project.id, 1, f.project.acceptedRevision, history)
      expect(ordinary.version).toBe(1); expect(JSON.stringify(ordinary)).not.toContain('private test input')
      const bundle = f.runtime.exportProject(f.project.id, 1, f.project.acceptedRevision, history, true)
      expect(bundle.version).toBe(2)
      const zip = createProjectZip(bundle), unpacked = unzipSync(zip)
      expect(Object.keys(unpacked)).toHaveLength(5)
      expect(JSON.parse(Buffer.from(unpacked['manifest.json']!).toString()).tests).toMatchObject({ mode: 'definitions-review-required', count: 1 })
      const { json } = await readProjectZip(zip), review = target.inspectProjectImport(json)
      expect(review.bundle).toEqual(bundle); expect(target.testCases()).toEqual([])
      const project = target.importProject(json, sha(json), 'local:importer'), summary = target.testCases()[0]!
      expect(summary.id).not.toBe(f.accepted.id); expect(summary.status).toBe('draft'); expect(summary.actor).toBe('local:importer')
      const imported = target.testCase(summary.id)
      expect(imported.definition).toEqual({ ...f.definition, project: { id: project.id, generation: project.generation, revision: project.acceptedRevision } })
      expect(imported.importedFrom).toEqual({ bundleSha256: sha(json), source: { id: f.accepted.id, generation: f.accepted.generation, sha256: f.accepted.sha256 },
        project: f.definition.project, status: 'accepted' })
      expect(target.list()).toEqual([])
      await expect(target.runTest({ id: imported.id, generation: 1, sha256: imported.sha256 }, randomUUID())).rejects.toHaveProperty('code', 'conflict')
      await target.close(); target = await LocalRuntime.open({ dataDirectory: targetPath })
      expect(target.testCase(imported.id)).toEqual(imported)
      const accepted = target.editTest({ operation: 'accept', id: imported.id, expectedGeneration: 1, reviewedSha256: imported.sha256, actor: 'local:reviewer' })
      expect(accepted.importedFrom).toEqual(imported.importedFrom)
      const run = await target.runTest({ id: accepted.id, generation: accepted.generation, sha256: accepted.sha256 }, randomUUID())
      expect(run.assessment).toBe('passed'); expect(run.run.output).toBe('private test input')
      const again = JSON.stringify(target.exportProject(project.id, project.generation, project.acceptedRevision, history, true))
      const reimported = f.runtime.importProject(again, sha(again), 'local:second')
      expect(f.runtime.testCases().filter(item => item.project.id === reimported.id)[0]!.status).toBe('draft')
    } finally { await f.runtime.close(); await target.close() }
  })

  it('includes latest definitions for the accepted revision, retaining original pins and reporting other-revision exclusions', async () => {
    const f = await fixture()
    try {
      const renamed = f.runtime.editProject({ operation: 'rename', id: f.project.id, expectedGeneration: 1, title: 'Renamed', actor: 'local:source' })
      const same = f.runtime.exportProject(renamed.id, renamed.generation, renamed.acceptedRevision, false, true)
      if (same.version !== 2) throw Error('Expected v2')
      expect(same.tests.cases[0]!.definition.project.generation).toBe(1)
      const proposed = f.runtime.editProject({ operation: 'propose', id: renamed.id, expectedGeneration: 2,
        yaml: source.replace('Standalone echo', 'Changed echo'), actor: 'local:source' })
      const proposal = proposed.proposals[0]!
      const changed = f.runtime.editProject({ operation: 'accept', id: renamed.id, expectedGeneration: 3,
        proposalId: proposal.id, reviewedRevision: proposal.revision, approvalChanges: [], actor: 'local:source' })
      const exported = f.runtime.exportProject(changed.id, changed.generation, changed.acceptedRevision, true, true)
      if (exported.version !== 2) throw Error('Expected v2')
      expect(exported.tests).toMatchObject({ cases: [], excludedOtherRevisions: 1 })
    } finally { await f.runtime.close() }
  })

  it('retains archived history and draft definitions without permitting acceptance or execution', async () => {
    const f = await fixture()
    try {
      const archived = f.runtime.editProject({ operation: 'archive', id: f.project.id, expectedGeneration: 1, archived: true, actor: 'local:source' })
      const json = JSON.stringify(f.runtime.exportProject(archived.id, 2, archived.acceptedRevision, true, true))
      const imported = f.runtime.importProject(json, sha(json), 'local:importer')
      expect(imported.archived).toBe(true)
      const test = f.runtime.testCase(f.runtime.testCases().find(item => item.project.id === imported.id)!.id)
      expect(() => f.runtime.editTest({ operation: 'accept', id: test.id, expectedGeneration: 1, reviewedSha256: test.sha256, actor: 'local:reviewer' })).toThrow(/archived/)
      expect(test.status).toBe('draft'); expect(f.runtime.list()).toEqual([])
    } finally { await f.runtime.close() }
  })

  it('rolls back the entire project and earlier cases when a later case insert fails', async () => {
    const f = await fixture(), targetPath = await mkdtemp(join(tmpdir(), 'jevable-case-rollback-'))
    const target = await LocalRuntime.open({ dataDirectory: targetPath }), db = new DatabaseSync(join(targetPath, 'runtime.sqlite'))
    try {
      f.runtime.editTest({ operation: 'create', actor: 'local:source', definition: { ...f.definition, title: 'Second case' } })
      const json = JSON.stringify(f.runtime.exportProject(f.project.id, 1, f.project.acceptedRevision, false, true))
      db.exec("CREATE TRIGGER fail_second_case BEFORE INSERT ON test_cases WHEN (SELECT count(*) FROM test_cases)=1 BEGIN SELECT RAISE(ABORT, 'fixture'); END;")
      expect(() => target.importProject(json, sha(json), 'local:importer')).toThrow()
      expect(target.projects()).toEqual([]); expect(target.testCases()).toEqual([]); expect(target.list()).toEqual([])
      db.exec('DROP TRIGGER fail_second_case')
      target.importProject(json, sha(json), 'local:importer')
      expect(target.testCases()).toHaveLength(2)
    } finally { db.close(); await f.runtime.close(); await target.close() }
  })

  it('rejects semantic corruption, mismatched pins/hashes, duplicate identities and oversized case sets before writes', async () => {
    const f = await fixture()
    try {
      const bundle = f.runtime.exportProject(f.project.id, 1, f.project.acceptedRevision, false, true)
      if (bundle.version !== 2) throw Error('Expected v2')
      const mutate = (fn: (b: Extract<typeof bundle, { version: 2 }>) => void) => {
        const copy = structuredClone(bundle); fn(copy); const json = JSON.stringify(copy)
        expect(() => f.runtime.inspectProjectImport(json)).toThrow()
        expect(() => f.runtime.importProject(json, sha(json), 'local:importer')).toThrow()
      }
      mutate(b => { b.tests.cases[0]!.source.sha256 = '0'.repeat(64) })
      mutate(b => { b.tests.cases[0]!.definition.project.id = randomUUID() })
      mutate(b => { b.tests.cases[0]!.definition.project.generation = 2 })
      mutate(b => { b.tests.cases.push(b.tests.cases[0]!) })
      mutate(b => { b.tests.cases = Array.from({ length: 1001 }, () => b.tests.cases[0]!) })
      mutate(b => { const item = b.tests.cases[0]!; item.definition.input = 42; item.source.sha256 = testHash(item.definition) })
      mutate(b => { const item = b.tests.cases[0]!; item.definition.expectations.push({ kind: 'node-visited', nodeId: 'missing' }); item.source.sha256 = testHash(item.definition) })
      expect(f.runtime.projects()).toHaveLength(1); expect(f.runtime.testCases()).toHaveLength(1)
    } finally { await f.runtime.close() }
  })

  it('checks v2 ZIP test counts and preserves strict v1 compatibility', async () => {
    const f = await fixture()
    try {
      const files = unzipSync(createProjectZip(f.runtime.exportProject(f.project.id, 1, f.project.acceptedRevision, false, true)))
      const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString()); manifest.tests.count = 0
      files['manifest.json'] = Buffer.from(JSON.stringify(manifest))
      await expect(readProjectZip(zipSync(files))).rejects.toHaveProperty('code', 'checksum-mismatch')
      const old = JSON.stringify(f.runtime.exportProject(f.project.id, 1, f.project.acceptedRevision))
      expect(f.runtime.inspectProjectImport(old).bundle.version).toBe(1)
      const incompatible = JSON.stringify({ ...JSON.parse(old), tests: { cases: [] } })
      expect(() => f.runtime.inspectProjectImport(incompatible)).toThrow()
    } finally { await f.runtime.close() }
  })

  it('verifies imported provenance on restart and migrates prior schema-10 state without rewriting cases', async () => {
    const f = await fixture(), original = f.runtime.testCase(f.accepted.id)
    const json = JSON.stringify(f.runtime.exportProject(f.project.id, 1, f.project.acceptedRevision, false, true))
    const project = f.runtime.importProject(json, sha(json), 'local:importer')
    const imported = f.runtime.testCases().find(item => item.project.id === project.id)!
    await f.runtime.close()
    const db = new DatabaseSync(join(f.path, 'runtime.sqlite')); db.exec('PRAGMA user_version=10'); db.close()
    const reopened = await LocalRuntime.open({ dataDirectory: f.path })
    expect(reopened.testCase(original.id)).toEqual(original); expect(reopened.testCase(imported.id).status).toBe('draft')
    await reopened.close()
    const corrupt = new DatabaseSync(join(f.path, 'runtime.sqlite'))
    const row = corrupt.prepare('SELECT record FROM test_cases WHERE id=?').get(imported.id) as { record: string }, record = JSON.parse(row.record)
    record.importedFrom.bundleSha256 = '0'.repeat(64)
    corrupt.prepare('UPDATE test_cases SET record=? WHERE id=?').run(JSON.stringify(record), imported.id); corrupt.close()
    await expect(LocalRuntime.open({ dataDirectory: f.path })).rejects.toHaveProperty('code', 'corrupt')
  })

  it('exports, inspects and imports private cases through explicit CLI --tests without running them', async () => {
    const f = await fixture(), target = await mkdtemp(join(tmpdir(), 'jevable-case-cli-')), zip = join(target, 'tests.zip')
    await f.runtime.close()
    const out = vi.fn(), err = vi.fn()
    expect(await main(['projects', 'export', f.project.id, '--expected-generation', '1', '--revision', f.project.acceptedRevision,
      '--tests', '--format', 'zip', '--output', zip, '--data-dir', f.path], { out, err })).toBe(0)
    expect(JSON.parse(out.mock.calls.at(-1)![0]).tests.included).toBe(1)
    expect(await main(['import', 'inspect', zip, '--data-dir', target], { out, err })).toBe(0)
    const receipt = JSON.parse(out.mock.calls.at(-1)![0])
    expect(receipt.review.tests.cases[0].definition.input).toBe('private test input')
    expect(await main(['import', 'project', zip, '--reviewed-sha256', receipt.artifactSha256, '--data-dir', target], { out, err })).toBe(0)
    expect(JSON.parse(out.mock.calls.at(-1)![0]).importedTests[0].status).toBe('draft')
    const runtime = await LocalRuntime.open({ dataDirectory: target })
    try { expect(runtime.list()).toEqual([]); expect(runtime.testCases()).toHaveLength(1) } finally { await runtime.close() }
  })
})
