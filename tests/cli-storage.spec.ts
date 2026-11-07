import { expect, it } from 'vitest'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { main } from '../src/cli.ts'
import { writeArtifact } from '../src/files.ts'
import { importedOperationTests, type CliOperations } from '../src/cli/operations.ts'

async function cli(args: string[]) {
  let out = '', err = ''
  const code = await main(args, { out: value => { out += value }, err: value => { err += value } })
  return { code, out, err, value: out ? JSON.parse(out) : undefined }
}
it.each([['runs', 'list', '--page'], ['projects', 'list'], ['tests', 'list', '--page'],
  ['releases', 'list', '--page'], ['providers', 'list'], ['credentials', 'status', 'fixture/key']].map(command => ({ command })))('direct backend validates private config before networking: $command', async ({ command }) => {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-cli-storage-')), config = join(directory, 'database.json')
  await writeArtifact(config, JSON.stringify({ host: 'uncontacted.invalid', port: 5432, database: 'fixture', user: 'fixture',
    password: 'PRIVATE_PASSWORD', namespace: 'fixture', initialize: false, tls: { mode: 'loopback-test' } }))
  const result = await cli([...command, '--storage', 'postgres', '--database-file', config])
  expect(result.code).toBe(1); expect(JSON.parse(result.err).code).toBe('invalid-config')
  expect(result.err).not.toContain('PRIVATE_PASSWORD'); expect(result.err).not.toContain('uncontacted.invalid'); expect(result.out).toBe('')
})
it.each([['runs', 'list'], ['tests', 'generations'], ['projects', 'deletions'], ['providers', 'audit'], ['releases', 'list'],
  ['runs', 'list', '--page', '--after', 'invalid'], ['providers', 'audit', '--page', '--after', '90071992547409920000'],
  ['tests', 'list', '--page', '--limit', '201'], ['runs', 'list', '--page', '--limit', '1e2'],
  ['releases', 'export', randomUUID()], ['releases', 'build-image', randomUUID()]].map(command => ({ command })))('refuses missing pagination or unsupported modes before opening storage: $command', async ({ command }) => {
  const result = await cli([...command, '--storage', 'postgres', '--database-file', '/must-not-be-read'])
  expect(result.code).toBe(2); expect(JSON.parse(result.err).code).toBe('invalid-input'); expect(result.out).toBe('')
})
it('rejects mixed selection before creating a SQLite directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-cli-storage-')), data = join(directory, 'must-not-exist')
  const result = await cli(['projects', 'list', '--storage', 'postgres', '--database-file', '/must-not-be-read', '--data-dir', data])
  expect(result.code).toBe(2); await expect(stat(data)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('preserves SQLite unpaged receipts and explicitly pages retained run identities', async () => {
  const data = await mkdtemp(join(tmpdir(), 'jevable-cli-pages-')), flags = ['--storage', 'sqlite', '--data-dir', data]
  const ids = [randomUUID(), randomUUID(), randomUUID()].sort()
  for (const id of ids) expect((await cli(['run', 'examples/echo.yaml', '--input', 'examples/echo-input.json', '--id', id, ...flags])).code).toBe(0)
  const legacy = await cli(['runs', 'list', ...flags]); expect(legacy.value.schemaVersion).toBe(1); expect(legacy.value.runs).toHaveLength(3)
  const first = await cli(['runs', 'list', '--page', '--limit', '2', ...flags])
  expect(first.value.schemaVersion).toBe(2); expect(first.value.runs.map((r: { id: string }) => r.id)).toEqual(ids.slice(0, 2))
  const last = await cli(['runs', 'list', '--page', '--after', first.value.nextCursor, ...flags])
  expect(last.value.runs.map((r: { id: string }) => r.id)).toEqual(ids.slice(2)); expect(last.value.nextCursor).toBeNull()
  expect((await cli(['runs', 'list', '--limit', '1', ...flags])).code).toBe(2)
})
it('collects imported draft receipts beyond the first page without including another project or private definitions', async () => {
  const projectId = randomUUID(), after = randomUUID(), imported = randomUUID(), calls: unknown[] = []
  const owner: CliOperations = { storage: 'postgres', async call(command) {
    if (command.operation !== 'tests.list') throw Error('Unexpected operation')
    calls.push(command)
    const identity = { generation: 1, status: 'draft', sha256: 'a'.repeat(64) }
    return command.page?.after === undefined
      ? { schemaVersion: 2, tests: [{ ...identity, id: randomUUID(), project: { id: randomUUID() }, input: 'PRIVATE' }], nextCursor: after }
      : { schemaVersion: 2, tests: [{ ...identity, id: imported, project: { id: projectId }, input: 'PRIVATE' }], nextCursor: null }
  }, async close() {} }
  expect(await importedOperationTests(owner, projectId)).toEqual([{ id: imported, generation: 1, status: 'draft', sha256: 'a'.repeat(64) }])
  expect(calls).toEqual([{ operation: 'tests.list', page: { limit: 200 } }, { operation: 'tests.list', page: { after, limit: 200 } }])
})
it('refuses a non-advancing import receipt cursor instead of looping or returning a partial success', async () => {
  const cursor = randomUUID(), owner: CliOperations = { storage: 'postgres', async call() { return { schemaVersion: 2, tests: [], nextCursor: cursor } }, async close() {} }
  await expect(importedOperationTests(owner, randomUUID())).rejects.toMatchObject({ code: 'invalid-response' })
})
