import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { parseDocument } from 'yaml'
import { unzipSync } from 'fflate'
import { createAgentSkillZip, AGENT_SKILL_RESOURCES } from '../src/management/skill-package.ts'
import { MANAGEMENT_PACKAGE_FILES } from '../src/management/package.ts'
import { CORE_VERSION } from '../src/capabilities.ts'

const asset = new URL('../agents/openai.yaml', import.meta.url)
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

describe('optional desktop-agent skill interface', () => {
  it('parses the actual interface and preserves normal discovery without requiring host tools', async () => {
    const document = parseDocument(await readFile(asset, 'utf8'), { uniqueKeys: true })
    expect(document.errors).toEqual([]); expect(document.warnings).toEqual([])
    const metadata = document.toJS({ maxAliasCount: 0 })
    expect(Object.keys(metadata)).toEqual(['interface'])
    expect(Object.keys(metadata.interface).sort()).toEqual(['default_prompt', 'display_name', 'short_description'])
    expect(metadata.interface.display_name).toBe('Jevable')
    expect(metadata.interface.short_description.length).toBeGreaterThanOrEqual(25)
    expect(metadata.interface.short_description.length).toBeLessThanOrEqual(64)
    const instructions = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8')
    const frontmatter = parseDocument(instructions.split('---')[1]!).toJS()
    expect(metadata.interface.default_prompt).toContain('$' + frontmatter.name)
    expect(metadata).not.toHaveProperty('dependencies')
    expect(metadata).not.toHaveProperty('policy')
  })

  it('packages actual interface bytes once, hashes them and excludes them from runtime-only inventory', async () => {
    const bytes = await readFile(asset), runtime = Buffer.from('export const fixture = true\n')
    const result = await createAgentSkillZip(async path => {
      const name = basename(path)
      if (name === 'openai.yaml') return bytes
      if (name.endsWith('-runtime.mjs')) return runtime
      if (name.endsWith('-runtime.json')) return Buffer.from(JSON.stringify({ schemaVersion: 1,
        coreVersion: CORE_VERSION, storage: name.startsWith('core') ? 'management' : name.includes('postgres') ? 'postgres' : 'sqlite',
        external: 'node-builtins-only', sha256: hash(runtime), bytes: runtime.length }))
      return Buffer.from('public fixture resource ' + name)
    })
    const archive = unzipSync(result.bytes), name = 'agents/openai.yaml'
    expect(Buffer.from(archive['jevable/' + name]!)).toEqual(bytes)
    expect(result.manifest.files.filter(file => file.path === name)).toEqual([{ path: name, bytes: bytes.length, sha256: hash(bytes) }])
    expect(AGENT_SKILL_RESOURCES.filter(resource => resource === name)).toHaveLength(1)
    expect(MANAGEMENT_PACKAGE_FILES.some(path => path.startsWith('agents/'))).toBe(false)
  })
})
