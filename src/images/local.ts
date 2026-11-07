import { z } from 'zod'
import { mkdtemp, mkdir, open, rm, lstat, link, rename, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readBoundedFile } from '../files.ts'
import { ImageError, type DockerCommand, type ImageBuildRecovery } from './docker.ts'

export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
const contextName = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u)
const component = '[a-z0-9]+(?:[._-][a-z0-9]+)*'
const repository = `(?:${component}(?::[0-9]{1,5})?/)?${component}(?:/${component})*`
const baseImage = z.string().max(512).regex(new RegExp(`^${repository}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$`, 'u'))
const imageTag = z.string().max(384).regex(new RegExp(`^${repository}:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`, 'u'))
const platform = z.enum(['linux/arm64', 'linux/amd64'])
export const buildSchema = z.strictObject({ context: contextName, platform, baseImage, tag: imageTag })
export type ImageBuildOptions = z.infer<typeof buildSchema>
export const imageIdentityFields = { createdAt: z.iso.datetime(), context: contextName, platform, baseImage, tag: imageTag, imageId,
  engineVersion: z.string().min(1).max(64), execution: z.literal('not-run'), publication: z.literal('local-daemon-only') }
export function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw new ImageError('invalid-image-options'); return result.data
}
function json(value: string): any { try { return JSON.parse(value) } catch { throw new ImageError('image-mismatch') } }
const prefix = (context: string) => ['--context', context]
const exists = async (path: string) => { try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
export async function localEngine(context: string, run: DockerCommand) {
  const endpoint = json(await run(['context', 'inspect', context, '--format', '{{json .Endpoints.docker}}']))
  if (typeof endpoint?.Host !== 'string' || !endpoint.Host.startsWith('unix:///') || endpoint.SkipTLSVerify === true) throw new ImageError('unsupported-docker-context')
  const version = json(await run([...prefix(context), 'version', '--format', '{{json .Server}}']))
  if (version?.Os !== 'linux' || typeof version.Version !== 'string' || !version.Version.length || version.Version.length > 64) throw new ImageError('docker-unavailable')
  return version.Version as string
}
export async function inspect(context: string, reference: string, run: DockerCommand) {
  const rows = json(await run([...prefix(context), 'image', 'inspect', reference]))
  if (!Array.isArray(rows) || rows.length !== 1 || !imageId.safeParse(rows[0]?.Id).success) throw new ImageError('image-mismatch')
  return rows[0]
}
async function assertFreshTag(context: string, tag: string, run: DockerCommand) {
  const listing = await run([...prefix(context), 'image', 'ls', '--filter', `reference=${tag}`, '--format', '{{json .}}'])
  if (listing.trim()) throw new ImageError('image-conflict')
}

/** Internal shared packaging transport. Callers supply owned program files and role-specific image verification. */
export async function buildLocalImage(options: ImageBuildOptions, files: Record<string, Uint8Array>, labels: Record<string, string>,
  verify: (image: any, id: string) => void, run: DockerCommand) {
  parsed(buildSchema, options)
  const entries = Object.entries(files)
  if (!entries.length || entries.length > 100 || entries.some(([name]) => !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(name)
    || name.split('/').some(part => part === '.' || part === '..'))
    || entries.reduce((size, [, bytes]) => size + bytes.length, 0) > 64_000_000) throw new ImageError('invalid-image-options')
  const engineVersion = await localEngine(options.context, run)
  await assertFreshTag(options.context, options.tag, run)
  // Buildx inventories every configured context, including unrelated broken
  // engines. Its own status wait is 20s, so the transport must outlive that
  // wait while we still accept only the explicitly selected local builder.
  const builders = (await run([...prefix(options.context), 'buildx', 'ls', '--format', '{{json .}}'],
    { timeoutMs: 45000 })).trim().split('\n').filter(Boolean).map(json)
  const selected = builders.filter(builder => builder?.Name === options.context)
  if (!selected.length || selected.some(builder => builder.Driver !== 'docker' || !Array.isArray(builder.Nodes) || builder.Nodes.length !== 1
    || builder.Nodes[0].Endpoint !== options.context || builder.Nodes[0].Status !== 'running')) throw new ImageError('unsupported-builder')
  let base
  try { base = await inspect(options.context, options.baseImage, run) } catch { throw new ImageError('base-unavailable') }
  if (`${base.Os}/${base.Architecture}` !== options.platform || base.Config?.OnBuild?.length) throw new ImageError('base-unavailable')
  const directory = await mkdtemp(join(tmpdir(), 'jevable-image-build-'))
  let phase: ImageBuildRecovery['phase'] = 'prepare-context'
  let contextFiles: ImageBuildRecovery['contextFiles'] = 'retained'
  // Checkpoint outside the COPY allowlist before every effect. A killed launcher
  // can leave BuildKit active: retain these owned files rather than erase evidence.
  const checkpoint = (status: 'in-progress' | 'failed', code?: string) => writeFile(join(directory, 'build-observation.json'),
    JSON.stringify({ schemaVersion: 1, status, phase, context: options.context, platform: options.platform,
      baseImage: options.baseImage, tag: options.tag, outcome: 'unconfirmed', automaticRetry: 'disabled', contextFiles,
      files: entries.map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })),
      ...(code ? { code } : {}) }) + '\n', { mode: 0o600 })
  try {
    await checkpoint('in-progress')
    const context = join(directory, 'context'); await mkdir(context, { mode: 0o700 })
    for (const [name, bytes] of entries) {
      await mkdir(dirname(join(context, name)), { recursive: true, mode: 0o700 })
      const file = await open(join(context, name), 'wx', 0o600)
      try { await file.writeFile(bytes) } finally { await file.close() }
    }
    const iid = join(directory, 'image.id'), metadataFile = join(directory, 'build.json')
    phase = 'build'; await checkpoint('in-progress')
    await run([...prefix(options.context), 'buildx', 'build', '--builder', options.context, '--platform', options.platform,
      '--load', '--provenance=false', '--network', 'none', '--build-arg', `NODE_IMAGE=${options.baseImage}`, '--iidfile', iid, '--metadata-file', metadataFile,
      ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]), context], { timeoutMs: 600000 })
    phase = 'verify-image'; await checkpoint('in-progress')
    const built = parsed(imageId, (await readBoundedFile(iid, 256)).trim())
    const metadata = json(await readBoundedFile(metadataFile, 64000))
    const manifestId = parsed(imageId, metadata?.['containerimage.digest']), configId = parsed(imageId, metadata?.['containerimage.config.digest'])
    if (built !== manifestId && built !== configId) throw new ImageError('image-mismatch')
    let image
    try { image = await inspect(options.context, manifestId, run) }
    catch (error) {
      if (!(error instanceof ImageError) || error.code !== 'docker-command-failed' || configId === manifestId) throw error
      image = await inspect(options.context, configId, run)
    }
    if (image.Id !== manifestId && image.Id !== configId) throw new ImageError('image-mismatch')
    verify(image, image.Id)
    await assertFreshTag(options.context, options.tag, run)
    phase = 'publish-tag'; await checkpoint('in-progress')
    await run([...prefix(options.context), 'image', 'tag', image.Id, options.tag])
    phase = 'verify-tag'; await checkpoint('in-progress')
    verify(await inspect(options.context, options.tag, run), image.Id)
    phase = 'cleanup'; await checkpoint('in-progress')
    await rm(directory, { recursive: true, force: true })
    return { ...options, imageId: image.Id as string, engineVersion, createdAt: new Date().toISOString(),
      execution: 'not-run' as const, publication: 'local-daemon-only' as const }
  } catch (error) {
    // A successful builder followed by a definite verification refusal no longer
    // needs its COPY staging directory. Keep IDs, metadata and exact input hashes.
    // Never remove staging while build/tag completion itself is uncertain.
    if (phase === 'verify-image') {
      try { await rm(join(directory, 'context'), { recursive: true, force: true }); contextFiles = 'removed-after-build' } catch {}
    }
    const failure = new ImageError(error instanceof ImageError ? error.code : 'image-build-failed',
      { directory, phase, outcome: 'unconfirmed', automaticRetry: 'disabled', contextFiles })
    // Diagnostic I/O cannot replace the original safe failure or trigger a retry.
    await checkpoint('failed', failure.code).catch(() => {})
    throw failure
  }
}

