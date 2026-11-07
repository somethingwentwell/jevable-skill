import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, readdir, symlink, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { LocalRuntime } from '../src/runtime/local.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { buildReleaseImage, saveReleaseImage } from '../src/images/service.ts'
import { dockerCommand, ImageError, type DockerCommand } from '../src/images/docker.ts'

const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const bytes = Buffer.from('export const fixture = true;'), sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const artifact = { bytes, storage: 'sqlite' as const, notices: Buffer.from('Test runtime, not executable qualification'), identity: { version: CORE_VERSION, sha256: sha(bytes) } }
const input = { context: 'local-fixture', platform: 'linux/arm64' as const, baseImage: `node@sha256:${'a'.repeat(64)}`, tag: 'jevable-test/workflow:1' }
const id = `sha256:${'b'.repeat(64)}`
const configId = `sha256:${'c'.repeat(64)}`
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-image-test-')), runtime = await LocalRuntime.open({ dataDirectory: join(directory, 'state') })
  const project = runtime.editProject({ operation: 'create', title: 'Fixture image', yaml: source, actor: 'local:test' })
  runtime.setCredential('fixture/key', 'PRIVATE_STATE_SECRET', 0, 'local:test')
  const release = runtime.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
    version: '1.0.0', actor: 'local:test', runtime: artifact.identity }); await runtime.close()
  const commands: string[][] = [], contexts: string[][] = []
  let labels: Record<string, string> = {}, tags = 0
  const faults = { endpoint: 'unix:///fixture/docker.sock', driver: 'docker', exists: false, conflictAtPublish: false,
    badLabels: false, onBuild: false, baseArch: 'arm64', streamFailure: false, overLimit: false, changeAfterSave: false, classic: false }
  const chunk = Buffer.alloc(2048, 7)
  const run: DockerCommand = async (args, options = {}) => {
    commands.push(args)
    if (args[0] === 'context') return JSON.stringify({ Host: faults.endpoint, SkipTLSVerify: false })
    const action = args.slice(2)
    if (action[0] === 'version') return JSON.stringify({ Version: 'test', Os: 'linux' })
    if (action[0] === 'buildx' && action[1] === 'ls') return JSON.stringify({ Name: input.context, Driver: faults.driver,
      Nodes: [{ Endpoint: input.context, Status: 'running' }] })
    if (action[0] === 'image' && action[1] === 'ls') { tags++; return faults.exists || (faults.conflictAtPublish && tags > 1) ? '{}' : '' }
    if (action[0] === 'image' && action[1] === 'inspect') {
      if (action[2] === input.baseImage) return JSON.stringify([{ Id: `sha256:${'a'.repeat(64)}`, Os: 'linux', Architecture: faults.baseArch,
        Config: { OnBuild: faults.onBuild ? ['RUN unexpected'] : [] } }])
      if (faults.classic && action[2] === id) throw new ImageError('docker-command-failed')
      if (!faults.classic && action[2] === configId) throw new ImageError('docker-command-failed')
      return JSON.stringify([{ Id: faults.classic ? configId : id, Os: 'linux', Architecture: 'arm64', Config: { User: 'node', WorkingDir: '/app',
        Entrypoint: ['node', 'app.mjs'], Labels: faults.badLabels ? {} : labels } }])
    }
    if (action[0] === 'buildx' && action[1] === 'build') {
      const context = args.at(-1)!, names = await readdir(context); contexts.push(names)
      for (const name of names) expect(await readFile(join(context, name), 'utf8')).not.toContain('PRIVATE_STATE_SECRET')
      labels = Object.fromEntries(args.flatMap((value, index) => value === '--label' ? [args[index + 1]!.split(/=(.*)/su).slice(0, 2)] : []))
      await writeFile(args[args.indexOf('--iidfile') + 1]!, configId)
      await writeFile(args[args.indexOf('--metadata-file') + 1]!, JSON.stringify({ 'containerimage.digest': id, 'containerimage.config.digest': configId })); return ''
    }
    if (action[0] === 'image' && action[1] === 'tag') return ''
    if (action[0] === 'image' && action[1] === 'save') {
      if (faults.overLimit) await options.consumeStdout!({ length: 4_000_000_001 } as Buffer)
      await options.consumeStdout!(chunk)
      if (faults.streamFailure) throw Error('fixture save failure')
      await options.consumeStdout!(chunk)
      if (faults.changeAfterSave) faults.badLabels = true
      return ''
    }
    throw Error('Unexpected fixture Docker operation')
  }
  return { directory, release, run, commands, contexts, faults, chunk }
}

