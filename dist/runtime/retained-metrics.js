export const RETAINED_STATUSES = ['paused', 'executing', 'waiting', 'completed', 'failed', 'cancelled'];
/** Owned diagnostic projection, never execution authority. No workflow payloads or periodic database reads. */
export class RetainedRunMetrics {
    maxRuns;
    healthy;
    records = new Map();
    initialized = false;
    invalid = false;
    constructor(maxRuns, healthy = () => true) {
        this.maxRuns = maxRuns;
        this.healthy = healthy;
    }
    ready() { this.initialized = true; }
    invalidate() { this.invalid = true; }
    /** Only after complete ledger/model validation; used by the owner's startup scan. */
    restore(record, events) {
        let at;
        if (record.state.status === 'waiting') {
            const attempt = record.state.attempt.id;
            const requests = events.filter(event => event.kind === 'approval-requested' && event.data !== null && typeof event.data === 'object'
                && Reflect.get(event.data, 'attemptId') === attempt);
            if (requests.length !== 1) {
                this.invalidate();
                return;
            }
            at = requests[0].at;
        }
        this.observe(record, at);
    }
    /** Called inside the owner's serialized write boundary, only after commit acknowledgement. */
    committed(record, kind) {
        this.observe(record, kind === 'approval-requested' ? record.updatedAt : undefined);
    }
    observe(record, requestedAt) {
        if (this.invalid)
            return;
        try {
            if (!this.records.has(record.id) && this.records.size >= this.maxRuns) {
                this.invalidate();
                return;
            }
            const entry = { status: record.state.status };
            if (!RETAINED_STATUSES.includes(entry.status)) {
                this.invalidate();
                return;
            }
            if (record.state.status === 'waiting') {
                const previous = this.records.get(record.id)?.approval;
                const at = requestedAt === undefined ? (previous?.attempt === record.state.attempt.id ? previous.at : NaN) : Date.parse(requestedAt);
                const expires = Math.min(Date.parse(record.state.expiresAt), record.state.scope ? record.loopDeadlines[record.state.scope.loop] ?? NaN : Infinity);
                if (!Number.isFinite(at) || !Number.isFinite(expires)) {
                    this.invalidate();
                    return;
                }
                entry.approval = { attempt: record.state.attempt.id, at, expires };
            }
            this.records.set(record.id, entry);
        }
        catch {
            this.invalidate();
        } // Optional diagnostics must never turn a committed run into an execution error.
    }
    snapshot(now = Date.now()) {
        if (!this.initialized || this.invalid || !this.healthy() || !Number.isFinite(now))
            return { available: false };
        const runs = Object.fromEntries(RETAINED_STATUSES.map(status => [status, 0]));
        const approvals = { awaiting: { count: 0, oldestAgeSeconds: 0 }, expired: { count: 0, oldestAgeSeconds: 0 } };
        for (const record of this.records.values()) {
            runs[record.status]++;
            if (record.approval) {
                const bucket = approvals[now >= record.approval.expires ? 'expired' : 'awaiting'];
                bucket.count++;
                bucket.oldestAgeSeconds = Math.max(bucket.oldestAgeSeconds, Math.max(0, now - record.approval.at) / 1000);
            }
        }
        return { available: true, runs, approvals };
    }
}
