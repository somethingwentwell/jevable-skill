import { fromBuffer, type ZipFile, type Entry } from 'yauzl'
import type { Readable } from 'node:stream'
import { crc32 } from 'node:zlib'

export class BoundedZipError extends Error {
  constructor(readonly code: 'invalid-package' | 'package-limit' | 'checksum-mismatch') {
    super(`Jevable ZIP read failed: ${code}.`); this.name = 'BoundedZipError'
  }
}
export type ZipReadLimits = { archiveBytes: number; entryBytes: number; totalBytes: number; entries: number }

/** Read an owned copy into bounded memory. Never extract paths, follow links or execute entries. */
export async function readBoundedZip(input: Uint8Array, limits: ZipReadLimits, allow: (path: string) => boolean): Promise<Map<string, Buffer>> {
  if (!(input instanceof Uint8Array)) throw new BoundedZipError('invalid-package')
  if (input.byteLength > limits.archiveBytes) throw new BoundedZipError('package-limit')
  const bytes = Buffer.from(input)
  return new Promise((resolve, reject) => {
    let zip: ZipFile | undefined, active: Readable | undefined, settled = false, total = 0, count = 0
    const files = new Map<string, Buffer>()
    const fail = (error: unknown) => {
      if (settled) return
      settled = true; active?.destroy(); zip?.close()
      reject(error instanceof BoundedZipError ? error : new BoundedZipError('invalid-package'))
    }
    fromBuffer(bytes, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (error, opened) => {
      if (error || !opened) { fail(error); return }
      zip = opened
      if (zip.entryCount > limits.entries) { fail(new BoundedZipError('package-limit')); return }
      zip.on('error', fail)
      zip.on('end', () => { if (!settled) { settled = true; resolve(files) } })
      zip.on('entry', (entry: Entry) => {
        if (settled) return
        try {
          const kind = (entry.externalFileAttributes >>> 16) & 0o170000
          if (!allow(entry.fileName) || files.has(entry.fileName) || ![0, 0o100000].includes(kind) || (entry.externalFileAttributes & 0x10)
            || (entry.generalPurposeBitFlag & 1) || ![0, 8].includes(entry.compressionMethod)) throw new BoundedZipError('invalid-package')
          if (++count > limits.entries || !Number.isSafeInteger(entry.uncompressedSize)
            || entry.uncompressedSize > limits.entryBytes || entry.uncompressedSize < 0
            || entry.compressedSize > bytes.byteLength || total + entry.uncompressedSize > limits.totalBytes) throw new BoundedZipError('package-limit')
          zip!.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) { fail(streamError); return }
            if (settled) { stream.destroy(); return }
            active = stream
            const chunks: Buffer[] = []; let size = 0, crc = 0
            stream.on('error', fail)
            stream.on('data', (chunk: Buffer) => {
              if (settled) return
              size += chunk.byteLength; total += chunk.byteLength
              if (size > limits.entryBytes || total > limits.totalBytes || size > entry.uncompressedSize) {
                fail(new BoundedZipError('package-limit')); return
              }
              crc = crc32(chunk, crc); chunks.push(chunk)
            })
            stream.on('end', () => {
              if (settled) return
              if (size !== entry.uncompressedSize) { fail(new BoundedZipError('invalid-package')); return }
              if (crc !== entry.crc32) { fail(new BoundedZipError('checksum-mismatch')); return }
              files.set(entry.fileName, Buffer.concat(chunks, size)); active = undefined; zip!.readEntry()
            })
          })
        } catch (entryError) { fail(entryError) }
      })
      zip.readEntry()
    })
  })
}
