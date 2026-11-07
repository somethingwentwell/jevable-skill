import { afterEach, describe, expect, it, vi } from 'vitest'
import { lstat, readFile, readdir, writeFile, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { buildLocalImage, type ImageBuildOptions } from '../src/images/local.ts'
import { ImageError, type DockerCommand } from '../src/images/docker.ts'
import * as images from '../src/images/index.ts'
import { main } from '../src/cli.ts'
import * as releaseFiles from '../src/packages/release-zip.ts'
import { CORE_VERSION } from '../src/capabilities.ts'

afterEach(() => vi.restoreAllMocks())

const options: ImageBuildOptions = { context: 'recovery-fixture', platform: 'linux/arm64',
  baseImage: `node@sha256:${'a'.repeat(64)}`, tag: 'recovery-fixture/app:1' }
const imageId = `sha256:${'b'.repeat(64)}`

function fixture(fault?: 'timeout' | 'command' | 'metadata' | 'tag' | 'unexpected' | 'verify-tag' | 'preflight') {
  const commands: string[][] = []
  let directory = '', observationBeforeBuild: any, builderInventoryTimeoutMs: number | undefined
  const run: DockerCommand = async (args, commandOptions) => {
    commands.push(args)
    if (args[0] === 'context') return JSON.stringify({ Host: 'unix:///synthetic.sock' })
    const command = args.slice(2)
    if (command[0] === 'version') return JSON.stringify({ Os: 'linux', Version: 'synthetic' })
    if (command[0] === 'image' && command[1] === 'ls') return fault === 'preflight' ? '{}' : ''
    if (command[0] === 'buildx' && command[1] === 'ls') {
      builderInventoryTimeoutMs = commandOptions?.timeoutMs
      return JSON.stringify({ Name: options.context, Driver: 'docker',
        Nodes: [{ Endpoint: options.context, Status: 'running' }] })
    }
    if (command[0] === 'image' && command[1] === 'inspect') return JSON.stringify([{ Id: imageId, Os: 'linux', Architecture: 'arm64', Config: {} }])
    if (command[0] === 'buildx' && command[1] === 'build') {
      directory = args[args.indexOf('--iidfile') + 1]!.slice(0, -'/image.id'.length)
      observationBeforeBuild = JSON.parse(await readFile(`${directory}/build-observation.json`, 'utf8'))
      if (fault === 'timeout') throw new ImageError('docker-timeout')
      if (fault === 'command') throw new ImageError('docker-command-failed')
      if (fault === 'unexpected') throw Error('PRIVATE_DAEMON_MESSAGE')
      await writeFile(`${directory}/image.id`, imageId)
      await writeFile(`${directory}/build.json`, fault === 'metadata' ? '{}' : JSON.stringify({
        'containerimage.digest': imageId, 'containerimage.config.digest': imageId }))
      return ''
    }
    if (command[0] === 'image' && command[1] === 'tag') {
      if (fault === 'tag') throw new ImageError('docker-command-failed')
      return ''
    }
    throw Error('Unexpected synthetic command')
  }
  let verified = 0
  const verify = () => { if (++verified === 2 && fault === 'verify-tag') throw new ImageError('image-mismatch') }
  const build = () => buildLocalImage(options, { Dockerfile: Buffer.from('FROM synthetic\n'), 'app.mjs': Buffer.from('owned synthetic program') }, {}, verify, run)
  return { build, commands, directory: () => directory, observationBeforeBuild: () => observationBeforeBuild,
    builderInventoryTimeoutMs: () => builderInventoryTimeoutMs }
}

describe('failed image builds retain exact owned recovery evidence', () => {
  it.each([
    ['timeout', 'docker-timeout', 'build'], ['command', 'docker-command-failed', 'build'],
    ['unexpected', 'image-build-failed', 'build'], ['metadata', 'invalid-image-options', 'verify-image'],
    ['tag', 'docker-command-failed', 'publish-tag'], ['verify-tag', 'image-mismatch', 'verify-tag'],
  ] as const)('retains %s without replay, cleanup, raw daemon text or false completion', async (fault, code, phase) => {
    const f = fixture(fault)
    let failure: ImageError | undefined
    try { await f.build() } catch (error) { expect(error).toBeInstanceOf(ImageError); failure = error as ImageError }
    expect(failure).toMatchObject({ code, build: { directory: f.directory(), phase, outcome: 'unconfirmed', automaticRetry: 'disabled' } })
    expect(f.observationBeforeBuild()).toMatchObject({ status: 'in-progress', phase: 'build', tag: options.tag, outcome: 'unconfirmed' })
    const observation = JSON.parse(await readFile(`${f.directory()}/build-observation.json`, 'utf8'))
    expect(observation).toMatchObject({ schemaVersion: 1, status: 'failed', code, phase, context: options.context,
      baseImage: options.baseImage, platform: options.platform, tag: options.tag, outcome: 'unconfirmed', automaticRetry: 'disabled' })
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_DAEMON_MESSAGE')
    expect(JSON.stringify(observation)).not.toContain('PRIVATE_DAEMON_MESSAGE')
    expect((await lstat(f.directory())).mode & 0o777).toBe(0o700)
    expect((await lstat(`${f.directory()}/build-observation.json`)).mode & 0o777).toBe(0o600)
    if (phase === 'verify-image') {
      expect(failure?.build?.contextFiles).toBe('removed-after-build')
      await expect(lstat(`${f.directory()}/context`)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(`${f.directory()}/image.id`, 'utf8')).toBe(imageId)
    } else {
      expect(failure?.build?.contextFiles).toBe('retained')
      expect(await readdir(`${f.directory()}/context`)).toEqual(expect.arrayContaining(['Dockerfile', 'app.mjs']))
      expect(await readFile(`${f.directory()}/context/app.mjs`, 'utf8')).toBe('owned synthetic program')
    }
    expect(observation.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'app.mjs', bytes: 23, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })]))
    expect(f.commands.filter(command => command.includes('build')).length).toBe(1)
    expect(f.commands.flat()).not.toContain('rm'); expect(f.commands.flat()).not.toContain('--push')
    if (phase === 'build' || phase === 'verify-image') expect(f.commands.some(command => command.includes('tag'))).toBe(false)
  })

  it('cleans only the successful owned build directory and preserves the existing receipt contract', async () => {
    const f = fixture(), result = await f.build()
    expect(result).toMatchObject({ ...options, imageId, execution: 'not-run', publication: 'local-daemon-only' })
    expect(result).not.toHaveProperty('build')
    await expect(lstat(f.directory())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('waits past Buildx inventory status timeout without selecting an unrelated engine', async () => {
    const f = fixture()
    await f.build()
    expect(f.builderInventoryTimeoutMs()).toBe(45000)
    expect(f.commands).toContainEqual(['--context', options.context, 'buildx', 'ls', '--format', '{{json .}}'])
  })

  it('does not create or advertise a build after a preflight refusal', async () => {
    const f = fixture('preflight')
    await expect(f.build()).rejects.toMatchObject({ code: 'image-conflict' })
    expect(f.directory()).toBe('')
    expect(f.commands.some(command => command.includes('build'))).toBe(false)
  })

  it('exposes safe recovery location in the real CLI error protocol, without daemon text or automatic retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-image-cli-recovery-')), state = join(directory, 'authoring')
    // Source-mode tests do not have runtime bundles next to src/. Bind a
    // synthetic packaging artifact; no runnable application is claimed here.
    const bytes = Buffer.from('export const synthetic = true;')
    const artifact = { bytes, notices: Buffer.from('synthetic'), storage: 'sqlite' as const,
      identity: { version: CORE_VERSION, sha256: createHash('sha256').update(bytes).digest('hex') } }
    vi.spyOn(releaseFiles, 'loadReleaseRuntime').mockResolvedValue(artifact)
    vi.spyOn(releaseFiles, 'loadReleaseRuntimeForIdentity').mockResolvedValue(artifact)
    const cli = async (args: string[]) => {
      let out = '', err = ''
      const exit = await main(args, { out: value => { out += value }, err: value => { err += value } })
      return { exit, out: out ? JSON.parse(out) : undefined, err: err ? JSON.parse(err) : undefined }
    }
    const project = await cli(['projects', 'create', fileURLToPath(new URL('../examples/echo.yaml', import.meta.url)), '--title', 'Image recovery fixture', '--data-dir', state])
    expect(project.exit).toBe(0)
    const release = await cli(['releases', 'create', project.out.id, '--revision', project.out.acceptedRevision,
      '--expected-generation', '1', '--version', '1.0.0', '--data-dir', state])
    expect(release.exit).toBe(0)
    const build = { directory, phase: 'build' as const, outcome: 'unconfirmed' as const,
      automaticRetry: 'disabled' as const, contextFiles: 'retained' as const }
    const packaging = vi.spyOn(images, 'buildReleaseImage').mockRejectedValue(new ImageError('docker-timeout', build))
    const refused = await cli(['releases', 'build-image', release.out.snapshot.id, '--release-sha256', release.out.sha256,
      '--base-image', options.baseImage, '--platform', options.platform, '--tag', options.tag,
      '--docker-context', options.context, '--output', join(directory, 'never-written.json'), '--data-dir', state])
    expect(refused).toMatchObject({ exit: 1, out: undefined, err: { schemaVersion: 1, status: 'error', code: 'docker-timeout', build } })
    expect(packaging).toHaveBeenCalledTimes(1)
    await expect(lstat(join(directory, 'never-written.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
