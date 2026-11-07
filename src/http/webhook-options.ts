import { readPrivateConfig } from './private-config.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { releaseWebhookConfigSchema, type ReleaseWebhookConfig } from '../releases/webhooks.ts'

export async function readReleaseWebhookFile(file: unknown): Promise<ReleaseWebhookConfig | undefined> {
  if (file === undefined) return undefined
  if (typeof file !== 'string' || !file) throw new WorkflowRuntimeError('invalid-command')
  try {
    const parsed = releaseWebhookConfigSchema.safeParse(await readPrivateConfig(file, 4096))
    if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
    return parsed.data
  } catch { throw new WorkflowRuntimeError('invalid-command') }
}
