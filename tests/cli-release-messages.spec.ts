import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { main } from '../src/cli.ts'
import { releaseMessageRunId, releaseMessageIdentitySchema } from '../src/releases/index.ts'
import * as files from '../src/files.ts'
import * as operations from '../src/cli/operations.ts'

afterEach(() => vi.restoreAllMocks())
async function cli(argv: string[]) {
  let out = '', err = ''
  const code = await main([...argv, '--json'], { out: value => { out += value }, err: value => { err += value } })
  return { code, out, err, result: out ? JSON.parse(out) : undefined }
}
const identity = { release: { id: '11111111-1111-4111-8111-111111111111', sha256: 'a'.repeat(64), revision: 'b'.repeat(64) },
  source: 'orders/PRIVATE_NAMESPACE', messageId: 'PRIVATE_MESSAGE_ID' }
async function file(content: string | Buffer) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-message-cli-')), path = join(directory, 'identity.json')
  await writeFile(path, content, { mode: 0o600, flag: 'wx' })
  return path
}
describe('offline CLI released-message identity', () => {
  it('derives the SDK identity without runtime acquisition, execution, writes or identity disclosure', async () => {
    const owner = vi.spyOn(operations, 'openCliOperations').mockImplementation(async () => { throw Error('Unexpected owner') })
    const publication = vi.spyOn(files, 'writeArtifact').mockImplementation(async () => { throw Error('Unexpected write') })
    const path = await file(JSON.stringify(identity)), before = await files.readBoundedRegularBytes(path, 4096)
    const result = await cli(['releases', 'message-id', path])
    expect(result.code).toBe(0); expect(result.err).toBe('')
    expect(result.result).toEqual({ schemaVersion: 1, format: 'jevable.ai/release-message-id', runId: releaseMessageRunId(identity),
      execution: 'not-run', authentication: 'not-verified' })
    expect(result.out).not.toMatch(/PRIVATE_|sha256|revision/u)
    expect(await files.readBoundedRegularBytes(path, 4096)).toEqual(before)
    expect(owner).not.toHaveBeenCalled(); expect(publication).not.toHaveBeenCalled()
  })
  it.each(['--data-dir', '--endpoint', '--token-file', '--runtime', '--input', '--output', '--source', '--message-id'])('rejects unrelated %s before reading any private input', async option => {
    const read = vi.spyOn(files, 'readBoundedRegularBytes').mockImplementation(async () => { throw Error('Unexpected read') })
    const result = await cli(['releases', 'message-id', 'PRIVATE_NEVER_READ', option, 'PRIVATE_NEVER_USED'])
    expect(result.code).toBe(2); expect(result.out).toBe(''); expect(result.err).not.toContain('PRIVATE_')
    expect(read).not.toHaveBeenCalled()
  })
  it('refuses missing/extra positions before file I/O', async () => {
    const read = vi.spyOn(files, 'readBoundedRegularBytes').mockImplementation(async () => { throw Error('Unexpected read') })
    for (const argv of [['releases', 'message-id'], ['releases', 'message-id', 'PRIVATE_A', 'PRIVATE_B']]) {
      const result = await cli(argv)
      expect(result.code).toBe(2); expect(result.out).toBe(''); expect(result.err).not.toContain('PRIVATE_')
    }
    expect(read).not.toHaveBeenCalled()
  })
  it('refuses malformed JSON, invalid UTF-8, oversized input, missing input and final symlinks', async () => {
    const path = await file(JSON.stringify(identity)), linked = path + '.link'
    await symlink(path, linked)
    for (const invalid of [linked, path + '.missing', await file('{"PRIVATE_INVALID":'), await file(Buffer.from([0xc0, 0xaf])),
      await file(' '.repeat(4097)), await file(JSON.stringify({ ...identity, extra: 'PRIVATE_UNKNOWN' }))]) {
      const result = await cli(['releases', 'message-id', invalid])
      expect(result.code).not.toBe(0); expect(result.out).toBe(''); expect(result.err).not.toContain('PRIVATE_')
    }
  })
  it('derives only from reviewed pins; it never claims the release exists or sender is authorized', async () => {
    const result = await cli(['releases', 'message-id', await file(JSON.stringify(identity))])
    expect(result.result.authentication).toBe('not-verified'); expect(result.result.execution).toBe('not-run')
    expect((await cli(['releases', 'message-id', await file(JSON.stringify({ ...identity, input: 'PRIVATE_INPUT' }))])).code).not.toBe(0)
  })
  it('publishes consuming grammar/schema help with no file or owner I/O', async () => {
    const read = vi.spyOn(files, 'readBoundedRegularBytes').mockImplementation(async () => { throw Error('Unexpected read') })
    const result = await cli(['help', 'releases', 'message-id'])
    expect(result.code).toBe(0); expect(result.result.references).toEqual(['references/release-messages.md'])
    expect(result.result.variants[0]).toMatchObject({ positionalCount: 1, options: { json: 'boolean' } })
    expect(Object.keys(result.result.variants[0].options)).toEqual(['json'])
    const contract = result.result.inputContracts[0]
    expect(contract.id).toBe('release-message-identity')
    expect(contract.sha256).toBe(createHash('sha256').update(JSON.stringify(contract.schema)).digest('hex'))
    const validate = new Ajv2020().addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu).compile(contract.schema)
    for (const value of [identity, { ...identity, source: ' invalid' }, { ...identity, messageId: 'x'.repeat(257) },
      { ...identity, release: { ...identity.release, revision: 'A'.repeat(64) } }, { ...identity, extra: true }]) {
      expect(Boolean(validate(value))).toBe(releaseMessageIdentitySchema.safeParse(value).success)
    }
    expect(read).not.toHaveBeenCalled()
  })
})
