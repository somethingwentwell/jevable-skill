import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { WorkflowRuntimeError } from '../runtime/errors.ts'

/** Private configuration can contain credentials. Never print parse errors, paths or file content. */
export async function readPrivateConfig(path: string, maxBytes = 1_000_000): Promise<unknown> {
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_000_000) throw new Error()
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes
        || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error()
      const bytes = Buffer.alloc(maxBytes + 1); let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > maxBytes) throw new Error()
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
      return value
    } finally { await file.close() }
  } catch { throw new WorkflowRuntimeError('invalid-command') }
}
