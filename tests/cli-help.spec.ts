import { describe, expect, it, vi } from 'vitest'
import { main } from '../src/cli.ts'
import { CLI_HELP_PATHS } from '../src/cli/help.ts'
import { validateCliFlagRequirements, cliFlagRequirements, cliPositionalRequirements, cliArgumentFormatDescription } from '../src/cli/requirements.ts'
import { z } from 'zod'
import { approvalNotificationKind } from '../src/notifications/schema.ts'
import { buildSchema } from '../src/images/local.ts'
import { recordPageSchema, auditPageSchema } from '../src/http/pagination.ts'
import { generateTestsSchema } from '../src/testing/generation-schema.ts'
import { testIdentitySchema } from '../src/testing/schema.ts'
import { previewSelection } from '../src/cli/preview.ts'
import { suiteSelection } from '../src/cli/suite.ts'
import { doctorSelection } from '../src/cli/doctor.ts'
import { operationSelection } from '../src/cli/operations.ts'
import { listSchemas, showSchema } from '../src/contracts.ts'

const blocked = vi.hoisted(() => vi.fn(() => { throw new Error('Help attempted I/O or execution') }))
vi.mock('../src/files.ts', async importOriginal => ({ ...await importOriginal<object>(), readBoundedFile: blocked, readBoundedBytes: blocked, writeArtifact: blocked }))
vi.mock('../src/cli/operations.ts', async importOriginal => ({ ...await importOriginal<object>(), openCliOperations: blocked }))
vi.mock('../src/cli/runtime.ts', async importOriginal => ({ ...await importOriginal<object>(), openCliRuntime: blocked }))
vi.mock('../src/cli/docker.ts', async importOriginal => ({ ...await importOriginal<object>(), dockerFromCli: blocked }))
vi.mock('../src/cli/doctor.ts', async importOriginal => ({ ...await importOriginal<object>(), doctor: blocked }))
vi.mock('../src/cli/watch.ts', async importOriginal => ({ ...await importOriginal<object>(), watchFromCli: blocked }))
vi.mock('../src/cli/suite.ts', async importOriginal => ({ ...await importOriginal<object>(), suiteFromCli: blocked }))
vi.mock('../src/cli/preview.ts', async importOriginal => ({ ...await importOriginal<object>(), startPreviewFromCli: blocked }))
vi.mock('../src/http/cli.ts', async importOriginal => ({ ...await importOriginal<object>(), serveFromCli: blocked }))
vi.mock('../src/providers/secret-input.ts', async importOriginal => ({ ...await importOriginal<object>(), readSecretFile: blocked, readSecretStdin: blocked }))

async function cli(argv: string[]) {
  let stdout = '', stderr = ''
  const code = await main(argv, { out: text => { stdout += text }, err: text => { stderr += text } })
  return { code, stdout, stderr }
}
const report = async (path: string) => {
  const result = await cli(['help', ...path.split(' '), '--json'])
  expect(result.code, result.stderr).toBe(0)
  expect(result.stderr).toBe('')
  return JSON.parse(result.stdout)
}
const uuid = 'ea953a2f-2d9c-42ad-9910-9c4fb2708d21', hash = 'a'.repeat(64)
const formatSample = (format: string) => format === 'uuid' ? uuid : format === 'audit-sequence' ? '0' : hash
const testIdentityHash = (value: string) => value.length === 64 && testIdentitySchema.shape.sha256.safeParse(value).success

