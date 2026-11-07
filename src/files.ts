import { open, link, rename, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

/** Read a bounded regular file, including protection against growth after stat. */
export async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBytes(path, maxBytes))
}

export async function readBoundedBytes(path: string, maxBytes: number): Promise<Buffer> {
  return readBytes(path, maxBytes, 'r')
}

/** Inspection inputs must not wait for a pipe writer. POSIX also refuses a final symlink atomically.
 * Keep ordinary caller-selected workflow/file reads on their existing, separate path.
 */
export async function readBoundedRegularBytes(path: string, maxBytes: number): Promise<Buffer> {
  return readBytes(path, maxBytes, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | constants.O_NOCTTY)
}

async function readBytes(path: string, maxBytes: number, flags: string | number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid input byte limit.')
  const file = await open(path, flags)
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('Expected a regular input file.')
    if (stat.size > maxBytes) throw new Error('Input file exceeds the configured byte limit.')
    const buffer = Buffer.alloc(maxBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > maxBytes) throw new Error('Input file exceeds the configured byte limit.')
    return buffer.subarray(0, offset)
  } finally { await file.close() }
}

/** Same-directory atomic publication; default mode refuses existing files, including symlinks. */
export async function writeArtifact(path: string, content: string | Uint8Array, overwrite = false) {
  const output = resolve(path)
  const temporary = resolve(dirname(output), `.jevable-${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    try { await file.writeFile(content, 'utf8'); await file.sync() } finally { await file.close() }
    if (overwrite) await rename(temporary, output)
    else await link(temporary, output)
  } finally {
    try { await unlink(temporary) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return { path: output, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }
}