/** Save immutable identity with pre/post verification; retain daemon state on uncertain failure. */
export async function saveLocalImage(receipt: { context: string; imageId: string }, path: string, overwrite: boolean,
  verify: (image: any) => void, run: DockerCommand) {
  const output = resolve(path)
  if (!overwrite && await exists(output)) throw new ImageError('image-conflict')
  await localEngine(receipt.context, run)
  verify(await inspect(receipt.context, receipt.imageId, run))
  const temporary = join(dirname(output), `.jevable-image-${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600), hash = createHash('sha256'); let bytes = 0
  try {
    try {
      await run([...prefix(receipt.context), 'image', 'save', receipt.imageId], { timeoutMs: 600000,
        consumeStdout: async chunk => { bytes += chunk.length; if (bytes > 4_000_000_000) throw new ImageError('docker-output-limit')
          hash.update(chunk); await file.writeFile(chunk) } })
      if (bytes < 1024) throw new ImageError('image-mismatch')
      await file.sync()
    } finally { await file.close() }
    verify(await inspect(receipt.context, receipt.imageId, run))
    if (overwrite) await rename(temporary, output); else await link(temporary, output)
  } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) }
  return { schemaVersion: 1, artifact: { path: output, bytes, sha256: hash.digest('hex') },
    archive: 'docker-image-save', tagging: 'saved-by-immutable-ID; restore a reviewed tag explicitly after loading',
    execution: 'not-run', publication: 'local-file-only' }
}
