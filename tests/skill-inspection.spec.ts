import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { mkdtemp, readdir, writeFile, open, symlink, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { unzipSync, zipSync } from 'fflate'
import { createAgentSkillZip } from '../src/management/skill-package.ts'
import * as inspection from '../src/management/skill-inspection.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { main } from '../src/cli.ts'

const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
async function fixture() {
  const runtime = Buffer.from('throw new Error("PRIVATE_NEVER_EXECUTE")\n')
  return createAgentSkillZip(async path => {
    const name = basename(path), role = name.startsWith('core') ? 'management' : name.includes('postgres') ? 'postgres' : 'sqlite'
    return name.endsWith('-runtime.mjs') ? runtime : name.endsWith('-runtime.json')
      ? Buffer.from(JSON.stringify({ schemaVersion: 1, coreVersion: CORE_VERSION, storage: role, external: 'node-builtins-only', sha256: hash(runtime), bytes: runtime.length }))
      : Buffer.from('PRIVATE_RESOURCE ' + name)
  })
}
const encode = (files: Record<string, Uint8Array>) => zipSync(files)
function changeJson(files: Record<string, Uint8Array>, path: string, update: (v: any) => void) {
  const v = JSON.parse(Buffer.from(files[path]!).toString()); update(v); files[path] = Buffer.from(JSON.stringify(v))
}
/** Repair the outer inventory only, so inner-manifest/runtime consistency checks cannot pass by checksums alone. */
function rehash(files: Record<string, Uint8Array>, path: string) {
  if (path !== 'jevable/runtime-manifest.json') {
    changeJson(files, 'jevable/runtime-manifest.json', v => {
      const f = v.files.find((f: any) => 'jevable/' + f.path === path)
      if (f) { f.bytes = files[path]!.length; f.sha256 = hash(files[path]!) }
    })
    rehash(files, 'jevable/runtime-manifest.json')
  }
  changeJson(files, 'jevable/manifest.json', v => {
    const f = v.files.find((f: any) => 'jevable/' + f.path === path)
    f.bytes = files[path]!.length; f.sha256 = hash(files[path]!)
  })
}
async function cli(args: string[]) {
  let out = '', err = ''; const code = await main(args, { out: v => { out += v }, err: v => { err += v } })
  return { code, out, err }
}
describe('offline agent skill inspection', () => {
  it('checks the exact exported inventory, nested manifest and all program bindings without displaying or executing resources', async () => {
    const f = await fixture(), result = await inspection.inspectAgentSkillZip(f.bytes, hash(f.bytes))
    expect(result).toMatchObject({ status: 'consistent', format: 'jevable.ai/agent-skill-zip', expectedChecksum: 'matched',
      artifact: { bytes: f.bytes.length, sha256: hash(f.bytes) }, files: f.manifest.files.length + 1,
      authenticity: 'not-verified', extraction: 'not-performed', installation: 'not-performed', execution: 'not-started-by-inspection' })
    expect(result.runtimes).toEqual(f.manifest.runtimes)
    expect(JSON.stringify(result)).not.toContain('PRIVATE_')
  })
  it('returns a detached report and explicitly distinguishes an absent trusted hash', async () => {
    const f = await fixture(), first = await inspection.inspectAgentSkillZip(f.bytes)
    first.runtimes[0]!.sha256 = '0'.repeat(64)
    const next = await inspection.inspectAgentSkillZip(f.bytes)
    expect(next.expectedChecksum).toBe('not-provided'); expect(next.runtimes).toEqual(f.manifest.runtimes)
  })
  it('captures input bytes before asynchronous reading instead of inspecting later caller mutations', async () => {
    const f = await fixture(), original = hash(f.bytes), promise = inspection.inspectAgentSkillZip(f.bytes)
    f.bytes.fill(0)
    expect((await promise).artifact.sha256).toBe(original)
  })
  it('refuses a mismatched trusted archive hash before ZIP parsing', async () => {
    await expect(inspection.inspectAgentSkillZip(Buffer.from('not a zip'), '0'.repeat(64))).rejects.toMatchObject({ code: 'conflict' })
  })
  it.each(['UPPERCASE', '', 'f'.repeat(63)])('refuses malformed trusted hashes (%s)', async value => {
    await expect(inspection.inspectAgentSkillZip(Buffer.alloc(0), value)).rejects.toMatchObject({ code: 'invalid-command' })
  })
  it.each(['missing', 'extra', 'changed', 'duplicate-declaration', 'wrong-root', 'unknown-manifest-field'])('refuses %s inventories', async kind => {
    const f = await fixture(), files = unzipSync(f.bytes)
    if (kind === 'missing') delete files['jevable/SKILL.md']
    if (kind === 'extra') files['jevable/private-token'] = Buffer.from('PRIVATE_SECRET')
    if (kind === 'changed') files['jevable/SKILL.md'] = Buffer.from('changed')
    if (kind === 'duplicate-declaration') changeJson(files, 'jevable/manifest.json', v => { v.files[1] = v.files[0] })
    if (kind === 'wrong-root') changeJson(files, 'jevable/manifest.json', v => { v.root = 'other' })
    if (kind === 'unknown-manifest-field') changeJson(files, 'jevable/manifest.json', v => { v.token = 'PRIVATE_SECRET' })
    // The maximum supported inventory now includes three explicitly selected profile assets.
    // An unknown schema-1 member below that ceiling is corrupt, not oversized.
    await expect(inspection.inspectAgentSkillZip(encode(files))).rejects.toMatchObject({ code: 'corrupt' })
  })
  it.each(['inner-files', 'inner-runtime', 'inner-version', 'program-metadata', 'program-role', 'resource-limit'])('refuses self-consistent outer checksums with inconsistent %s', async kind => {
    const f = await fixture(), files = unzipSync(f.bytes)
    let path = 'jevable/runtime-manifest.json'
    if (kind === 'inner-files') changeJson(files, path, v => { v.files.pop() })
    if (kind === 'inner-runtime') changeJson(files, path, v => { v.runtimes[0].sha256 = '0'.repeat(64) })
    if (kind === 'inner-version') changeJson(files, path, v => { v.version = 'other' })
    if (kind === 'program-metadata' || kind === 'program-role') {
      path = 'jevable/dist/management/core-runtime.json'
      changeJson(files, path, v => { if (kind === 'program-metadata') v.sha256 = '0'.repeat(64); else v.storage = 'sqlite' })
    }
    if (kind === 'resource-limit') { path = 'jevable/SKILL.md'; files[path] = Buffer.alloc(4_000_001) }
    rehash(files, path)
    await expect(inspection.inspectAgentSkillZip(encode(files))).rejects.toMatchObject({ code: kind === 'resource-limit' ? 'limit' : 'corrupt' })
  })
  it.each([['../escape'], ['/absolute'], ['jevable/../escape'], ['jevable\\SKILL.md']])('refuses unsafe archive path %s', async path => {
    const f = await fixture(), files = unzipSync(f.bytes); delete files['jevable/README.md']; files[path!] = Buffer.from('not written')
    await expect(inspection.inspectAgentSkillZip(encode(files))).rejects.toMatchObject({ code: 'corrupt' })
  })
  it('supports actual CLI inspection without creating a state directory or extracting the archive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-skill-inspection-')), path = join(directory, 'skill.zip'), f = await fixture()
    await writeFile(path, f.bytes)
    const r = await cli(['skill', 'inspect', path, '--sha256', hash(f.bytes), '--json'])
    expect(r.code).toBe(0); expect(JSON.parse(r.out).expectedChecksum).toBe('matched'); expect(r.err).toBe('')
    expect(await readdir(directory)).toEqual(['skill.zip'])
  })
  it.skipIf(process.platform === 'win32')('refuses a FIFO before a writer connects, without leaving the old read pending', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-inspection-fifo-')), fifo = join(directory, 'input.fifo')
    await promisify(execFile)('mkfifo', [fifo])
    const pending = cli(['skill', 'inspect', fifo]), timeout = { handle: undefined as ReturnType<typeof setTimeout> | undefined }
    const observation = await Promise.race([
      pending.then(result => ({ beforeWriter: true, result })),
      new Promise<{ beforeWriter: false; result?: undefined }>(resolve => { timeout.handle = setTimeout(() => resolve({ beforeWriter: false }), 1000) }),
    ])
    if (timeout.handle) clearTimeout(timeout.handle)
    // Drain the deliberately broken implementation during a failing-before run; never kill a process or leave a FIFO read pending.
    if (!observation.beforeWriter) { const writer = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK); await writer.close(); await pending }
    expect(observation.beforeWriter).toBe(true)
    expect(observation.result?.code).toBe(1); expect(observation.result?.out).toBe('')
    expect(await readdir(directory)).toEqual(['input.fifo'])
  })
  it.skipIf(process.platform === 'win32')('refuses a final archive symlink without modifying or executing its valid target', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-inspection-alias-')), f = await fixture()
    const original = join(directory, 'original.zip'), alias = join(directory, 'alias.zip')
    await writeFile(original, f.bytes); await symlink(original, alias)
    const refused = await cli(['skill', 'inspect', alias])
    expect(refused.code).toBe(1); expect(refused.out).toBe('')
    expect(await readFile(original)).toEqual(f.bytes)
    expect((await cli(['skill', 'inspect', original])).code).toBe(0)
    expect((await readdir(directory)).sort()).toEqual(['alias.zip', 'original.zip'])
  })
  it.each([['--data-dir', '/must-not-open'], ['--endpoint', 'https://not-contacted.invalid'], ['--token-file', '/must-not-read'],
    ['--runtime', 'docker'], ['--output', '/not-written'], ['--sha256', 'INVALID'], ['extra']].map(flags => ({ flags })))('refuses unsupported/malformed options before file reads ($flags)', async ({ flags }) => {
    const r = await cli(['skill', 'inspect', '/does-not-exist', ...flags])
    expect(r.code).toBe(2); expect(r.out).toBe(''); expect(r.err).not.toContain('ENOENT')
  })
})
