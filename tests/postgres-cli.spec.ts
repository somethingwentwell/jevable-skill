import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/cli.ts'
import { writeArtifact } from '../src/files.ts'

async function cli(args: string[]) {
  let stdout = '', stderr = ''
  const code = await main(args, { out: value => { stdout += value }, err: value => { stderr += value } })
  return { code, stdout, stderr }
}
describe('PostgreSQL CLI service admission', () => {
  it.each([['--storage', 'unknown'], ['--storage', 'postgres'], ['--storage', 'sqlite', '--database-file', 'private.json'],
    ['--storage', 'postgres', '--database-file', 'private.json', '--data-dir', 'local'], ['--drain-wait-ms', '0'], ['--drain-wait-ms', '60001'], ['--port', '65536']].map(flags => ({ flags })))('rejects conflicting/missing policy without fallback: %j', async ({ flags }) => {
    const dir = await mkdtemp(join(tmpdir(), 'jevable-pg-cli-')), token = join(dir, 'token')
    await writeArtifact(token, 'a'.repeat(64))
    const result = await cli(['runtime', 'serve', '--token-file', token, ...flags])
    expect(result.code).toBe(2); expect(JSON.parse(result.stderr).code).toBe('invalid-input'); expect(result.stdout).toBe('')
  })
  it('rejects remote plaintext configuration before networking with a sanitized startup code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jevable-pg-cli-')), token = join(dir, 'token'), config = join(dir, 'database.json')
    await writeArtifact(token, 'b'.repeat(64))
    await writeArtifact(config, JSON.stringify({ host: 'uncontacted.invalid', port: 5432, database: 'fixture', user: 'fixture',
      password: 'PRIVATE_PASSWORD', namespace: 'fixture', initialize: false, tls: { mode: 'loopback-test' } }))
    const result = await cli(['runtime', 'serve', '--storage', 'postgres', '--database-file', config, '--token-file', token])
    expect(result.code).toBe(1); expect(JSON.parse(result.stderr).code).toBe('invalid-config')
    expect(result.stderr).not.toContain('PRIVATE_PASSWORD'); expect(result.stderr).not.toContain('uncontacted.invalid'); expect(result.stdout).toBe('')
  })
  it('does not silently apply backend flags to direct SQLite commands or accept password arguments', async () => {
    for (const args of [['runs', 'list', '--storage', 'postgres'], ['runtime', 'serve', '--password', 'PRIVATE_PASSWORD']]) {
      const result = await cli(args); expect(result.code).toBe(2); expect(result.stderr).not.toContain('PRIVATE_PASSWORD')
    }
  })
})
