import { z } from 'zod'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { renderPreview } from './index.ts'
import type { WorkflowCompilerLimits } from '../workflow/index.ts'

/** Explicit reviewed existing-project selection, not creation or implicit recovery. */
export const previewProjectPinSchema = z.strictObject({ id: z.uuid(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  revision: z.string().regex(/^[a-f0-9]{64}$/u) })
export type PreviewProjectPin = z.infer<typeof previewProjectPinSchema>

/** I/O-free owned admission, before a listener, credentials or storage is opened. */
export function admitPreviewProjectPin(source: string, value: unknown, limits?: WorkflowCompilerLimits): PreviewProjectPin {
  const parsed = previewProjectPinSchema.safeParse(value)
  if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
  const preview = renderPreview(source, limits)
  if (preview.data.validation.status !== 'valid') throw new WorkflowRuntimeError('invalid-command')
  if (preview.data.revision !== parsed.data.revision) throw new WorkflowRuntimeError('conflict')
  return parsed.data
}
