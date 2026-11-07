export const EXPORTER_HEALTH_LABELS = ['jevable.telemetry.signal', 'jevable.telemetry.state'];
const FAILURES = ['none', 'transport', 'response', 'serialization', 'collection', 'partial-rejection', 'other'];
const count = (value) => Number.isFinite(value) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))) : 0;
/** Private provider only. Fixed vocabularies; no destinations, IDs, credentials or error messages. */
export function installExporterHealthMetrics(meter, read) {
    const records = meter.createObservableCounter('jevable.telemetry.records', { unit: '{item}',
        description: 'Cumulative accepted/exported/rejected/dropped items per signal; metric items are snapshot data points, not unique measurements' });
    const batches = meter.createObservableCounter('jevable.telemetry.batches', { unit: '{batch}', description: 'Cumulative acknowledged or failed export batches per signal' });
    const occupancy = meter.createObservableGauge('jevable.telemetry.occupancy', { unit: '{item}', description: 'Queued and in-flight telemetry items, not workflow backlog' });
    const failure = meter.createObservableGauge('jevable.telemetry.last_failure', { unit: '1', description: 'One-hot last export failure category; none is not an end-to-end delivery guarantee' });
    const success = meter.createObservableGauge('jevable.telemetry.last_success', { unit: 's', description: 'Unix seconds of last receiver acknowledgement; zero means no acknowledgement observed' });
    meter.addBatchObservableCallback(result => {
        const snapshots = read();
        for (const signal of ['traces', 'metrics', 'logs']) {
            const snapshot = snapshots[signal];
            if (!snapshot)
                continue;
            const labels = { 'jevable.telemetry.signal': signal };
            for (const state of ['accepted', 'exported', 'rejected', 'dropped'])
                result.observe(records, count(snapshot[state]), { ...labels, 'jevable.telemetry.state': state });
            for (const [state, key] of [['success', 'successfulBatches'], ['failure', 'failedBatches']])
                result.observe(batches, count(snapshot[key]), { ...labels, 'jevable.telemetry.state': state });
            for (const [state, key] of [['queued', 'queued'], ['in-flight', 'inFlight']])
                result.observe(occupancy, count(snapshot[key]), { ...labels, 'jevable.telemetry.state': state });
            const lastFailure = snapshot.lastFailure === null ? 'none' : FAILURES.includes(snapshot.lastFailure) ? snapshot.lastFailure : 'other';
            for (const state of FAILURES)
                result.observe(failure, Number(lastFailure === state), { ...labels, 'jevable.telemetry.state': state });
            const time = snapshot.lastSuccessAt === null ? 0 : Date.parse(snapshot.lastSuccessAt) / 1000;
            result.observe(success, Number.isFinite(time) ? Math.max(0, time) : 0, labels);
        }
    }, [records, batches, occupancy, failure, success]);
}
