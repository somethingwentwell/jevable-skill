import { describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
async function inputs(entry: string) {
  const result = await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, write: false,
    platform: 'node', format: 'esm', target: 'node22.19', metafile: true,
    plugins: [{ name: 'node-only-pg-transport', setup(api) {
      api.onResolve({ filter: /^\.\/stream$/ }, args => args.importer.endsWith('/node_modules/pg/lib/connection.js')
        ? { path: join(root, 'src/storage/node-pg-stream.cjs') } : undefined)
    } }],
  })
  return Object.keys(result.metafile!.inputs)
}
describe('automatic notification standalone build boundary', () => {
  it('keeps the actual SQLite release entry free of PostgreSQL code', async () => {
    const actual = await inputs('src/releases/entry.ts')
    expect(actual).toContain('src/notifications/automatic-owner.ts')
    expect(actual).toContain('src/storage/errors.ts')
    expect(actual.filter(path => path.startsWith('node_modules/pg') || path.includes('/postgres'))).toEqual([])
  })
  it('imports only shared error identity for the automatic owner graph', async () => {
    const actual = await inputs('src/notifications/automatic-owner.ts')
    expect(actual).toContain('src/storage/errors.ts')
    expect(actual.filter(path => path.startsWith('node_modules/pg') || path.includes('/postgres'))).toEqual([])
  })
  it('retains the real PostgreSQL driver without SQLite fallback in its release entry', async () => {
    const actual = await inputs('src/releases/postgres-entry.ts')
    expect(actual).toContain('src/storage/postgres.ts')
    expect(actual).toContain('node_modules/pg/lib/client.js')
    expect(actual).not.toContain('src/runtime/local.ts')
    expect(actual).not.toContain('src/runtime/store.ts')
  })
})
