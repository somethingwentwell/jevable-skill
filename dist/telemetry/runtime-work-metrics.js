import { DataPointType } from '@opentelemetry/sdk-metrics';
/** The SDK can retain old observable gauges; unknown ownership must not export stale work. */
export function omitUnavailableRuntimeWorkMetrics(resource) {
    for (const scope of resource.scopeMetrics) {
        const available = scope.metrics.find(metric => metric.descriptor.name === 'jevable.runtime.work.available');
        if (available?.dataPointType === DataPointType.GAUGE && available.dataPoints.some(point => point.value === 0))
            scope.metrics = scope.metrics.filter(metric => !metric.descriptor.name.startsWith('jevable.runtime.work.') || metric === available);
    }
}
/** Samples existing owner counters only. No dispatch, storage access, identity labels or reconstruction. */
export function installRuntimeWorkMetrics(meter, read) {
    const available = meter.createObservableGauge('jevable.runtime.work.available', { unit: '1',
        description: 'One when this open runtime owner supplies current process-local work counts; zero means unknown, not idle' });
    const operations = meter.createObservableGauge('jevable.runtime.work.operations', { unit: '{operation}',
        description: 'Currently admitted asynchronous SDK operation scopes, including nested reads; not unique requests, scheduler backlog or capacity' });
    const reservations = meter.createObservableGauge('jevable.runtime.work.run_reservations', { unit: '{run}',
        description: 'Run IDs currently held by this owner for admission, execution, control or settlement; not retained runs, executing nodes or distributed workers' });
    meter.addBatchObservableCallback(result => {
        let state = { available: false };
        try {
            const snapshot = read();
            if (snapshot.available === true) {
                const operations = snapshot.operations, runReservations = snapshot.runReservations;
                if ([operations, runReservations].every(n => Number.isSafeInteger(n) && n >= 0))
                    state = { available: true, operations, runReservations };
            }
        }
        catch { /* Diagnostic source failures never change execution, ownership or export error details. */ }
        result.observe(available, Number(state.available));
        if (!state.available)
            return;
        result.observe(operations, state.operations);
        result.observe(reservations, state.runReservations);
    }, [available, operations, reservations]);
}
