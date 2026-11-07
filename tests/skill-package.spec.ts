import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { basename, posix, relative, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import { createAgentSkillZip, AGENT_SKILL_RESOURCES, AGENT_SKILL_PACKAGE_LIMITS } from '../src/management/skill-package.ts'
import { MANAGEMENT_PACKAGE_FILES } from '../src/management/package.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { main } from '../src/cli.ts'

const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
function fixture(change?: (name: string, bytes: Buffer) => Buffer) {
  const paths: string[] = [], runtime = Buffer.from('export const fixture = true\n')
  return { paths, read: async (path: string) => {
    paths.push(path)
    const name = basename(path), role = name.startsWith('core') ? 'management' : name.includes('postgres') ? 'postgres' : 'sqlite'
    const bytes = name.endsWith('-runtime.mjs') ? runtime : name.endsWith('-runtime.json')
      ? Buffer.from(JSON.stringify({ schemaVersion: 1, coreVersion: CORE_VERSION, storage: role, external: 'node-builtins-only', sha256: hash(runtime), bytes: runtime.length }))
      : Buffer.from('public fixture resource ' + name)
    return change ? change(name, bytes) : bytes
  } }
}
describe('standalone agent skill distribution', () => {
  it.each(['assets/full-delivery.gif', 'assets/saved-tests-approval.gif', 'assets/import-preview.gif', 'assets/import-to-app.gif', 'assets/support-triage.gif'] as const)
  ('ships the curated %s by explicit path and checksum, without private evidence', async demo => {
    const io = fixture(), bytes = await readFile(new URL('../' + demo, import.meta.url))
    const result = await createAgentSkillZip(path => path.endsWith('/' + demo) ? Promise.resolve(bytes) : io.read(path))
    const archive = unzipSync(result.bytes)
    expect(bytes.subarray(0, 6).toString()).toBe('GIF89a')
    expect(AGENT_SKILL_RESOURCES.filter(name => name === demo)).toHaveLength(1)
    expect(Buffer.from(archive['jevable/' + demo]!)).toEqual(bytes)
    expect(result.manifest.files.find(file => file.path === demo)).toEqual({ path: demo, bytes: bytes.length, sha256: hash(bytes) })
    const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(metadata.files).toContain(demo)
    expect(Object.keys(archive).some(name => name.includes('.qualification/') || name.endsWith('-dom.txt'))).toBe(false)
    const { zipSync } = await import('fflate')
    const { inspectAgentSkillZip } = await import('../src/management/skill-inspection.ts')
    expect(await inspectAgentSkillZip(result.bytes, hash(result.bytes))).toMatchObject({ status: 'consistent', execution: 'not-started-by-inspection' })
    const altered = { ...archive, ['jevable/' + demo]: Uint8Array.from([...bytes.slice(0, -1), bytes[bytes.length - 1]! ^ 1]) }
    await expect(inspectAgentSkillZip(zipSync(altered))).rejects.toMatchObject({ code: 'corrupt' })
  }, 30_000)
  it('includes only an empty public environment template, never local environment files', async () => {
    const io = fixture(), template = await readFile(new URL('../.env.example', import.meta.url))
    const result = await createAgentSkillZip(path => basename(path) === '.env.example' ? Promise.resolve(template) : io.read(path))
    const archive = unzipSync(result.bytes)
    expect(AGENT_SKILL_RESOURCES.filter(name => name === '.env.example')).toHaveLength(1)
    expect(Buffer.from(archive['jevable/.env.example']!)).toEqual(template)
    expect(template.toString('utf8').split('\n').filter(line => line && !line.startsWith('#'))).toEqual(['JEVABLE_PREVIEW_TOKEN='])
    expect(Object.keys(archive).filter(name => /(?:^|\/)\.env(?:\.|$)/u.test(name))).toEqual(['jevable/.env.example'])
    const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(metadata.files).toContain('.env.example')
    expect(metadata.files).not.toContain('.env')
  })
  it('ships every package-local link in the actual public instructions and Markdown guides, not just listed fixture names', async () => {
    const io = fixture(), root = fileURLToPath(new URL('../', import.meta.url))
    const result = await createAgentSkillZip(async path => {
      const name = relative(root, path).split('\\').join('/')
      return name.endsWith('.md') && (AGENT_SKILL_RESOURCES as readonly string[]).includes(name) ? readFile(path) : io.read(path)
    })
    const archive = unzipSync(result.bytes)
    expect(AGENT_SKILL_RESOURCES.filter(name => name === 'references/account.md')).toHaveLength(1)
    expect(Buffer.from(archive['jevable/references/account.md']!)).toEqual(await readFile(resolve(root, 'references/account.md')))
    const routes = new Map<string, string[]>()
    for (const name of AGENT_SKILL_RESOURCES.filter(name => name.endsWith('.md'))) {
      const destinations: string[] = []
      const text = Buffer.from(archive['jevable/' + name]!).toString('utf8')
      for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
        const target = match[1]!.trim().replace(/^<|>$/gu, '').split(/\s+["']/u)[0]!
        if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue
        const path = decodeURIComponent(target.split(/[?#]/u)[0]!)
        if (!path) continue
        const packaged = posix.normalize(posix.join(posix.dirname(name), path))
        expect(packaged.startsWith('../') || resolve(root, packaged) === root, `${name}: ${target}`).toBe(false)
        expect(Object.hasOwn(archive, 'jevable/' + packaged), `${name}: missing packaged link ${target}`).toBe(true)
        destinations.push(packaged)
      }
      routes.set(name, destinations)
    }
    const reachable = new Set(['SKILL.md']), pending = ['SKILL.md']
    while (pending.length) {
      for (const destination of routes.get(pending.pop()!) ?? []) {
        if (!reachable.has(destination)) { reachable.add(destination); pending.push(destination) }
      }
    }
    for (const guide of AGENT_SKILL_RESOURCES.filter(name => name.startsWith('references/') && name.endsWith('.md'))) {
      expect(reachable.has(guide), `Public guide has no route from SKILL.md: ${guide}`).toBe(true)
    }
  })
  it('hashes only the fixed public resources and owned management program under one skill root', async () => {
    const io = fixture(), result = await createAgentSkillZip(io.read), archive = unzipSync(result.bytes)
    expect(Object.keys(archive).sort()).toEqual([...MANAGEMENT_PACKAGE_FILES, ...AGENT_SKILL_RESOURCES,
      'runtime-manifest.json', 'manifest.json'].map(name => 'jevable/' + name).sort())
    expect(io.paths).toHaveLength(9 + AGENT_SKILL_RESOURCES.length)
    expect(new Set(io.paths).size).toBe(io.paths.length)
    expect(result.manifest).toMatchObject({ format: 'jevable.ai/agent-skill-zip', root: 'jevable', installation: 'not-performed',
      state: 'excluded', credentials: 'excluded', requires: { npmInstall: false, docker: false } })
    for (const file of result.manifest.files) {
      expect(archive['jevable/' + file.path]!.byteLength).toBe(file.bytes)
      expect(hash(archive['jevable/' + file.path]!)).toBe(file.sha256)
    }
    expect(JSON.parse(Buffer.from(archive['jevable/manifest.json']!).toString())).toEqual(result.manifest)
    expect(JSON.parse(Buffer.from(archive['jevable/runtime-manifest.json']!).toString()).format).toBe('jevable.ai/management-zip')
    expect(Object.keys(archive).some(name => /(?:^|\/)(?:node_modules|src|scripts|qualification|\.jevable)(?:\/|$)|(?:plan|todo)\.md/u.test(name))).toBe(false)
    expect(await createAgentSkillZip(fixture().read)).toEqual(result)
  })
  it('refuses a missing public resource rather than delivering a partial skill', async () => {
    const io = fixture()
    await expect(createAgentSkillZip(async path => {
      if (basename(path) === 'SKILL.md') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return io.read(path)
    })).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each([0, AGENT_SKILL_PACKAGE_LIMITS.resourceBytes + 1])('refuses an empty/oversized resource (%s bytes)', async bytes => {
    await expect(createAgentSkillZip(fixture((name, value) => name === 'SKILL.md' ? Buffer.alloc(bytes) : value).read))
      .rejects.toMatchObject({ code: 'limit' })
  })
  it('enforces the aggregate byte limit with individually bounded resources', async () => {
    const big = Buffer.alloc(AGENT_SKILL_PACKAGE_LIMITS.resourceBytes)
    await expect(createAgentSkillZip(fixture((name, value) => name.endsWith('-runtime.mjs') || name.endsWith('-runtime.json') || name.endsWith('-NOTICES.txt') ? value : big).read))
      .rejects.toMatchObject({ code: 'limit' })
  })
  it('refuses corrupt owned program bytes', async () => {
    await expect(createAgentSkillZip(fixture((name, value) => name === 'core-runtime.mjs' ? Buffer.from('altered') : value).read))
      .rejects.toMatchObject({ code: 'corrupt' })
  })
  it.each([[], ['--data-dir', '/must-not-open'], ['--storage', 'postgres'], ['--endpoint', 'https://not-contacted.invalid'],
    ['--token-file', '/must-not-read'], ['--output', '/not-written.zip', '--runtime', 'docker'], ['--output', '/not-written.zip', 'extra']].map(flags => ({ flags })))
    ('refuses incomplete/mixed CLI packaging flags $flags before any artifact write', async ({ flags }) => {
      let stderr = ''
      const code = await main(['skill', 'export', ...flags], { out: () => { throw Error('unexpected output') }, err: value => { stderr += value } })
      expect(code).toBe(2); expect(JSON.parse(stderr).code).toBe('invalid-input')
    })
})
