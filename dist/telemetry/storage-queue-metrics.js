import { DataPointType } from '@opentelemetry/sdk-metrics';
export const STORAGE_QUEUE_LABELS = ['jevable.storage.queue', 'jevable.storage.queue.state'];
/** The cumulative SDK may retain unobserved gauges; unknown occupancy must not reuse stale counts. */
export function omitUnavailableStorageQueueMetrics(resource) {
    for (const scope of resource.scopeMetrics) {
        const available = scope.metrics.find(metric => metric.descriptor.name === 'jevable.storage.queue.available');
        if (available?.dataPointType === DataPointType.GAUGE && available.dataPoints.some(point => point.value === 0))
            scope.metrics = scope.metrics.filter(metric => !metric.descriptor.name.startsWith('jevable.storage.queue.') || metric === available);
    }
}
export function installStorageQueueMetrics(meter, read) {
    const available = meter.createObservableGauge('jevable.storage.queue.available', { unit: '1',
        description: 'One when this PostgreSQL owner supplies current in-memory queue occupancy; zero means unknown or unsupported, not empty' });
    const operations = meter.createObservableGauge('jevable.storage.queue.operations', { unit: '{operation}',
        description: 'Admitted process-local domain/journal operations waiting to enter or currently executing; not distributed workflow backlog, commit receipts or worker capacity' });
    meter.addBatchObservableCallback(result => {
        let state = { available: false };
        try {
            const snapshot = read();
            if (snapshot.available === true) {
                const domain = { waiting: snapshot.domain.waiting, active: snapshot.domain.active };
                const journal = { waiting: snapshot.journal.waiting, active: snapshot.journal.active };
                if ([domain, journal].every(value => Number.isSafeInteger(value.waiting) && value.waiting >= 0
                    && Number.isSafeInteger(value.active) && value.active >= 0 && value.active <= 1))
                    state = { available: true, domain, journal };
            }
        }
        catch { /* Diagnostic source failures report unknown; never change work or export arbitrary errors. */ }
        result.observe(available, Number(state.available));
        if (!state.available)
            return;
        for (const queue of ['domain', 'journal'])
            for (const phase of ['waiting', 'active'])
                result.observe(operations, state[queue][phase], { 'jevable.storage.queue': queue, 'jevable.storage.queue.state': phase });
    }, [available, operations]);
}
