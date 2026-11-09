// RECONSTRUCTION. The original script is not in the public repository, and no copy was found.
// It is rebuilt from tests/documentation-package.spec.ts, tests/kubernetes-preflight.spec.ts and
// references/development.md, and may differ from the original (for example, in which files
// checkDocumentationPackage selects, or whether failures are thrown or returned).
//
// inspectDocumentationLinks(root, document, mode?) returns the absolute paths of every local link
// target in one Markdown or HTML document. It refuses absolute targets, package escapes, symlinks,
// directories and missing files. External URLs, data: URLs, anchors, HTML comments and fenced code
// are ignored. checkDocumentationPackage(root) applies it to every documentation file of an
// installed/extracted package.
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const external = /^[a-z][a-z0-9+.-]*:/i

function escapes(root, path) {
  const local = relative(root, path)
  return local === '..' || local.startsWith('..' + sep) || isAbsolute(local)
}

function markdownTargets(text) {
  const visible = text.replace(/<!--[\s\S]*?-->/g, '').replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
  const targets = []
  // [text](target), ![alt](target), optional "title", optional <angle brackets> around paths with spaces.
  for (const match of visible.matchAll(/!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g))
    targets.push(match[1] ?? match[2])
  return targets
}

function htmlTargets(text) {
  const visible = text.replace(/<!--[\s\S]*?-->/g, '')
  return [...visible.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(match => match[1] ?? match[2])
}

export async function inspectDocumentationLinks(root, document, mode = extname(document) === '.html' ? 'html' : 'markdown') {
  const base = await realpath(root)
  const documentPath = resolve(base, document)
  if (escapes(base, documentPath)) throw Error(`Documentation document escapes package: ${document}`)
  const text = await readFile(documentPath, 'utf8')
  const resolved = []
  for (const raw of mode === 'html' ? htmlTargets(text) : markdownTargets(text)) {
    const target = raw.trim()
    if (!target || target.startsWith('#') || external.test(target)) continue
    const path = decodeURIComponent(target.split('#')[0].split('?')[0])
    if (!path) continue
    if (isAbsolute(path)) throw Error(`Absolute documentation target in ${document}: ${target}`)
    const absolute = resolve(dirname(documentPath), path)
    if (escapes(base, absolute)) throw Error(`Documentation target escapes package in ${document}: ${target}`)
    const stats = await lstat(absolute) // ENOENT propagates for missing targets
    if (!stats.isFile()) throw Error(`Documentation target is not a regular file in ${document}: ${target}`)
    resolved.push(absolute)
  }
  return resolved
}

async function documentationFiles(root, directory = root) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await documentationFiles(root, path))
    else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.visual-check.html')))
      found.push(relative(root, path))
  }
  return found.sort()
}

export async function checkDocumentationPackage(root) {
  const base = await realpath(root)
  const documents = await documentationFiles(base)
  if (!documents.includes('README.md') && !documents.includes('SKILL.md')) throw Error('No README.md or SKILL.md in documentation package')
  let links = 0
  for (const document of documents) links += (await inspectDocumentationLinks(base, document)).length
  return { status: 'passed', root: base, documents: documents.length, links }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2]
  if (!root) { process.stderr.write('usage: node scripts/check-documentation-package.mjs <installed-package-root>\n'); process.exit(2) }
  try { process.stdout.write(JSON.stringify(await checkDocumentationPackage(root)) + '\n') }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1) }
}
