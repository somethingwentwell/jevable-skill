import { runTrace } from "../runtime/run-types.js";
import { withObservationScope } from "./observation-scope.js";
/** Diagnostics cannot change dispatch/settlement, including when a custom SDK observer throws. */
export function observeModelTry(context, id, number) {
    let observer;
    try {
        observer = context?.startTry?.({ id, number });
    }
    catch { /* Execution remains authoritative. */ }
    let trace;
    try {
        const parsed = runTrace.safeParse(observer?.trace);
        if (parsed.success && parsed.data.traceId === context?.trace.traceId && parsed.data.traceFlags === context.trace.traceFlags
            && parsed.data.spanId !== context.trace.spanId)
            trace = parsed.data;
    }
    catch { /* Malformed observer context is not execution state. */ }
    let scope;
    try {
        const candidate = observer?.withJournalScope;
        if (typeof candidate === 'function')
            scope = candidate.bind(observer);
    }
    catch { /* Snapshot optional diagnostic scope before any persistence await. */ }
    let ended = false;
    return { trace, scope(work) { return withObservationScope(scope, work); }, end(result) {
            if (ended)
                return;
            ended = true;
            try {
                observer?.end({ ...result });
            }
            catch { /* Never turn telemetry failure into execution failure. */ }
        } };
}
