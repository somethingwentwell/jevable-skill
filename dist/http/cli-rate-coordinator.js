import { readPrivateConfig } from "./private-config.js";
import { parsePostgresHttpRateCoordinatorOptions } from "./postgres-rate-config.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
/** Read/capture protected startup input without connecting, initializing or exposing credentials. */
export async function readCliRateCoordinator(values) {
    const path = values['rate-coordinator-file'];
    if (path === undefined)
        return undefined;
    if (typeof path !== 'string' || !path || values['rate-limits-file'] !== undefined)
        throw new WorkflowRuntimeError('invalid-command');
    try {
        const options = parsePostgresHttpRateCoordinatorOptions(await readPrivateConfig(path, 65536));
        if (options.initialize !== false)
            throw new WorkflowRuntimeError('invalid-command');
        return options;
    }
    catch {
        throw new WorkflowRuntimeError('invalid-command');
    }
}