describe('standalone read-only parser help', () => {
  it('discovers every core contract through real CLI dispatch without I/O', async () => {
    const before = blocked.mock.calls.length
    const index = await cli(['schemas', 'list', '--json'])
    expect(index.code).toBe(0); expect(JSON.parse(index.stdout)).toEqual(listSchemas())
    for (const entry of listSchemas().schemas) {
      const actual = await cli(['schemas', 'show', entry.id, '--json'])
      expect(actual.code, actual.stderr).toBe(0); expect(actual.stderr).toBe('')
      expect(JSON.parse(actual.stdout)).toEqual(showSchema(entry.id))
    }
    expect(blocked.mock.calls.length).toBe(before)
  })
  it.each([
    ['schemas', 'show', '../private-not-read.json'], ['schemas', 'show', '__proto__'],
    ['schemas', 'show', 'workflow', '--endpoint', 'https://not-contacted.invalid'],
    ['schemas', 'list', '--data-dir', 'never-created'], ['schemas', 'show', 'workflow', '--file', 'never-read'],
    ['schemas', 'show'], ['schemas', 'list', 'workflow'], ['schemas', 'unknown'],
  ])('rejects invalid or mixed schema discovery %j without I/O', async (...argv) => {
    const before = blocked.mock.calls.length, result = await cli(argv)
    expect(result.code).toBe(2); expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr).code).toBe('invalid-input')
    expect(result.stderr).not.toContain('private-not-read'); expect(result.stderr).not.toContain('not-contacted.invalid')
    expect(blocked.mock.calls.length).toBe(before)
  })
  it.each(CLI_HELP_PATHS)('discovers %s through its real dispatcher without I/O', async path => {
    const before = blocked.mock.calls.length
    const a = await report(path)
    const b = await cli([...path.split(' '), '--help', '--json'])
    expect(b.code, b.stderr).toBe(0)
    expect(JSON.parse(b.stdout)).toEqual(a)
    expect(a).toMatchObject({ schemaVersion: 4, kind: 'command', command: path, execution: 'not-dispatched' })
    for (const variant of a.variants) {
      expect([0, 1]).toContain(variant.positionalCount)
      expect(variant.options.json).toBe('boolean')
      expect(Object.values(variant.options).every(x => x === 'string' || x === 'boolean')).toBe(true)
      if (variant.options['data-dir']) expect(variant.options['telemetry-file']).toBe('string')
      expect(variant.requirements).toEqual({ ...cliFlagRequirements(path, variant.options, variant.profile), positionals: cliPositionalRequirements(path, variant.positionalCount) })
      for (const rule of variant.requirements.rules) {
        for (const flag of 'flag' in rule ? [rule.flag] : rule.flags) expect(variant.options[flag]).toBeDefined()
      }
    }
    // The same live parser must refuse an unknown flag before trying real work.
    const invalid = await cli([...path.split(' '), '--unknown-qualification-flag'])
    expect(invalid.code, invalid.stderr).toBe(2)
    expect(blocked.mock.calls.length).toBe(before)
  })

  it('lists groups and nested paths, without treating a group as executable', async () => {
    const all = await cli(['help', '--json'])
    expect(JSON.parse(all.stdout).schemaVersion).toBe(4)
    expect(JSON.parse(all.stdout).commands).toEqual(CLI_HELP_PATHS)
    expect(new Set(CLI_HELP_PATHS).size).toBe(CLI_HELP_PATHS.length)
    const group = await cli(['tests', 'suite', '-h', '--json'])
    expect(group.code).toBe(0)
    expect(JSON.parse(group.stdout).commands).toEqual(['tests suite create', 'tests suite inspect', 'tests suite run', 'tests suite result', 'tests suite coverage'])
    const text = await cli(['projects', '--help'])
    expect(text.code).toBe(0)
    expect(text.stdout).toContain('jevable projects accept')
    expect((await cli(['projects'])).code).toBe(2)
  })

  it('exposes different actual local/Docker startup grammars and backend/page flags', async () => {
    const start = await report('runtime start')
    expect(start.variants).toHaveLength(2)
    expect(start.variants[0].options['data-dir']).toBe('string')
    expect(start.variants[0].options['owner-file']).toBeUndefined()
    expect(start.variants[1].options['owner-file']).toBe('string')
    expect(start.variants[1].options['data-dir']).toBeUndefined()
    expect(start.variants[1].options['telemetry-credential-file']).toBe('string')
    const list = await report('approvals list')
    expect(list.variants[0]).toMatchObject({ positionalCount: 0, options: { page: 'boolean', after: 'string', limit: 'string', storage: 'string', 'database-file': 'string', endpoint: 'string', 'owner-file': 'string' } })
    const create = await report('tests suite create')
    expect(create.variants[0].options.endpoint).toBeUndefined()
    expect((await report('tests suite run')).variants[0].options.endpoint).toBe('string')
    expect((await report('projects reject')).variants[0].options['ack-approvals']).toBeUndefined()
    expect((await report('tests history')).variants[0].options.generation).toBeUndefined()
    expect((await report('runs recover')).variants[0].options['breakpoints-file']).toBeUndefined()
  })

  it.each([
    ['help', 'unknown'], ['help', 'projects', 'unknown'], ['help', 'run', 'input'],
    ['run', '/private/never-read.yaml', '--help'], ['help', 'runtime', 'token', '--output', '/private/never-written'],
    ['credentials', 'set', '--file', 'never-read', '--help'], ['run', '--endpoint', 'https://never-connect.invalid', '--help'],
    ['runtime', 'stop', '--runtime', 'docker', '--help'], ['help', 'run', '--help'],
    ['run', '-h', '--help'], ['help', '--json', '--json'], ['run', '--', '--help'],
  ])('rejects mixed/unknown help request %j before I/O', async (...argv) => {
    const before = blocked.mock.calls.length
    const result = await cli(argv)
    expect(result.code).toBe(2)
    expect(JSON.parse(result.stderr).code).toBe('invalid-input')
    expect(result.stdout).toBe('')
    expect(blocked.mock.calls.length).toBe(before)
  })

  it('preserves global legacy help/version and isolates concurrent invocations', async () => {
    for (const argv of [[], ['--help'], ['-h']]) expect((await cli(argv)).stdout).toContain('standalone workflow core')
    const [help, capabilities, version] = await Promise.all([report('runs recover'), cli(['capabilities']), cli(['--version'])])
    expect(JSON.parse(capabilities.stdout).dependencies.harness).toBe(false)
    expect(version.code).toBe(0)
    expect(version.stdout.trim()).toBe(help.version)
    expect(help.exitCodes).toHaveProperty('7')
    expect(help.exitCodes).toHaveProperty('8')
    expect(help.exitCodes).toHaveProperty('130')
  })

  it.each([
    ['projects accept', ['--expected-generation', '2', '--proposal-id', 'retained-proposal'], 'revision'],
    ['projects propose', ['--expected-generation', '1'], 'file'],
    ['projects create', [], 'title'],
    ['projects diff', ['--from', 'reviewed-revision'], 'to'],
    ['releases create', ['--expected-generation', '1', '--revision', 'reviewed-revision'], 'version'],
    ['tests run', ['--expected-generation', '1', '--sha256', 'reviewed-hash'], 'id'],
    ['tests generate', ['--id', 'retained-id', '--revision', 'reviewed-revision'], 'expected-generation'],
    ['runs recover', ['--request-id', 'retained-request'], 'checkpoint-sha256'],
    ['runs cancel', [], 'request-id'],
    ['run', [], 'input'],
    ['approvals decide', ['--attempt', 'retained-attempt'], 'action'],
    ['approvals notify prepare', ['--revision', 'reviewed-revision', '--attempt', 'retained-attempt'], 'destination'],
    ['templates render', [], 'output'],
    ['import project', [], 'reviewed-sha256'],
    ['runs watch', ['--endpoint', 'https://never-connect.invalid'], 'token-file'],
    ['runtime request', ['--endpoint', 'https://never-connect.invalid'], 'token-file'],
  ] as const)('refuses missing %s flags before any read/owner/API admission', async (path, flags, missing) => {
    const before = blocked.mock.calls.length
    const result = await cli([...path.split(' '), 'never-read-or-dispatched', ...flags])
    expect(result.code, result.stderr).toBe(2)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toMatchObject({ code: 'invalid-input', message: `Provide --${missing}.` })
    expect(blocked.mock.calls.length).toBe(before)
  })

  it.each([
    ['preview', 'never-read', '--serve'],
    ['preview', 'never-read', '--serve', '--output', 'never-written'],
    ['templates', 'render', 'never-read', '--output', 'never-written', '--provider', 'provider'],
    ['credentials', 'set', 'key', '--expected-generation', '0'],
    ['credentials', 'set', 'key', '--expected-generation', '0', '--file', 'never-read', '--stdin'],
    ['projects', 'export', 'never-dispatched', '--expected-generation', '1', '--revision', 'reviewed', '--output', 'never-written', '--evidence-file', 'never-read'],
    ['runtime', 'serve', '--token-file', 'never-read', '--tls-cert-file', 'never-read'],
    ['runtime', 'start', '--runtime', 'docker', '--receipt-sha256', 'reviewed'],
    ['projects', 'run', 'never-dispatched', '--expected-generation', '1', '--revision', 'reviewed', '--input', 'never-read', '--endpoint', 'https://never-connect.invalid', '--token-file', 'never-read'],
  ])('enforces shared combinations in %j before I/O', async (...argv) => {
    const before = blocked.mock.calls.length
    const result = await cli(argv)
    expect(result.code, result.stderr).toBe(2)
    expect(JSON.parse(result.stderr).code).toBe('invalid-input')
    expect(blocked.mock.calls.length).toBe(before)
  })

  it('admits valid complete flag selections without implying execution/schema/permission validation', async () => {
    for (const [path, values] of [
      ['projects accept', { 'expected-generation': '2', 'proposal-id': uuid, revision: hash }],
      ['credentials set', { 'expected-generation': '0', stdin: true }],
      ['preview', { output: 'workflow.html' }],
      ['preview', { serve: true, 'token-file': 'owner-token', storage: 'postgres', 'database-file': 'database.json', 'project-id': uuid }],
    ] as const) {
      const command = await report(path)
      expect(() => validateCliFlagRequirements(path, values, command.variants[0].options)).not.toThrow()
    }
    const start = await report('runtime start')
    const docker = start.variants[1]
    expect(docker.requirements.rules).toContainEqual({ kind: 'fixed', flag: 'runtime', value: 'docker' })
    expect(start.variants[0].requirements.rules).not.toContainEqual({ kind: 'fixed', flag: 'runtime', value: 'docker' })
    expect(() => validateCliFlagRequirements('runtime start', { runtime: 'docker', 'image-receipt': 'image', 'receipt-sha256': hash,
      'owner-file': 'owner', port: '8443', 'token-file': 'token', 'tls-cert-file': 'cert', 'tls-key-file': 'key' }, docker.options)).not.toThrow()
  })

  it('shows shared requirements in plain-text help without describing flags as authority', async () => {
    const result = await cli(['help', 'projects', 'accept'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('required: --expected-generation, --proposal-id, --revision')
    expect(result.stdout).toContain('permission checks still apply')
  })

  it.each([
    ['run', ['never-read', '--input', 'never-read', '--storage', 'mysql'], 'storage', ['sqlite', 'postgres']],
    ['run', ['never-read', '--input', 'never-read', '--runtime', 'desktop'], 'runtime', ['local', 'docker']],
    ['preview', ['never-read', '--output', 'never-written', '--runtime', 'desktop'], 'runtime', ['local', 'docker']],
    ['runtime start', ['--token-file', 'never-read', '--runtime', 'server'], 'runtime', ['local', 'docker']],
    ['runtime stop', ['--runtime', 'local'], 'runtime', ['docker']],
    ['releases create', ['never-dispatched', '--expected-generation', '1', '--revision', 'reviewed', '--version', '1', '--runtime-storage', 'mysql'], 'runtime-storage', ['sqlite', 'postgres']],
    ['projects export', ['never-dispatched', '--expected-generation', '1', '--revision', 'reviewed', '--output', 'never-written', '--format', 'container'], 'format', ['json', 'zip']],
    ['releases export', ['never-dispatched', '--release-sha256', 'reviewed', '--output', 'never-written', '--format', 'json'], 'format', ['zip']],
    ['runtime build-image', ['--platform', 'darwin/arm64'], 'platform', ['linux/arm64', 'linux/amd64']],
    ['releases build-image', ['never-dispatched', '--platform', 'linux/ppc64le'], 'platform', ['linux/arm64', 'linux/amd64']],
    ['templates render', ['never-read', '--output', 'never-written', '--language', 'fr'], 'language', ['en', 'zh']],
    ['templates list', ['--language', 'EN'], 'language', ['en', 'zh']],
    ['templates show', ['never-read', '--language', ''], 'language', ['en', 'zh']],
    ['approvals notify prepare', ['never-dispatched', '--revision', 'reviewed', '--attempt', 'retained', '--destination', 'review', '--event-kind', 'approved'], 'event-kind', ['requested', 'decided', 'expired', 'cancelled']],
    ['doctor', ['--storage', ' sqlite '], 'storage', ['sqlite', 'postgres']],
  ] as const)('refuses unsupported %s literal choices before I/O', async (path, flags, flag, choices) => {
    const before = blocked.mock.calls.length
    const result = await cli([...path.split(' '), ...flags])
    expect(result.code, result.stderr).toBe(2)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toMatchObject({ code: 'invalid-input', message: `Use --${flag} ${choices.join('|')}.` })
    expect(blocked.mock.calls.length).toBe(before)
  })

  it('publishes finite choices matching underlying notification/image schemas, not workflow-specific approval actions', async () => {
    const notify = (await report('approvals notify prepare')).variants[0].requirements.rules
    expect(notify).toContainEqual({ kind: 'choices', flag: 'event-kind', values: [...approvalNotificationKind.options] })
    for (const path of ['runtime build-image', 'releases build-image']) {
      expect((await report(path)).variants[0].requirements.rules).toContainEqual({ kind: 'choices', flag: 'platform', values: [...buildSchema.shape.platform.options] })
    }
    expect((await report('approvals decide')).variants[0].requirements.rules.some((rule: { kind: string; flag?: string }) => rule.kind === 'choices' && rule.flag === 'action')).toBe(false)
    expect((await cli(['help', 'projects', 'export'])).stdout).toContain('--format: json | zip (if supplied)')
    const start = await report('runtime start')
    expect(start.variants[0].requirements.rules).toContainEqual({ kind: 'choices', flag: 'runtime', values: ['local'] })
    expect(start.variants[1].requirements.rules).toContainEqual({ kind: 'choices', flag: 'runtime', values: ['docker'] })
  })

  it('admits all advertised literal values through the same validator, without reading files or implying authority', async () => {
    for (const path of CLI_HELP_PATHS) for (const variant of (await report(path)).variants) {
      const values: Record<string, string | boolean> = {}
      const choices = variant.requirements.rules.filter((r: { kind: string }) => r.kind === 'choices') as { flag: string; values: string[] }[]
      const valueFor = (flag: string) => variant.options[flag] === 'boolean' ? true : choices.find(r => r.flag === flag)?.values[0]
        ?? (variant.requirements.rules.some((r: { kind: string; flag?: string }) => r.kind === 'format' && r.flag === flag)
          ? formatSample(variant.requirements.rules.find((r: { kind: string; flag?: string }) => r.kind === 'format' && r.flag === flag).format) : undefined)
        ?? String(variant.requirements.rules.find((r: { kind: string; flag?: string }) => r.kind === 'integer' && r.flag === flag)?.minimum ?? 'not-read')
      for (const rule of variant.requirements.rules) {
        if (rule.kind === 'required' || rule.kind === 'together') for (const flag of rule.flags) values[flag] = valueFor(flag)
        if (rule.kind === 'fixed') values[rule.flag] = rule.value
        if (rule.kind === 'exactly-one') values[rule.flags[0]] = valueFor(rule.flags[0])
      }
      // A paired optional alternative (such as an existing-project pin file/hash)
      // cannot coexist with the first exactly-one selection used by this fixture.
      // Keep testing every advertised literal; construct a valid presence choice.
      const unselected = new Set<string>(variant.requirements.rules.filter((r: { kind: string }) => r.kind === 'exactly-one')
        .flatMap((r: { flags: string[] }) => r.flags.slice(1)))
      for (const flag of unselected) delete values[flag]
      for (const rule of variant.requirements.rules) if (rule.kind === 'together' && rule.flags.some((flag: string) => unselected.has(flag))) {
        for (const flag of rule.flags) delete values[flag]
      }
      for (const choice of choices) for (const value of choice.values) {
        expect(() => validateCliFlagRequirements(path, { ...values, [choice.flag]: value }, variant.options), `${path} --${choice.flag} ${value}`).not.toThrow()
      }
    }
  })

  it('isolates caller edits to advertised choices and refuses parser type drift', async () => {
    const options = (await report('run')).variants[0].options
    const metadata = cliFlagRequirements('run', options)
    const storage = metadata.rules.find(rule => rule.kind === 'choices' && rule.flag === 'storage')!
    if (storage.kind !== 'choices') throw Error('Expected storage choices')
    storage.values.push('mysql')
    expect(() => validateCliFlagRequirements('run', { input: 'not-read', storage: 'mysql' }, options)).toThrow('Use --storage sqlite|postgres.')
    expect(() => cliFlagRequirements('run', { input: 'string', storage: 'boolean' })).toThrow('CLI choices do not match the command parser.')
  })

  it.each([
    ['projects accept', ['never-dispatched', '--expected-generation', '0', '--proposal-id', 'retained', '--revision', 'reviewed'], 'expected-generation', 1, Number.MAX_SAFE_INTEGER],
    ['credentials set', ['key', '--expected-generation', '01', '--stdin'], 'expected-generation', 0, Number.MAX_SAFE_INTEGER],
    ['providers set', ['never-read', '--expected-generation', '9007199254740992'], 'expected-generation', 0, Number.MAX_SAFE_INTEGER],
    ['tests show', ['never-dispatched', '--generation', '0'], 'generation', 1, Number.MAX_SAFE_INTEGER],
    ['tests generate', ['never-dispatched', '--id', 'retained', '--expected-generation', '1', '--revision', 'reviewed', '--limit', '33'], 'limit', 1, 32],
    ['runs list', ['--page', '--limit', '201'], 'limit', 1, 200],
    ['runtime serve', ['--token-file', 'never-read', '--port', '65536'], 'port', 0, 65535],
    ['runtime start', ['--token-file', 'never-read', '--port=-1'], 'port', 0, 65535],
    ['preview', ['never-read', '--serve', '--token-file', 'never-read', '--port', '1e2'], 'port', 0, 65535],
    ['runtime serve', ['--token-file', 'never-read', '--drain-wait-ms', '0'], 'drain-wait-ms', 1, 60000],
    ['doctor', ['--timeout-ms', '30001'], 'timeout-ms', 1, 30000],
    ['runtime request', ['never-read', '--endpoint', 'https://never-connect.invalid', '--token-file', 'never-read', '--timeout-ms', '0'], 'timeout-ms', 1, 3600000],
    ['tests suite run', ['never-read', '--suite-sha256', 'reviewed', '--endpoint', 'http://127.0.0.1:9999', '--token-file', 'never-read', '--timeout-ms', '1.0'], 'timeout-ms', 1, 3600000],
    ['runs watch', ['retained', '--endpoint', 'http://127.0.0.1:9999', '--token-file', 'never-read', '--interval-ms', '99'], 'interval-ms', 100, 60000],
    ['runs watch', ['retained', '--endpoint', 'http://127.0.0.1:9999', '--token-file', 'never-read', '--duration-ms', '+1'], 'duration-ms', 1, 3600000],
    ['runtime stop', ['--runtime', 'docker', '--owner-file', 'never-read', '--owner-sha256', 'reviewed', '--container-id', 'retained', '--wait-ms', '60001'], 'wait-ms', 0, 60000],
  ] as const)('refuses invalid %s integer bounds/encoding before I/O', async (path, flags, flag, minimum, maximum) => {
    const before = blocked.mock.calls.length
    const result = await cli([...path.split(' '), ...flags])
    expect(result.code, result.stderr).toBe(2)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toMatchObject({ code: 'invalid-input', message: `Use --${flag} a canonical decimal integer from ${minimum} to ${maximum}.` })
    expect(blocked.mock.calls.length).toBe(before)
  })

  it.each([['port', '1023', 1024, 65535], ['memory-mb', '127', 128, 65536], ['cpus', '65', 1, 64], ['wait-ms', '-1', 0, 60000]] as const)(
    'rejects Docker startup --%s before reading the receipt or staging credentials', async (flag, value, minimum, maximum) => {
      const before = blocked.mock.calls.length
      const values = { runtime: 'docker', 'image-receipt': 'never-read', 'receipt-sha256': 'reviewed', 'owner-file': 'never-written',
        port: '8443', 'token-file': 'never-read', 'tls-cert-file': 'never-read', 'tls-key-file': 'never-read', [flag]: value }
      const result = await cli(['runtime', 'start', ...Object.entries(values).map(([key, val]) => '--' + key + '=' + val)])
      expect(result.code, result.stderr).toBe(2)
      expect(JSON.parse(result.stderr).message).toBe(`Use --${flag} a canonical decimal integer from ${minimum} to ${maximum}.`)
      expect(blocked.mock.calls.length).toBe(before)
    })

  it('admits both endpoints of every numeric interval and exposes valid defaults without supplying or activating them', async () => {
    for (const path of CLI_HELP_PATHS) for (const variant of (await report(path)).variants) {
      const values: Record<string, string | boolean> = {}
      const sample = (flag: string) => variant.options[flag] === 'boolean' ? true
        : variant.requirements.rules.find((r: { kind: string; flag?: string }) => r.kind === 'choices' && r.flag === flag)?.values[0]
          ?? (variant.requirements.rules.some((r: { kind: string; flag?: string }) => r.kind === 'format' && r.flag === flag)
            ? formatSample(variant.requirements.rules.find((r: { kind: string; flag?: string }) => r.kind === 'format' && r.flag === flag).format) : undefined)
          ?? String(variant.requirements.rules.find((r: { kind: string; flag?: string }) => r.kind === 'integer' && r.flag === flag)?.minimum ?? 'not-read')
      for (const rule of variant.requirements.rules) {
        if (rule.kind === 'required' || rule.kind === 'together') for (const flag of rule.flags) values[flag] = sample(flag)
        if (rule.kind === 'fixed') values[rule.flag] = rule.value
        if (rule.kind === 'exactly-one') values[rule.flags[0]] = sample(rule.flags[0])
      }
      for (const rule of variant.requirements.rules.filter((r: { kind: string }) => r.kind === 'integer')) {
        expect(rule.encoding).toBe('canonical-unsigned-decimal')
        expect(Number.isSafeInteger(rule.minimum) && Number.isSafeInteger(rule.maximum)).toBe(true)
        for (const value of [rule.minimum, rule.maximum]) expect(() => validateCliFlagRequirements(path, { ...values, [rule.flag]: String(value) }, variant.options), `${path} --${rule.flag} ${value}`).not.toThrow()
        if (rule.defaultValue !== undefined) {
          expect(rule.defaultValue).toBeGreaterThanOrEqual(rule.minimum)
          expect(rule.defaultValue).toBeLessThanOrEqual(rule.maximum)
        }
      }
    }
    const options = (await report('doctor')).variants[0].options, values = {}
    validateCliFlagRequirements('doctor', values, options)
    expect(values).toEqual({})
  })

  it('matches generation/page domain limits and distinguishes ephemeral/local and required Docker ports', async () => {
    const rules = async (path: string) => (await report(path)).variants[0].requirements.rules
    const page = (await rules('runs list')).find((r: { kind: string; flag?: string }) => r.kind === 'integer' && r.flag === 'limit')
    const generation = (await rules('tests generate')).find((r: { kind: string; flag?: string }) => r.kind === 'integer' && r.flag === 'limit')
    for (const [rule, schema] of [[page, recordPageSchema.shape.limit], [generation, generateTestsSchema.shape.limit]]) {
      expect(schema.safeParse(rule.minimum).success).toBe(true)
      expect(schema.safeParse(rule.maximum).success).toBe(true)
      expect(schema.safeParse(rule.maximum + 1).success).toBe(false)
      expect(schema.parse(undefined)).toBe(rule.defaultValue)
    }
    const start = await report('runtime start')
    expect(start.variants[0].requirements.rules).toContainEqual({ kind: 'integer', flag: 'port', minimum: 0, maximum: 65535, defaultValue: 0, encoding: 'canonical-unsigned-decimal' })
    expect(start.variants[1].requirements.rules).toContainEqual({ kind: 'integer', flag: 'port', minimum: 1024, maximum: 65535, encoding: 'canonical-unsigned-decimal' })
    expect((await cli(['help', 'doctor'])).stdout).toContain('--timeout-ms: decimal integer 1..30000; default 3000')
  })

  it('isolates numeric metadata edits and refuses parser type drift', async () => {
    const options = (await report('projects accept')).variants[0].options
    const metadata = cliFlagRequirements('projects accept', options)
    const integer = metadata.rules.find(rule => rule.kind === 'integer' && rule.flag === 'expected-generation')!
    if (integer.kind !== 'integer') throw Error('Expected generation integer')
    integer.minimum = 0
    expect(() => validateCliFlagRequirements('projects accept', { 'expected-generation': '0', 'proposal-id': 'retained', revision: 'reviewed' }, options)).toThrow('from 1 to 9007199254740991')
    expect(() => cliFlagRequirements('doctor', { 'timeout-ms': 'boolean' })).toThrow('CLI integer bounds do not match the command parser.')
  })

  it.each([
    ['run', ['never-read', '--input', 'never-read', '--id', 'not-a-uuid'], 'id', 'uuid'],
    ['projects propose', [uuid, '--expected-generation', '1', '--file', 'never-read', '--proposal-id', 'not-a-uuid'], 'proposal-id', 'uuid'],
    ['projects delete', [uuid, '--expected-generation', '1', '--confirm-delete', 'not-a-uuid'], 'confirm-delete', 'uuid'],
    ['projects diff', [uuid, '--from', hash, '--to', hash.toUpperCase()], 'to', 'sha256'],
    ['import project', ['never-read', '--reviewed-sha256', 'sha256:' + hash], 'reviewed-sha256', 'sha256'],
    ['runs list', ['--page', '--after', 'not-a-uuid'], 'after', 'uuid'],
    ['providers audit', ['--page', '--after', '9223372036854775807'], 'after', 'audit-sequence'],
    ['runtime build-image', ['--runtime-sha256', 'short', '--base-image', 'never-inspected', '--platform', 'linux/arm64', '--tag', 'never-built', '--docker-context', 'never-contacted', '--output', 'never-written'], 'runtime-sha256', 'sha256'],
    ['runtime stop', ['--runtime', 'docker', '--owner-file', 'never-read', '--owner-sha256', hash, '--container-id', 'abc123'], 'container-id', 'docker-id'],
    ['approvals decide', [uuid, '--attempt', 'not-a-uuid', '--action', 'workflow-defined'], 'attempt', 'uuid'],
  ] as const)('refuses %s malformed retained/reviewed flags before I/O', async (path, flags, flag, format) => {
    const before = blocked.mock.calls.length
    const result = await cli([...path.split(' '), ...flags])
    expect(result.code, result.stderr).toBe(2)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toMatchObject({ code: 'invalid-input', message: `Use --${flag} ${cliArgumentFormatDescription(format)}.` })
    expect(blocked.mock.calls.length).toBe(before)
  })

  it('checks every advertised flag/positional format through actual dispatch without I/O, and does not reinterpret file/template/credential arguments', async () => {
    const before = blocked.mock.calls.length
    for (const path of CLI_HELP_PATHS) for (const variant of (await report(path)).variants) {
      const values: Record<string, string | boolean> = {}
      const sample = (flag: string) => variant.options[flag] === 'boolean' ? true
        : variant.requirements.rules.find((r: { kind: string; flag?: string }) => r.kind === 'choices' && r.flag === flag)?.values[0]
          ?? variant.requirements.rules.find((r: { kind: string; flag?: string }) => r.kind === 'integer' && r.flag === flag)?.minimum?.toString()
          ?? (variant.requirements.rules.some((r: { kind: string; flag?: string }) => r.kind === 'format' && r.flag === flag)
            ? formatSample(variant.requirements.rules.find((r: { kind: string; flag?: string }) => r.kind === 'format' && r.flag === flag).format) : 'never-read')
      for (const rule of variant.requirements.rules) {
        if (rule.kind === 'required' || rule.kind === 'together') for (const flag of rule.flags) values[flag] = sample(flag)
        if (rule.kind === 'fixed') values[rule.flag] = rule.value
        if (rule.kind === 'exactly-one') values[rule.flags[0]] = sample(rule.flags[0])
      }
      const positionals = Array.from({ length: variant.positionalCount }, (_, index) => variant.requirements.positionals.some((r: { index: number }) => r.index === index) ? uuid : 'never-read')
      const argv = (fields: Record<string, string | boolean>, args: string[] = positionals) => [...path.split(' '), ...args,
        ...Object.entries(fields).map(([key, value]) => variant.options[key] === 'boolean' ? `--${key}` : `--${key}=${value}`)]
      for (const rule of variant.requirements.rules.filter((r: { kind: string }) => r.kind === 'format')) {
        expect(() => validateCliFlagRequirements(path, { ...values, [rule.flag]: formatSample(rule.format) }, variant.options, positionals)).not.toThrow()
        const refused = await cli(argv({ ...values, [rule.flag]: 'never-valid-sensitive-input' }))
        expect(refused.code, refused.stderr).toBe(2)
        expect(refused.stdout).toBe('')
        expect(JSON.parse(refused.stderr).message).toBe(`Use --${rule.flag} ${cliArgumentFormatDescription(rule.format)}.`)
      }
      for (const rule of variant.requirements.positionals) {
        expect(() => validateCliFlagRequirements(path, values, variant.options, positionals)).not.toThrow()
        const refused = await cli(argv(values, positionals.map((arg, index) => index === rule.index ? 'never-valid-sensitive-input' : arg)))
        expect(refused.code, refused.stderr).toBe(2)
        expect(refused.stdout).toBe('')
        expect(JSON.parse(refused.stderr).message).toBe('Use positional argument 1 a UUID.')
      }
    }
    expect(blocked.mock.calls.length).toBe(before)
    for (const path of ['run', 'validate', 'projects create', 'tests create', 'tests suite run', 'runtime save-image', 'approvals notify send', 'templates render', 'credentials set', 'import project']) {
      expect((await report(path)).variants.every((v: { requirements: { positionals: unknown[] } }) => !v.requirements.positionals.length)).toBe(true)
    }
    expect((await report('tests result')).variants[0].positionalArguments).toEqual(['run-id'])
  })

  it('matches UUID/domain hash/cursor acceptance without normalizing or rewriting retained identities', async () => {
    const options = (await report('run')).variants[0].options
    for (const id of [uuid, uuid.toUpperCase(), '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      'ea953a2f-2d9c-82ad-9910-9c4fb2708d21', 'ea953a2f-2d9c-42ad-7910-9c4fb2708d21', 'not-a-uuid', ' ' + uuid]) {
      const values = { input: 'never-read', id }, original = { ...values }
      const admission = () => validateCliFlagRequirements('run', values, options)
      if (z.uuid().safeParse(id).success) expect(admission).not.toThrow(); else expect(admission).toThrow('a UUID')
      expect(values).toEqual(original)
    }
    for (const path of ['runs list', 'providers audit']) {
      const schema = path === 'providers audit' ? auditPageSchema.shape.after : recordPageSchema.shape.after
      const options = (await report(path)).variants[0].options
      for (const after of [uuid, '0', '1', '01', '-1', '+1', '9223372036854775806', '9223372036854775807', ' 1']) {
        const admission = () => validateCliFlagRequirements(path, { page: true, after }, options)
        if (schema.safeParse(after).success) expect(admission).not.toThrow(); else expect(admission).toThrow('Use --after')
      }
    }
    const optionsHash = (await report('runs inspect-bundle')).variants[0].options
    for (const sha256 of [hash, '0'.repeat(64), hash.toUpperCase(), 'sha256:' + hash, 'a'.repeat(63), 'a'.repeat(65), hash + '\n']) {
      const admission = () => validateCliFlagRequirements('runs inspect-bundle', { sha256 }, optionsHash)
      if (testIdentityHash(sha256)) expect(admission).not.toThrow(); else expect(admission).toThrow('lowercase hexadecimal SHA-256')
    }
    expect((await cli(['help', 'projects', 'show'])).stdout).toContain('<project-id>: a UUID')
    expect((await cli(['help', 'runtime', 'stop'])).stdout).toContain('--container-id: a full 64-character lowercase hexadecimal Docker ID')
  })

  it('isolates returned format metadata and fails closed on flag type/positional-count drift', async () => {
    const options = (await report('run')).variants[0].options
    const metadata = cliFlagRequirements('run', options)
    const rule = metadata.rules.find(r => r.kind === 'format' && r.flag === 'id')!
    if (rule.kind !== 'format') throw Error('Expected UUID rule')
    rule.format = 'audit-sequence'
    expect(() => validateCliFlagRequirements('run', { input: 'never-read', id: '0' }, options)).toThrow('Use --id a UUID.')
    expect(() => cliFlagRequirements('run', { input: 'string', id: 'boolean' })).toThrow('CLI argument formats do not match')
    expect(() => cliPositionalRequirements('projects show', 0)).toThrow('CLI positional formats do not match')
  })

  it.each([
    ['run', 'never-read', '--input', 'never-read', '--id', uuid, '--endpoint', 'https://never-connect.invalid', '--token-file', 'never-read', '--data-dir', 'never-created'],
    ['projects', 'create', 'never-read', '--title', 'Fixture', '--endpoint', 'https://never-connect.invalid', '--token-file', 'never-read', '--runtime', 'local'],
    ['projects', 'propose', uuid, '--expected-generation', '1', '--file', 'never-read', '--runtime', 'local', '--token-file', 'never-read'],
    ['import', 'project', 'never-read', '--reviewed-sha256', hash, '--id', uuid, '--endpoint', 'https://never-connect.invalid', '--token-file', 'never-read', '--data-dir', 'never-created'],
    ['import', 'inspect', 'never-read', '--endpoint', 'https://never-connect.invalid', '--token-file', 'never-read', '--storage', 'postgres', '--database-file', 'never-read'],
    ['providers', 'set', 'never-read', '--expected-generation', '0', '--endpoint', 'https://never-connect.invalid', '--token-file', 'never-read', '--telemetry-file', 'never-read'],
    ['credentials', 'set', 'fixture/key', '--expected-generation', '0', '--stdin', '--runtime', 'docker', '--owner-file', 'never-read', '--owner-sha256', hash, '--container-id', hash, '--token-file', 'never-read', '--storage', 'sqlite'],
    ['tests', 'suite', 'run', 'never-read', '--suite-sha256', hash, '--endpoint', 'http://127.0.0.1:9999', '--token-file', 'never-read', '--data-dir', 'never-created'],
    ['tests', 'suite', 'result', 'never-read', '--endpoint', 'http://127.0.0.1:9999', '--token-file', 'never-read', '--instance-id', uuid],
    ['tests', 'suite', 'result', 'never-read', '--endpoint', 'https://never-connect.invalid', '--token-file', 'never-read', '--runtime', 'local'],
    ['tests', 'suite', 'run', 'never-read', '--suite-sha256', hash, '--ca-file', 'never-read'],
    ['preview', 'never-read', '--serve', '--token-file', 'never-read', '--trace-viewer-file', 'never-read', '--runtime', 'local', '--timeout-ms', '3000'],
    ['preview', 'never-read', '--serve', '--token-file', 'never-read', '--project-id', uuid, '--storage', 'postgres', '--database-file', 'never-read', '--data-dir', 'never-created'],
    ['preview', 'never-read', '--serve', '--token-file', 'never-read', '--preview-token-file', 'never-read', '--project-id', uuid, '--endpoint', 'https://never-connect.invalid', '--storage', 'sqlite'],
    ['preview', 'never-read', '--output', 'never-written', '--runtime', 'local', '--trace-viewer-file', 'never-read'],
    ['doctor', '--endpoint', 'http://127.0.0.1:9999', '--token-file', 'never-read', '--data-dir', 'never-created'],
    ['doctor', '--ca-file', 'never-read'],
    ['runtime', 'serve', '--token-file', 'never-read', '--storage', 'postgres', '--database-file', 'never-read', '--data-dir', 'never-created'],
  ])('refuses mixed target selection %j before workflow/manifest/config/credential reads', async (...argv) => {
    const before = blocked.mock.calls.length
    const result = await cli(argv)
    expect(result.code, result.stderr).toBe(2)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr).code).toBe('invalid-input')
    expect(result.stderr).not.toContain('never-read')
    expect(result.stderr).not.toContain('never-connect.invalid')
    expect(blocked.mock.calls.length).toBe(before)
  })

  it('preserves each consuming mode without opening owners or changing submitted values', () => {
    const before = blocked.mock.calls.length
    const docker = { runtime: 'docker', 'owner-file': 'never-read', 'owner-sha256': hash, 'container-id': hash, 'token-file': 'never-read' }
    const remote = { endpoint: 'https://never-connect.invalid', 'token-file': 'never-read', 'instance-id': uuid }
    for (const values of [{}, { runtime: 'local' }, { storage: 'postgres', 'database-file': 'never-read' }, docker, remote]) {
      const copy = { ...values }
      expect(() => operationSelection(values)).not.toThrow()
      expect(values).toEqual(copy)
    }
    expect(suiteSelection({})).toBe('local')
    expect(suiteSelection({ endpoint: 'http://127.0.0.1:9999', 'token-file': 'never-read' })).toBe('http')
    expect(suiteSelection(remote)).toBe('selected')
    expect(suiteSelection(docker)).toBe('selected')
    expect(previewSelection({ 'token-file': 'never-read' })).toEqual({ selection: 'sqlite', port: 0 })
    expect(previewSelection({ 'token-file': 'never-read', storage: 'postgres', 'database-file': 'never-read', 'project-id': uuid })).toEqual({ selection: 'postgres', port: 0 })
    expect(previewSelection({ ...docker, 'preview-token-file': 'never-read', 'project-id': uuid })).toEqual({ selection: 'docker', port: 0 })
    expect(previewSelection({ ...remote, 'preview-token-file': 'never-read', 'project-id': uuid })).toEqual({ selection: 'remote', port: 0 })
    expect(doctorSelection({}).storage).toBe('sqlite')
    expect(doctorSelection({ endpoint: 'http://127.0.0.1:9999', 'token-file': 'never-read' }).storage).toBeUndefined()
    expect(blocked.mock.calls.length).toBe(before)
  })

  it('keeps caller mutation of returned requirement metadata out of later admission', async () => {
    const options = (await report('run')).variants[0].options
    const metadata = cliFlagRequirements('run', options)
    const condition = metadata.rules.find(rule => rule.kind === 'required' && rule.flags.includes('id'))!
    if (!('when' in condition) || !condition.when || !('any' in condition.when)) throw Error('Expected owner condition')
    const previous = condition.when.any
    try {
      condition.when.any = []
      expect(() => validateCliFlagRequirements('run', { input: 'input.json', runtime: 'docker', 'owner-file': 'owner',
        'owner-sha256': 'reviewed', 'container-id': 'retained', 'token-file': 'token' }, options)).toThrow('Provide --id.')
    } finally { condition.when.any = previous }
  })
})
