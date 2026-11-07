import { z } from 'zod';
import { WorkflowRuntimeError } from "./errors.js";
import { apiTriggerModeSchema } from "./trigger.js";
const optionsSchema = z.strictObject({ id: z.uuid(), paused: z.boolean().optional(), triggerMode: apiTriggerModeSchema.optional() });
export function parseAsyncRunOptions(value) {
    const parsed = optionsSchema.safeParse(value);
    if (!parsed.success)
        throw new WorkflowRuntimeError('invalid-command');
    return { id: parsed.data.id, ...(parsed.data.paused === undefined ? {} : { paused: parsed.data.paused }),
        ...(parsed.data.triggerMode === undefined ? {} : { triggerMode: parsed.data.triggerMode }) };
}
/** Internal callback is reached only after acknowledged durable creation, before first dispatch.
 * No queue, detached owner, timer, automatic resume or error-to-success conversion is introduced.
 */
export function admitAsyncRun(start) {
    let resolve, reject;
    const admission = new Promise((yes, no) => { resolve = yes; reject = no; });
    let completion, snapshot;
    const publish = (run, observation) => {
        if (snapshot)
            return;
        snapshot = { observation, run: structuredClone(run) };
        if (completion)
            resolve({ ...snapshot, completion });
    };
    // Start immediately to preserve operation/run reservation before another caller can close the owner.
    try {
        completion = start(run => publish(run, 'created'));
    }
    catch (error) {
        completion = Promise.reject(error);
    }
    if (snapshot)
        resolve({ ...snapshot, completion });
    // Observe rejection even if the consumer only retains admission. The original completion still rejects.
    void completion.then(run => publish(run, 'retained'), error => reject(error));
    return admission;
}