describe('explicit local image packaging', () => {
  it('resolves classic config IDs as well as containerd manifest IDs from exact build metadata', async () => {
    const f = await fixture(); f.faults.classic = true
    const image = await buildReleaseImage(f.release, artifact, input, f.run)
    expect(image.imageId).toBe(configId)
    expect(f.commands.find(args => args[3] === 'tag')?.[4]).toBe(configId)
  })
  it('builds only a fresh owned allowlist with pinned identities and no push or implicit workflow execution', async () => {
    const f = await fixture(), image = await buildReleaseImage(f.release, artifact, input, f.run)
    expect(image).toMatchObject({ imageId: id, baseImage: input.baseImage, platform: 'linux/arm64', releaseSha256: f.release.sha256,
      runtime: artifact.identity, execution: 'not-run', publication: 'local-daemon-only' })
    expect(f.contexts[0]!.sort()).toEqual(['.dockerignore', '.env.example', 'Dockerfile', 'NOTICES.txt', 'README.txt', 'app.mjs', 'compose.yaml',
      'configuration.json', 'manifest.json', 'release.json', 'runtime.mjs', 'workflow.yaml'].sort())
    const build = f.commands.find(args => args.includes('--load'))!
    expect(build).toEqual(expect.arrayContaining(['--network', 'none', '--platform', 'linux/arm64', '--builder', input.context, '--provenance=false']))
    expect(f.commands.flat()).not.toContain('--push'); expect(f.commands.flat()).not.toContain('run')
    await expect(lstat(build.at(-1)!)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('checks exact release/runtime bytes before contacting Docker', async () => {
    const f = await fixture()
    await expect(buildReleaseImage({ ...f.release, sha256: '0'.repeat(64) }, artifact, input, f.run)).rejects.toThrow('conflict')
    await expect(buildReleaseImage(f.release, { ...artifact, bytes: Buffer.from('changed') }, input, f.run)).rejects.toThrow('conflict')
    expect(f.commands).toHaveLength(0)
  })
  it.each([{ tag: 'repo:123:tag' }, { tag: 'repo:tag;touch /tmp/x' }, { baseImage: 'node:latest' }, { platform: 'windows/amd64' }, { context: '--host' }])('refuses invalid image options %j', async change => {
    const f = await fixture()
    await expect(buildReleaseImage(f.release, artifact, { ...input, ...change } as any, f.run)).rejects.toMatchObject({ code: 'invalid-image-options' })
    expect(f.commands).toHaveLength(0)
  })
  it.each(['remote', 'builder', 'tag', 'on-build', 'architecture'] as const)('refuses an unsafe or conflicting %s before building', async fault => {
    const f = await fixture()
    if (fault === 'remote') f.faults.endpoint = 'ssh://remote.example'
    if (fault === 'builder') f.faults.driver = 'docker-container'
    if (fault === 'tag') f.faults.exists = true
    if (fault === 'on-build') f.faults.onBuild = true
    if (fault === 'architecture') f.faults.baseArch = 'amd64'
    await expect(buildReleaseImage(f.release, artifact, input, f.run)).rejects.toThrow()
    expect(f.commands.some(args => args.includes('--load'))).toBe(false)
  })
  it.each(['labels', 'tag-race'])('refuses to publish a built image with %s mismatch', async fault => {
    const f = await fixture()
    if (fault === 'labels') f.faults.badLabels = true; else f.faults.conflictAtPublish = true
    await expect(buildReleaseImage(f.release, artifact, input, f.run)).rejects.toThrow()
    expect(f.commands.some(args => args[3] === 'tag')).toBe(false)
  })
  it('streams the immutable image ID atomically with an archive checksum, refusing existing output by default', async () => {
    const f = await fixture(), image = await buildReleaseImage(f.release, artifact, input, f.run), output = join(f.directory, 'image.tar')
    const saved = await saveReleaseImage(image, output, false, f.run)
    expect(saved.artifact).toEqual({ path: output, bytes: 4096, sha256: sha(Buffer.concat([f.chunk, f.chunk])) })
    expect(f.commands.find(args => args[3] === 'save')).toEqual(['--context', input.context, 'image', 'save', id])
    await expect(saveReleaseImage(image, output, false, f.run)).rejects.toMatchObject({ code: 'image-conflict' })
    expect((await lstat(output)).mode & 0o777).toBe(0o600)
    expect((await readdir(f.directory)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
  it.each(['stream', 'limit', 'identity'] as const)('does not publish partial or mismatched archive after %s failure', async failure => {
    const f = await fixture(), image = await buildReleaseImage(f.release, artifact, input, f.run), output = join(f.directory, 'image.tar')
    await writeFile(output, 'original')
    if (failure === 'stream') f.faults.streamFailure = true
    if (failure === 'limit') f.faults.overLimit = true
    if (failure === 'identity') f.faults.changeAfterSave = true
    await expect(saveReleaseImage(image, output, true, f.run)).rejects.toThrow()
    expect(await readFile(output, 'utf8')).toBe('original')
    expect((await readdir(f.directory)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
  it('refuses dangling symlinks and replaces the link itself only with explicit overwrite', async () => {
    const f = await fixture(), image = await buildReleaseImage(f.release, artifact, input, f.run)
    const output = join(f.directory, 'link.tar'), target = join(f.directory, 'never-write-here')
    await symlink(target, output)
    await expect(saveReleaseImage(image, output, false, f.run)).rejects.toMatchObject({ code: 'image-conflict' })
    await saveReleaseImage(image, output, true, f.run)
    expect((await lstat(output)).isSymbolicLink()).toBe(false)
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('bounded Docker child process', () => {
  async function executable(body: string) {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-fake-docker-'))
    await writeFile(join(directory, 'docker'), `#!${process.execPath}\n${body}`, { mode: 0o700 })
    vi.stubEnv('PATH', directory + delimiter + process.env.PATH)
  }
  it('passes literal arguments without a shell and removes ambient daemon/builder overrides', async () => {
    await executable('process.stdout.write(JSON.stringify({args:process.argv.slice(2),host:process.env.DOCKER_HOST,builder:process.env.BUILDX_BUILDER}));')
    vi.stubEnv('DOCKER_HOST', 'PRIVATE_REMOTE'); vi.stubEnv('BUILDX_BUILDER', 'PRIVATE_REMOTE')
    const result = JSON.parse(await dockerCommand(['--context', 'local', 'literal;$(not-a-shell)']))
    expect(result.args).toEqual(['--context', 'local', 'literal;$(not-a-shell)']); expect(JSON.stringify(result)).not.toContain('PRIVATE_REMOTE')
  })
  it('does not expose raw daemon error text', async () => {
    await executable('process.stderr.write("PRIVATE_REGISTRY_ERROR");process.exitCode=1;')
    await expect(dockerCommand(['fixture'])).rejects.toMatchObject({ code: 'docker-command-failed' })
  })
  it('pipes bounded private input without placing it in arguments', async () => {
    await executable('let n=0;process.stdin.on("data",b=>n+=b.length);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({n,args:process.argv.slice(2)})));')
    expect(JSON.parse(await dockerCommand(['fixture'], { input: Buffer.alloc(900000, 1) }))).toEqual({ n: 900000, args: ['fixture'] })
    await expect(dockerCommand(['fixture'], { input: Buffer.alloc(1000001) })).rejects.toMatchObject({ code: 'invalid-image-options' })
  })
  it('settles private stdin on early exit, timeout and unavailable executable', async () => {
    await executable('process.exit(1)')
    await expect(dockerCommand(['fixture'], { input: Buffer.alloc(1000000) })).rejects.toMatchObject({ code: 'docker-command-failed' })
    await executable('setInterval(()=>{},1000)')
    await expect(dockerCommand(['fixture'], { timeoutMs: 50, input: Buffer.alloc(1000000) })).rejects.toThrow()
    vi.stubEnv('PATH', '/nonexistent-jevable-fixture')
    await expect(dockerCommand(['fixture'], { input: Buffer.from('PRIVATE') })).rejects.toThrow()
  })
  it('bounds command output and kills a timed-out child', async () => {
    await executable('process.stdout.write(Buffer.alloc(2000001));')
    await expect(dockerCommand(['fixture'])).rejects.toMatchObject({ code: 'docker-output-limit' })
    await executable('setInterval(()=>{},1000);')
    await expect(dockerCommand(['fixture'], { timeoutMs: 50 })).rejects.toMatchObject({ code: 'docker-timeout' })
  })
})
