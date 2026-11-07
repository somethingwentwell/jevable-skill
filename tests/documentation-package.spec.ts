import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { inspectDocumentationLinks } = await import(new URL('../scripts/check-documentation-package.mjs', import.meta.url).href)
let directory: string

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'jevable-documentation-')))
  await mkdir(join(directory, 'docs'))
  await writeFile(join(directory, 'asset.json'), '{}')
  await writeFile(join(directory, 'image with space.png'), 'fixture')
})
afterEach(async () => { await rm(directory, { recursive: true }) })

describe('installed documentation link admission', () => {
  it('resolves images, relative parents, fragments, queries, titles and encoded or angle-bracket paths', async () => {
    await writeFile(join(directory, 'docs', 'guide.md'), '[source](../asset.json#node) [title](../asset.json "Source")\n'
      + '![image](../image%20with%20space.png?theme=light) [spaced](<../image with space.png>)')
    expect(await inspectDocumentationLinks(directory, 'docs/guide.md')).toEqual([
      join(directory, 'asset.json'), join(directory, 'asset.json'), join(directory, 'image with space.png'), join(directory, 'image with space.png')])
  })
  it('does not follow external links, data URLs, anchors, future GIF comments or fenced code examples', async () => {
    await writeFile(join(directory, 'README.md'), '[remote](https://example.invalid/no-network) [anchor](#here) [data](data:image/png;base64,AA)\n'
      + '<!-- ![future](assets/demo.gif) -->\n```md\n[example](missing.md)\n```\n')
    expect(await inspectDocumentationLinks(directory, 'README.md')).toEqual([])
  })
  it('refuses a missing local target instead of treating source-tree existence as installed evidence', async () => {
    await writeFile(join(directory, 'README.md'), '![diagram](missing.png)')
    await expect(inspectDocumentationLinks(directory, 'README.md')).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses a parent checkout escape before reading the target', async () => {
    await writeFile(join(directory, 'README.md'), '[parent](../harness/README.md)')
    await expect(inspectDocumentationLinks(directory, 'README.md')).rejects.toThrow('escapes package')
  })
  it('refuses an absolute local target', async () => {
    await writeFile(join(directory, 'README.md'), `[host](${join(directory, 'asset.json')})`)
    await expect(inspectDocumentationLinks(directory, 'README.md')).rejects.toThrow('Absolute documentation target')
  })
  it('refuses a symlink even when it points to an otherwise valid package file', async () => {
    await symlink(join(directory, 'asset.json'), join(directory, 'linked.json'))
    await writeFile(join(directory, 'README.md'), '[linked](linked.json)')
    await expect(inspectDocumentationLinks(directory, 'README.md')).rejects.toThrow('not a regular file')
  })
  it('refuses directory targets', async () => {
    await writeFile(join(directory, 'README.md'), '[directory](docs)')
    await expect(inspectDocumentationLinks(directory, 'README.md')).rejects.toThrow('not a regular file')
  })
  it('verifies HTML contact-sheet images and local links while ignoring optional remote fonts', async () => {
    await writeFile(join(directory, 'docs', 'sheet.html'), '<img src="../image%20with%20space.png">'
      + '<a href="../asset.json#node">Source</a><link href="https://fonts.googleapis.com/css2">')
    expect(await inspectDocumentationLinks(directory, 'docs/sheet.html', 'html')).toEqual([
      join(directory, 'image with space.png'), join(directory, 'asset.json')])
  })
  it('refuses a document outside the installed package', async () => {
    await expect(inspectDocumentationLinks(directory, '../README.md')).rejects.toThrow('escapes package')
  })
})
