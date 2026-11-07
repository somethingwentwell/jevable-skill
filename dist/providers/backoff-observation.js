/** Wait diagnostics cannot authorize dispatch, change a budget or replace a persistence/transport outcome. */
export function observeModelBackoff(context, afterTryId, afterTryNumber, delayMs) {
    let observer;
    try {
        observer = context?.startBackoff?.({ afterTryId, afterTryNumber, delayMs });
    }
    catch { /* Execution stays authoritative. */ }
    let ended = false;
    return { end(result) {
            if (ended)
                return;
            ended = true;
            try {
                observer?.end({ ...result });
            }
            catch { /* No telemetry failure may cause replay or mask ownership loss. */ }
        } };
}
