import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { suiteObservationSchema, SUITE_OUTCOMES } from "../testing/suite-observation.js";
export const SUITE_METRIC_LABELS = ['jevable.suite.mode', 'jevable.suite.failure_policy', 'jevable.suite.outcome'];
export const SUITE_CASE_METRIC_LABELS = ['jevable.suite.failure_policy', 'jevable.suite.case.phase'];
/** Real invocation scope; suite titles, case/input/expectation payloads and actors are excluded. */
export function observeTestSuite(tracer, identity, parent, scope, settled, cases) {
    const parsed = suiteObservationSchema.safeParse(identity);
    if (!parsed.success)
        return undefined;
    const value = parsed.data;
    const attributes = { 'jevable.suite.sha256': value.sha256, 'jevable.suite.mode': value.mode,
        'jevable.suite.failure_policy': value.failurePolicy, 'jevable.suite.entries': value.entries,
        'jevable.suite.concurrency': value.concurrency };
    const span = tracer.startSpan('jevable.test.suite', { attributes }, parent ? trace.setSpanContext(ROOT_CONTEXT, parent) : ROOT_CONTEXT);
    const context = span.spanContext(), started = performance.now();
    let ended = false;
    let counts = Object.freeze({ waiting: 0, running: 0, settled: 0 }), observedCases = false;
    const update = (next) => {
        const before = counts;
        counts = Object.freeze({ ...next });
        observedCases = true;
        try {
            cases?.(value.failurePolicy, before, counts);
        }
        catch { /* Metrics never change suite results. */ }
    };
    return { within: work => ended ? undefined : scope(context, work), cases: snapshot => {
            if (ended || value.mode !== 'run')
                return;
            // Copy only bounded numeric fields: no identities, arbitrary attributes or payloads.
            const next = { waiting: snapshot.waiting, running: snapshot.running, settled: snapshot.settled };
            if (!Object.values(next).every(n => Number.isSafeInteger(n) && n >= 0)
                || next.running > value.concurrency || next.settled < counts.settled
                || next.waiting + next.running + next.settled > value.entries)
                return;
            update(next);
        }, finish: status => {
            if (ended)
                return;
            ended = true;
            if (observedCases)
                update({ waiting: 0, running: 0, settled: counts.settled });
            const outcome = SUITE_OUTCOMES.has(status) ? status : 'operation-failed';
            const failed = ['failed', 'uncertain', 'blocked', 'operation-failed'].includes(outcome);
            const data = { ...attributes, 'jevable.suite.outcome': outcome };
            try {
                span.setAttribute('jevable.suite.outcome', outcome);
                span.setStatus({ code: failed ? SpanStatusCode.ERROR : SpanStatusCode.UNSET });
            }
            finally {
                try {
                    span.end();
                }
                finally {
                    settled(data, Math.max(0, performance.now() - started) / 1000, context, failed);
                }
            }
        } };
}
