import { readPrivateConfig } from "./private-config.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { releaseWebhookConfigSchema } from "../releases/webhooks.js";
export async function readReleaseWebhookFile(file) {
    if (file === undefined)
        return undefined;
    if (typeof file !== 'string' || !file)
        throw new WorkflowRuntimeError('invalid-command');
    try {
        const parsed = releaseWebhookConfigSchema.safeParse(await readPrivateConfig(file, 4096));
        if (!parsed.success)
            throw new WorkflowRuntimeError('invalid-command');
        return parsed.data;
    }
    catch {
        throw new WorkflowRuntimeError('invalid-command');
    }
}
