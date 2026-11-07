import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { unzipSync } from 'fflate'
import { createManagementZip, MANAGEMENT_PACKAGE_FILES } from '../src/management/package.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { main } from '../src/cli.ts'

const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
function fixture(change?: (name: string, value: Buffer) => Buffer) {
  const paths: string[] = [], runtime = Buffer.from('export const fixture = true\n')
  return { paths, read: async (path: string, limit: number) => {
    paths.push(path)
    const name = basename(path), role = name.startsWith('core') ? 'management' : name.includes('postgres') ? 'postgres' : 'sqlite'
    const value = name.endsWith('.mjs') ? runtime : name.endsWith('.txt') ? Buffer.from('fixture license notice')
      : Buffer.from(JSON.stringify({ schemaVersion: 1, coreVersion: CORE_VERSION, storage: role, external: 'node-builtins-only', sha256: hash(runtime), bytes: runtime.length }))
    expect(limit).toBeGreaterThan(value.length)
    return change ? change(name, value) : value
  } }
}
describe('standalone management distribution', () => {
  it('packs only explicit assets, verifies identities and hashes every distributed file', async () => {
    const io = fixture(), result = await createManagementZip(io.read), archive = unzipSync(result.bytes)
    expect(Object.keys(archive).sort()).toEqual([...MANAGEMENT_PACKAGE_FILES, 'manifest.json'].sort())
    expect(io.paths).toHaveLength(9)
    expect(new Set(io.paths).size).toBe(9)
    expect(result.manifest.runtimes.map(item => item.role)).toEqual(['management', 'sqlite', 'postgres'])
    expect(result.manifest.requires.npmInstall).toBe(false)
    for (const file of result.manifest.files) {
      expect(archive[file.path]!.length).toBe(file.bytes)
      expect(hash(archive[file.path]!)).toBe(file.sha256)
    }
    expect(JSON.parse(Buffer.from(archive['manifest.json']!).toString())).toEqual(result.manifest)
    expect(await createManagementZip(fixture().read)).toEqual(result)
  })
  it.each(['sha256', 'bytes', 'storage', 'external', 'schemaVersion', 'coreVersion'])('rejects inconsistent %s before publishing', async field => {
    const io = fixture((name, bytes) => {
      if (name !== 'core-runtime.json') return bytes
      const value = JSON.parse(bytes.toString()); value[field] = 'invalid'; return Buffer.from(JSON.stringify(value))
    })
    await expect(createManagementZip(io.read)).rejects.toMatchObject({ code: 'corrupt' })
  })
  it.each(['null', 'malformed', '[]'])('rejects %s metadata', async metadata => {
    const io = fixture((name, bytes) => name === 'core-runtime.json' ? Buffer.from(metadata) : bytes)
    await expect(createManagementZip(io.read)).rejects.toMatchObject({ code: 'corrupt' })
  })
  it('rejects missing notices and altered runtime bytes', async () => {
    for (const target of ['core-NOTICES.txt', 'release-runtime.mjs', 'release-postgres-runtime.mjs']) {
      const io = fixture((name, bytes) => name === target ? Buffer.alloc(0) : bytes)
      await expect(createManagementZip(io.read)).rejects.toMatchObject({ code: 'corrupt' })
    }
  })
  it.each([[], ['--data-dir', '/must-not-open'], ['--storage', 'postgres'], ['--format', 'yaml'], ['--token-file', '/must-not-read']].map(flags => ({ flags })))('rejects incomplete/mixed CLI export flags $flags', async ({ flags }) => {
    let stderr = ''
    const code = await main(['runtime', 'export', ...flags], { out: () => { throw Error('unexpected output') }, err: value => { stderr += value } })
    expect(code).toBe(2)
    expect(JSON.parse(stderr).code).toBe('invalid-input')
  })
})
