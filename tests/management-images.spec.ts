import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, readFile, readdir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { CORE_VERSION } from '../src/capabilities.ts'
import { buildManagementImage, saveManagementImage, inspectManagementImageReceipt } from '../src/images/management.ts'
import { inspectImageReceipt } from '../src/images/service.ts'
import { ImageError, type DockerCommand } from '../src/images/docker.ts'
import { main } from '../src/cli.ts'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const program = Buffer.from('export const fixture = true;'), runtimeSha = hash(program)
const options = { context: 'local-fixture', platform: 'linux/arm64' as const, baseImage: `node@sha256:${'a'.repeat(64)}`, tag: 'jevable-test/management:1' }
const id = `sha256:${'b'.repeat(64)}`, configId = `sha256:${'c'.repeat(64)}`
const read = async (path: string) => {
  const name = basename(path)
  return name.endsWith('.mjs') ? program : name.endsWith('.txt') ? Buffer.from('Fixture notice')
    : Buffer.from(JSON.stringify({ schemaVersion: 1, coreVersion: CORE_VERSION, storage: name.startsWith('core') ? 'management' : name.includes('postgres') ? 'postgres' : 'sqlite',
      sha256: runtimeSha, bytes: program.length, external: 'node-builtins-only' }))
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-management-image-test-')), commands: string[][] = []
  let labels: Record<string, string> = {}, context = '', tagged = false
  const faults = { classic: false, mismatch: '', stream: false, remote: false, tagRace: false }
  const run: DockerCommand = async (args, opts = {}) => {
    commands.push(args)
    if (args[0] === 'context') return JSON.stringify({ Host: faults.remote ? 'ssh://remote.invalid' : 'unix:///fixture/docker.sock' })
    const a = args.slice(2)
    if (a[0] === 'version') return JSON.stringify({ Os: 'linux', Version: 'fixture' })
    if (a[0] === 'buildx' && a[1] === 'ls') return JSON.stringify({ Name: options.context, Driver: 'docker', Nodes: [{ Endpoint: options.context, Status: 'running' }] })
    if (a[0] === 'image' && a[1] === 'ls') return context && faults.tagRace ? '{}' : ''
    if (a[0] === 'buildx' && a[1] === 'build') {
      context = args.at(-1)!
      expect((await readdir(context)).sort()).toEqual(['.dockerignore', 'Dockerfile', 'README.txt', 'bin', 'dist', 'manifest.json'])
      expect((await readdir(join(context, 'dist', 'management'))).sort()).toEqual(['core-NOTICES.txt', 'core-runtime.json', 'core-runtime.mjs'])
      expect(await readFile(join(context, 'Dockerfile'), 'utf8')).toContain('CMD ["capabilities"]')
      expect(await readFile(join(context, 'Dockerfile'), 'utf8')).not.toContain('npm install')
      labels = Object.fromEntries(args.flatMap((v, i) => v === '--label' ? [args[i + 1]!.split(/=(.*)/su).slice(0, 2)] : []))
      await writeFile(args[args.indexOf('--iidfile') + 1]!, configId)
      await writeFile(args[args.indexOf('--metadata-file') + 1]!, JSON.stringify({ 'containerimage.digest': id, 'containerimage.config.digest': configId }))
      return ''
    }
    if (a[0] === 'image' && a[1] === 'inspect') {
      if (a[2] === options.baseImage) return JSON.stringify([{ Id: `sha256:${'a'.repeat(64)}`, Os: 'linux', Architecture: 'arm64', Config: {} }])
      if (faults.classic && a[2] === id) throw new ImageError('docker-command-failed')
      const config: Record<string, unknown> = { User: 'node', WorkingDir: '/app', Entrypoint: ['node', 'bin/jevable.mjs'], Cmd: ['capabilities'],
        StopSignal: 'SIGTERM', Healthcheck: { Test: ['NONE'] }, Labels: labels }
      if (faults.mismatch) config[faults.mismatch] = 'wrong'
      return JSON.stringify([{ Id: faults.classic ? configId : id, Os: 'linux', Architecture: 'arm64', Config: config }])
    }
    if (a[0] === 'image' && a[1] === 'tag') { tagged = true; return '' }
    if (a[0] === 'image' && a[1] === 'save') {
      await opts.consumeStdout!(Buffer.alloc(2048, 3)); if (faults.stream) throw Error('fixture stream failure'); return ''
    }
    throw Error('Unexpected Docker call')
  }
  return { directory, commands, run, faults, context: () => context, tagged: () => tagged }
}
describe('management image packaging', () => {
  it.each([false, true])('builds fixed program assets and a distinct pinned receipt (classic=%s)', async classic => {
    const f = await fixture(); f.faults.classic = classic
    const receipt = await buildManagementImage(runtimeSha, options, f.run, read)
    expect(receipt).toMatchObject({ format: 'jevable.ai/management-image-receipt', coreVersion: CORE_VERSION, imageId: classic ? configId : id,
      state: 'excluded', credentials: 'excluded', execution: 'not-run', publication: 'local-daemon-only' })
    expect(receipt.runtimes.map(r => r.role)).toEqual(['management', 'sqlite', 'postgres'])
    expect(f.commands.flat()).not.toContain('run'); expect(f.commands.flat()).not.toContain('--push')
    expect(f.commands.find(a => a.includes('--load'))).toEqual(expect.arrayContaining(['--network', 'none', '--builder', options.context]))
    expect(f.tagged()).toBe(true)
    await expect(lstat(f.context())).rejects.toMatchObject({ code: 'ENOENT' })
    expect(() => inspectImageReceipt(receipt)).toThrow()
    expect(() => inspectManagementImageReceipt({ ...receipt, format: 'jevable.ai/image-receipt', releaseId: 'not-a-management-image' })).toThrow()
  })
  it('rejects wrong program identity and invalid options before Docker', async () => {
    const f = await fixture()
    await expect(buildManagementImage('0'.repeat(64), options, f.run, read)).rejects.toMatchObject({ code: 'image-mismatch' })
    await expect(buildManagementImage(runtimeSha, { ...options, baseImage: 'node:latest' }, f.run, read)).rejects.toMatchObject({ code: 'invalid-image-options' })
    expect(f.commands).toHaveLength(0)
  })
  it.each(['User', 'WorkingDir', 'Entrypoint', 'Cmd', 'StopSignal', 'Healthcheck', 'Labels', 'OnBuild'])('rejects changed %s before tagging', async field => {
    const f = await fixture(); f.faults.mismatch = field
    await expect(buildManagementImage(runtimeSha, options, f.run, read)).rejects.toMatchObject({ code: 'image-mismatch' })
    expect(f.tagged()).toBe(false)
    await expect(lstat(f.context())).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['remote', 'tagRace'] as const)('refuses %s without publishing', async fault => {
    const f = await fixture(); f.faults[fault] = true
    await expect(buildManagementImage(runtimeSha, options, f.run, read)).rejects.toThrow()
    expect(f.tagged()).toBe(false)
  })
  it('saves only the verified immutable management image ID and preserves existing files on failure', async () => {
    const f = await fixture(), receipt = await buildManagementImage(runtimeSha, options, f.run, read), output = join(f.directory, 'management.tar')
    const saved = await saveManagementImage(receipt, output, false, f.run)
    expect(saved.format).toBe('jevable.ai/management-image-archive')
    expect(saved.artifact.sha256).toBe(hash(Buffer.alloc(2048, 3)))
    expect(f.commands.find(a => a[3] === 'save')?.[4]).toBe(id)
    await expect(saveManagementImage(receipt, output, false, f.run)).rejects.toMatchObject({ code: 'image-conflict' })
    f.faults.stream = true
    await expect(saveManagementImage(receipt, output, true, f.run)).rejects.toThrow()
    expect(hash(await readFile(output))).toBe(saved.artifact.sha256)
    expect((await readdir(f.directory)).filter(n => n.endsWith('.tmp'))).toEqual([])
    expect((await lstat(output)).mode & 0o777).toBe(0o600)
  })
  it('save revalidates the role-specific image configuration before streaming', async () => {
    const f = await fixture(), receipt = await buildManagementImage(runtimeSha, options, f.run, read)
    f.faults.mismatch = 'Entrypoint'
    await expect(saveManagementImage(receipt, join(f.directory, 'bad.tar'), false, f.run)).rejects.toMatchObject({ code: 'image-mismatch' })
    expect(f.commands.some(a => a[3] === 'save')).toBe(false)
  })
  it.each(['build-image', 'save-image'])('CLI %s rejects missing parameters without state or Docker access', async action => {
    let err = ''
    expect(await main(['runtime', action], { out: () => { throw Error() }, err: value => { err += value } })).toBe(2)
    expect(JSON.parse(err).code).toBe('invalid-input')
  })
})
