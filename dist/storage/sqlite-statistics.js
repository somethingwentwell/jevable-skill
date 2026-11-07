/** Bounded process-local native-call observations. No SQL, arguments, rows or errors retained. */
export const SQLITE_METHODS = ['exec', 'prepare', 'all', 'get', 'run', 'iterate', 'iterator.next', 'iterator.return'];
export const SQLITE_OUTCOMES = ['returned', 'threw'];
export const SQLITE_DURATION_BOUNDS = Object.freeze([0.001, 0.01, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 3600]);
export class SQLiteStatementStatistics {
    available = true;
    values = SQLITE_METHODS.flatMap(method => SQLITE_OUTCOMES.map(outcome => ({ method, outcome,
        calls: 0, seconds: 0, duration: { buckets: Array(SQLITE_DURATION_BOUNDS.length + 1).fill(0),
            min: undefined, max: undefined } })));
    invalidate() { this.available = false; }
    record(method, outcome, seconds) {
        if (!this.available)
            return;
        const value = this.values.find(value => value.method === method && value.outcome === outcome);
        if (!value || !Number.isFinite(seconds) || seconds < 0 || value.calls >= Number.MAX_SAFE_INTEGER
            || !Number.isFinite(value.seconds + seconds)) {
            this.invalidate();
            return;
        }
        value.calls++;
        value.seconds += seconds;
        const bucket = SQLITE_DURATION_BOUNDS.findIndex(bound => seconds <= bound);
        value.duration.buckets[bucket === -1 ? SQLITE_DURATION_BOUNDS.length : bucket]++;
        value.duration.min = value.duration.min === undefined ? seconds : Math.min(value.duration.min, seconds);
        value.duration.max = value.duration.max === undefined ? seconds : Math.max(value.duration.max, seconds);
    }
    snapshot() {
        return this.available ? { available: true,
            values: this.values.map(value => ({ ...value, duration: { ...value.duration, buckets: [...value.duration.buckets] } })) }
            : { available: false };
    }
}
