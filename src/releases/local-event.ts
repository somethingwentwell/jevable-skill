import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { DEFAULT_COMPILER_LIMITS } from '../limits.ts'
import { admitWorkflowData } from '../workflow/value-schema.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { inspectMessageRelease, releaseMessageIdentitySchema, releaseMessageRunId } from './messages.ts'

const maxBytes = 1_100_000
const localEventSchema = releaseMessageIdentitySchema.extend({
  format: z.literal('jevable.ai/local-release-event'), version: z.literal(1), input: z.unknown(),
})

/** Admit exact captured event bytes against this release: strict versioned envelope,
 * exact release pin, optional reviewed byte hash and bounded input admission.
 * Shared by the one-shot file command and the durable local inbox; never opens storage. */
export function admitReleaseLocalEventBytes(bytes: Uint8Array, snapshot: unknown, expectedSha256?: string) {
  try {
    if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(expectedSha256)) throw Error()
    const release = inspectMessageRelease(snapshot)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (expectedSha256 !== undefined && expectedSha256 !== sha256) throw Error()
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    const parsed = localEventSchema.parse(value)
    if (!Object.hasOwn(parsed, 'input') || parsed.release.id.toLowerCase() !== release.snapshot.id.toLowerCase()
      || parsed.release.sha256 !== release.sha256 || parsed.release.revision !== release.snapshot.workflow.revision) throw Error()
    const input = admitWorkflowData(parsed.input, DEFAULT_COMPILER_LIMITS.binding.data)
    const { source, messageId } = parsed
    return { sha256, input, runId: releaseMessageRunId({ release: parsed.release, source, messageId }), source, messageId }
  } catch { throw new WorkflowRuntimeError('invalid-command') }
}

/** A local operator-owned event is execution authority, not a public webhook.
 * Capture and pin all bytes before opening any runtime or telemetry configuration.
 */
export async function readReleaseLocalEvent(path: string, snapshot: unknown, expectedSha256?: string) {
  try {
    if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(expectedSha256)) throw Error()
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | constants.O_NOCTTY)
    let bytes: Buffer
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > maxBytes || process.platform !== 'win32'
        && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) throw Error()
      bytes = Buffer.alloc(maxBytes + 1)
      let offset = 0
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, null)
        if (!read.bytesRead) break
        offset += read.bytesRead
      }
      if (offset > maxBytes) throw Error()
      bytes = bytes.subarray(0, offset)
    } finally { await file.close() }
    return { ...admitReleaseLocalEventBytes(bytes, snapshot, expectedSha256), bytes }
  } catch { throw new WorkflowRuntimeError('invalid-command') }
}
