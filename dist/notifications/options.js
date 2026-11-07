import { readPrivateConfig } from "../http/private-config.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { parseNotificationConfig } from "./config.js";
/** Startup-only configuration for the explicitly selected owner; never an endpoint override on a send request. */
export async function notificationOptions(values) {
    const file = values['notifications-file'];
    if (file === undefined)
        return undefined;
    if (typeof file !== 'string' || !file)
        throw new WorkflowRuntimeError('invalid-command');
    return parseNotificationConfig(await readPrivateConfig(file, 100000));
}
