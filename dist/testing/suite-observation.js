import { z } from 'zod';
export const suiteObservationSchema = z.strictObject({
    sha256: z.string().regex(/^[a-f0-9]{64}$/u), mode: z.enum(['run', 'result']),
    failurePolicy: z.enum(['stop', 'continue']), entries: z.number().int().min(1).max(100),
    concurrency: z.number().int().min(1).max(8),
});
export const SUITE_OUTCOMES = new Set(['passed', 'failed', 'pending', 'attention', 'uncertain', 'blocked', 'interrupted', 'operation-failed']);
/** Optional diagnostics never substitute results, mask failures or invoke work twice. */
export async function withSuiteObservation(host, identity, work) {
    let observation;
    try {
        observation = host.observeTestSuite?.(Object.freeze({ ...identity }));
        void Promise.resolve(observation).catch(() => { }); // Invalid asynchronous hooks must not leave an unhandled rejection.
    }
    catch { /* Diagnostic admission only. */ }
    const cases = snapshot => {
        try {
            void Promise.resolve(observation?.cases?.(Object.freeze({ ...snapshot }))).catch(() => { });
        }
        catch { /* Queue diagnostics must never alter admission or settlement. */ }
    };
    let execution, accepting = true;
    const once = () => {
        if (accepting && !execution)
            execution = Promise.resolve().then(() => work(cases));
        // Deferred callbacks cannot redispatch or move already admitted work into another scope.
        return execution ?? Promise.resolve(undefined);
    };
    try {
        const returned = observation?.within(once);
        if (returned !== execution)
            void Promise.resolve(returned).catch(() => { });
    }
    catch { /* Keep the original execution, or execute normally if never invoked. */ }
    accepting = false;
    execution ??= Promise.resolve().then(() => work(cases));
    const finish = (outcome) => {
        try {
            void Promise.resolve(observation?.finish(outcome)).catch(() => { });
        }
        catch { /* Export cannot change the report. */ }
    };
    try {
        const result = await execution;
        finish(result.status);
        return result;
    }
    catch (error) {
        finish('operation-failed');
        throw error;
    }
}
