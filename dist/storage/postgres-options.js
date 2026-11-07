import { readPrivateConfig } from "../http/private-config.js";
import { readBoundedFile } from "../files.js";
import { parseTelemetryConfig } from "../telemetry/config.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { notificationOptions } from "../notifications/options.js";
/** Explicit private configuration; no ambient endpoint, credential or backend fallback. */
export async function postgresRuntimeOptions(values) {
    if (typeof values['database-file'] !== 'string' || !values['database-file'] || values['data-dir'] !== undefined)
        throw new WorkflowRuntimeError('invalid-command');
    const notifications = await notificationOptions(values);
    const database = await readPrivateConfig(values['database-file']);
    let telemetry;
    if (typeof values['telemetry-file'] === 'string') {
        try {
            telemetry = parseTelemetryConfig(JSON.parse(await readBoundedFile(values['telemetry-file'], 16000)));
        }
        catch {
            throw new WorkflowRuntimeError('invalid-command');
        }
    }
    return { database, ...(telemetry ? { telemetry } : {}), ...(notifications ? { notifications } : {}) };
}
