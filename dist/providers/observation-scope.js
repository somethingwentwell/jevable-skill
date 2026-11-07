export function withObservationScope(scope, work) {
    let started = false, failed = false, failure;
    let result;
    const once = () => {
        if (!started) {
            started = true;
            try {
                result = work();
            }
            catch (error) {
                failed = true;
                failure = error;
            }
        }
        if (failed)
            throw failure;
        return result;
    };
    try {
        const diagnostic = scope?.(once);
        // A broken/custom asynchronous hook must not create an unhandled rejection or hold up work.
        // Never substitute its value/Promise for the actual persistence result.
        if (diagnostic !== result)
            void Promise.resolve(diagnostic).catch(() => { });
    }
    catch { /* The exact work result/error remains authoritative through once(), never replay it. */ }
    return once();
}
