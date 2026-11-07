import { RETAINED_STATUSES } from "../runtime/retained-metrics.js";
import { DataPointType } from '@opentelemetry/sdk-metrics';
export const RETAINED_METRIC_LABELS = ['jevable.retained.state'];
/** Cumulative SDK storage keeps unobserved gauges. Never serialize those stale values as current state. */
export function omitUnavailableRetainedMetrics(resource) {
    for (const scope of resource.scopeMetrics) {
        const available = scope.metrics.find(metric => metric.descriptor.name === 'jevable.retained.available');
        if (available?.dataPointType === DataPointType.GAUGE && available.dataPoints.some(point => point.value === 0))
            scope.metrics = scope.metrics.filter(metric => !metric.descriptor.name.startsWith('jevable.retained.') || metric === available);
    }
}
export function installRetainedMetrics(meter, read) {
    const available = meter.createObservableGauge('jevable.retained.available', { unit: '1', description: 'One when this owner has a complete validated retained-state projection; zero means unknown, not empty' });
    const runs = meter.createObservableGauge('jevable.retained.runs', { unit: '{run}', description: 'Retained checkpoint counts, including history; executing means durable intent, not necessarily active work' });
    const approvals = meter.createObservableGauge('jevable.retained.approvals', { unit: '{approval}', description: 'Unsettled approval checkpoints by current deadline status; sampling never expires or decides them' });
    const age = meter.createObservableGauge('jevable.retained.approval_oldest_age', { unit: 's', description: 'Oldest current approval age from its persisted request event, including downtime; zero for an empty bucket' });
    meter.addBatchObservableCallback(result => {
        let state = { available: false };
        try {
            const source = read();
            if (source.available === true) {
                // Copy only owned fixed fields before observing anything. A malformed or
                // throwing optional source must not leave a partial/stale SDK snapshot.
                const runs = Object.fromEntries(RETAINED_STATUSES.map(status => [status, source.runs[status]]));
                const approvals = {
                    awaiting: { count: source.approvals.awaiting.count, oldestAgeSeconds: source.approvals.awaiting.oldestAgeSeconds },
                    expired: { count: source.approvals.expired.count, oldestAgeSeconds: source.approvals.expired.oldestAgeSeconds },
                };
                const count = (value) => Number.isSafeInteger(value) && value >= 0;
                if (Object.values(runs).every(count) && count(Object.values(runs).reduce((a, b) => a + b, 0))
                    && Object.values(approvals).every(value => count(value.count) && Number.isFinite(value.oldestAgeSeconds)
                        && value.oldestAgeSeconds >= 0 && (value.count !== 0 || value.oldestAgeSeconds === 0))
                    && count(approvals.awaiting.count + approvals.expired.count)
                    && approvals.awaiting.count + approvals.expired.count === runs.waiting)
                    state = { available: true, runs, approvals };
            }
        }
        catch { /* Unknown diagnostics are not empty backlog, workflow errors or arbitrary error labels. */ }
        result.observe(available, Number(state.available));
        if (!state.available)
            return;
        for (const status of RETAINED_STATUSES)
            result.observe(runs, state.runs[status], { 'jevable.retained.state': status });
        for (const status of ['awaiting', 'expired']) {
            result.observe(approvals, state.approvals[status].count, { 'jevable.retained.state': status });
            result.observe(age, state.approvals[status].oldestAgeSeconds, { 'jevable.retained.state': status });
        }
    }, [available, runs, approvals, age]);
}
