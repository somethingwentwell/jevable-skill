import { afterEach, describe, expect, it, vi } from 'vitest'
import { startPostgresRuntimeService } from '../src/http/postgres.ts'
import { PostgresRuntime } from '../src/runtime/postgres.ts'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { startPreviewFromCli } from '../src/cli/preview.ts'
import { renderPreview } from '../src/preview/index.ts'

afterEach(() => vi.restoreAllMocks())
const options = { runtime: { database: { host: '127.0.0.1', port: 5432, database: 'fixture', user: 'fixture', password: 'private',
  namespace: 'fixture', initialize: false, tls: { mode: 'loopback-test' as const } } }, token: 'a'.repeat(64), actor: 'local:test' }
const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')

describe('explicit PostgreSQL service admission', () => {
  it.each([
    { id: randomUUID(), generation: 0, revision: 'a'.repeat(64) },
    { id: randomUUID(), generation: 1, revision: 'a'.repeat(64) },
    { id: randomUUID(), generation: 1, revision: renderPreview(source).data.revision, actor: 'spoofed' },
  ])('refuses invalid/stale source attachment before PostgreSQL ownership: %j', async projectPin => {
    const open = vi.spyOn(PostgresRuntime, 'open')
    await expect(startPostgresRuntimeService({ ...options, preview: { source, projectPin } } as never)).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
  })
  it('refuses simultaneous create/attach before PostgreSQL ownership', async () => {
    const open = vi.spyOn(PostgresRuntime, 'open')
    await expect(startPostgresRuntimeService({ ...options, preview: { source, projectId: randomUUID(),
      projectPin: { id: randomUUID(), generation: 1, revision: renderPreview(source).data.revision } } } as never)).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
  })
  it.each(['preview', 'release', 'dataDirectory', 'harness'])('refuses malformed or unsupported %s before opening a database', async key => {
    const open = vi.spyOn(PostgresRuntime, 'open')
    await expect(startPostgresRuntimeService({ ...options, [key]: {} })).rejects.toMatchObject({ code: 'invalid-command' })
    expect(open).not.toHaveBeenCalled()
  })
  it.each([{ token: 'weak' }, { actor: '' }, { port: -1 }, { maxConcurrentRequests: 0 }, { maxResponseBytes: 1 }])('validates transport policy before ownership %j', async patch => {
    const open = vi.spyOn(PostgresRuntime, 'open')
    await expect(startPostgresRuntimeService({ ...options, ...patch })).rejects.toMatchObject({ code: 'invalid-command' })
    expect(open).not.toHaveBeenCalled()
  })
  it('validates TLS files before opening storage', async () => {
    const open = vi.spyOn(PostgresRuntime, 'open')
    await expect(startPostgresRuntimeService({ ...options, port: 8787,
      tls: { publicOrigin: 'https://127.0.0.1:8787', bindAddress: '127.0.0.1', certificateFile: '/does-not-exist.crt', privateKeyFile: '/does-not-exist.key' } })).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
  })
  it.each([null, { source }, { source, projectId: 'invalid' }, { source, projectId: randomUUID(), extra: true },
    { source: 'not a workflow', projectId: randomUUID() }, { source, projectId: randomUUID(), traceViewer: { origin: 'javascript:invalid' } }])(
    'validates preview source, identity and trace navigation before database ownership: %j', async preview => {
      const open = vi.spyOn(PostgresRuntime, 'open')
      await expect(startPostgresRuntimeService({ ...options, preview } as never)).rejects.toThrow()
      expect(open).not.toHaveBeenCalled()
    })
  it.each(['tls', 'release'])('refuses mixed preview/%s modes before reading files or storage', async field => {
    const open = vi.spyOn(PostgresRuntime, 'open')
    await expect(startPostgresRuntimeService({ ...options, preview: { source, projectId: randomUUID() }, [field]: {} } as never)).rejects.toMatchObject({ code: 'invalid-command' })
    expect(open).not.toHaveBeenCalled()
  })
  it.each([
    { storage: 'postgres', 'database-file': '/not-read' },
    { storage: 'postgres', 'database-file': '/not-read', 'project-id': 'invalid' },
    { storage: 'postgres', 'database-file': '/not-read', 'data-dir': '/not-created', 'project-id': randomUUID() },
    { storage: 'sqlite', 'database-file': '/not-read' },
    { storage: 'unknown' },
    { runtime: 'docker', storage: 'postgres', 'database-file': '/not-read', 'project-id': randomUUID() },
  ])('refuses mixed or incomplete preview CLI storage before reading protected files: %j', async patch => {
    const open = vi.spyOn(PostgresRuntime, 'open')
    await expect(startPreviewFromCli(source, { 'token-file': '/not-read', ...patch })).rejects.toHaveProperty('name', 'Error')
    expect(open).not.toHaveBeenCalled()
  })
})
