import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { AGENT_SKILL_RESOURCES } from '../src/management/skill-resources.ts'

const packaged = new Set<string>(AGENT_SKILL_RESOURCES)
// Entry documents a reader lands on first; each of their local links must resolve inside the skill ZIP.
const entryDocuments = ['README.md', 'README.zh-TW.md', 'SKILL.md', 'docs/request-review-demo.md', 'references/skill-package.md']

function localTargets(markdown: string): string[] {
  const targets: string[] = []
  for (const match of markdown.matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
    const target = match[1]!
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue
    targets.push(decodeURIComponent(target.split('#')[0]!.split('?')[0]!))
  }
  return targets
}

describe('packaged entry documentation', () => {
  it('ships the Traditional Chinese README and the request-review runbook', () => {
    expect(AGENT_SKILL_RESOURCES).toContain('README.zh-TW.md')
    expect(AGENT_SKILL_RESOURCES).toContain('docs/request-review-demo.md')
    expect(AGENT_SKILL_RESOURCES).not.toContain('README.zh-CN.md')
  })

  it.each(entryDocuments)('%s links only to files that are packaged in the skill ZIP', async document => {
    expect(packaged.has(document)).toBe(true)
    const markdown = await readFile(new URL(`../${document}`, import.meta.url), 'utf8')
    const missing = localTargets(markdown)
      .map(target => posix.normalize(posix.join(posix.dirname(document), target)))
      .filter(path => !packaged.has(path))
    expect(missing).toEqual([])
  })
})
