import { resolve } from 'node:path';
import { readBoundedFile } from "../files.js";
import { parseTelemetryConfig } from "./config.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { notificationOptions } from "../notifications/options.js";
export async function localRuntimeOptions(values, defaultDirectory = '.jevable') {
    const dataDirectory = resolve(typeof values['data-dir'] === 'string' ? values['data-dir'] : defaultDirectory);
    const notifications = await notificationOptions(values);
    const base = { dataDirectory, ...(notifications ? { notifications } : {}) };
    if (typeof values['telemetry-file'] !== 'string')
        return base;
    let value;
    try {
        value = JSON.parse(await readBoundedFile(values['telemetry-file'], 16000));
    }
    catch {
        throw new WorkflowRuntimeError('invalid-command');
    }
    return { ...base, telemetry: parseTelemetryConfig(value) };
}
