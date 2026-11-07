import { createHash } from 'node:crypto'
import { readBoundedRegularBytes } from '../files.ts'
import { admitPreviewProjectPin } from '../preview/project-pin.ts'
import { CliStorageUsageError, type CliValues } from './runtime.ts'

/** Exact file checksum and workflow revision, before credentials, target contact or storage. */
export async function readPreviewProjectPin(source: string, values: CliValues) {
  if (values['project-pin-file'] === undefined) return undefined
  const bytes = await readBoundedRegularBytes(values['project-pin-file'] as string, 4096)
  if (createHash('sha256').update(bytes).digest('hex') !== values['project-pin-sha256']) {
    throw new CliStorageUsageError('The preview project pin file differs from its reviewed SHA-256.')
  }
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new CliStorageUsageError('Invalid preview project pin JSON.') }
  return admitPreviewProjectPin(source, value)
}
