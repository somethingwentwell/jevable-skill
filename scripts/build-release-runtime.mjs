import { build } from 'esbuild'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { isBuiltin } from 'node:module'
import assert from 'node:assert/strict'
import { assertOwnedBuildInputs } from './standalone-boundary.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
for (const storage of ['sqlite', 'postgres', 'management']) {
const stem = storage === 'sqlite' ? 'release' : storage === 'postgres' ? 'release-postgres' : 'management/core'
const entry = storage === 'sqlite' ? 'src/releases/entry.ts' : storage === 'postgres' ? 'src/releases/postgres-entry.ts' : 'src/management/entry.ts'
const result = await build({ absWorkingDir: root, entryPoints: [entry], outfile: `dist/${stem}-runtime.mjs`,
  plugins: [{ name: 'node-only-pg-transport', setup(api) {
    api.onResolve({ filter: /^\.\/stream$/ }, args => args.importer.endsWith('/node_modules/pg/lib/connection.js')
      ? { path: join(root, 'src/storage/node-pg-stream.cjs') } : undefined)
  } }],
  bundle: true, platform: 'node', format: 'esm', target: 'node22.19', metafile: true, legalComments: 'eof',
  banner: { js: 'import { createRequire as __jevableCreateRequire } from "node:module"; const require = __jevableCreateRequire(import.meta.url);' } })
for (const output of Object.values(result.metafile.outputs)) for (const imported of output.imports)
  assert.ok(imported.external && isBuiltin(imported.path) && (storage !== 'postgres' || imported.path !== 'node:sqlite'), `Runtime bundle requires disallowed code: ${imported.path}`)
if (storage === 'sqlite') assert.ok(!Object.keys(result.metafile.inputs).some(p => p.startsWith('node_modules/pg') || p.includes('/postgres')))
else assert.ok(!Object.keys(result.metafile.inputs).some(p => (storage === 'postgres' && p === 'src/runtime/local.ts') || p.includes('pg/lib/native') || p.includes('pg-cloudflare')))
const packages = new Map()
await assertOwnedBuildInputs(root, Object.keys(result.metafile.inputs))
for (const input of Object.keys(result.metafile.inputs)) {
  assert.ok(!/(?:jarness|harness|@deepseek-ai)\//iu.test(input) && !input.startsWith('../'), `External source input: ${input}`)
  if (!input.startsWith('node_modules/')) continue
  const parts = input.split('/'), count = parts[1].startsWith('@') ? 3 : 2
  const directory = parts.slice(0, count).join('/')
  if (packages.has(directory)) continue
  const manifest = JSON.parse(await readFile(join(root, directory, 'package.json'), 'utf8'))
  const names = (await readdir(join(root, directory))).filter(name => /^(license|copying|notice)(\.|$)/iu.test(name)).sort()
  const notices = await Promise.all(names.map(name => readFile(join(root, directory, name), 'utf8')))
  if (!notices.length) {
    const readme = await readFile(join(root, directory, 'README.md'), 'utf8')
    const embedded = readme.match(/^##? license\s*\n([\s\S]*)/im)?.[1]?.trim()
    assert.ok(embedded?.includes('Copyright') && embedded.includes('Permission is hereby granted'), `Missing license notice for ${manifest.name}`)
    notices.push(embedded)
  }
  packages.set(directory, { name: manifest.name, version: manifest.version, notices: notices.join('\n\n') })
}
const notice = ['Jevable workflow runtime — development distribution; proprietary core terms are not yet published.',
  await readFile(join(root, 'notices/harness-MIT.txt'), 'utf8'), await readFile(join(root, 'notices/preview-dependencies.txt'), 'utf8'), ...[...packages.values()].sort((a, b) => a.name.localeCompare(b.name))
    .map(pkg => `${pkg.name} ${pkg.version}\n\n${pkg.notices}`)].join('\n\n---\n\n')
await writeFile(join(root, `dist/${stem}-NOTICES.txt`), notice)
const bytes = await readFile(join(root, `dist/${stem}-runtime.mjs`))
const metadata = { schemaVersion: 1, storage, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
  ...(storage === 'management' ? { coreVersion: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version } : {}),
  dependencies: [...packages.values()].map(({ name, version }) => ({ name, version })),
  external: 'node-builtins-only', inputs: Object.keys(result.metafile.inputs).map(input => relative(root, resolve(root, input))) }
await writeFile(join(root, `dist/${stem}-runtime.json`), JSON.stringify(metadata, null, 2) + '\n')
console.log(`Bundled standalone ${storage} runtime (${bytes.length} bytes, ${packages.size} dependency notices).`)

}
