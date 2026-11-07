import { boundedFlush, ExportFailure, postOtlp } from "./otlp.js";
/** Shared bounded record transport for traces/logs; no retry, ambient settings or collector diagnostics. */
export class BoundedOtlpQueue {
    policy;
    endpoint;
    credential;
    serialize;
    rejected;
    canExport;
    signal;
    queue = [];
    timer;
    pumping;
    controller;
    stopped = false;
    closing;
    inFlight = 0;
    counters = { accepted: 0, exported: 0, rejected: 0, dropped: 0, failedBatches: 0, successfulBatches: 0 };
    lastSuccessAt = null;
    lastFailure = null;
    constructor(policy, endpoint, credential, serialize, rejected, canExport = () => true, signal = 'traces') {
        this.policy = policy;
        this.endpoint = endpoint;
        this.credential = credential;
        this.serialize = serialize;
        this.rejected = rejected;
        this.canExport = canExport;
        this.signal = signal;
    }
    busy() { return Boolean(this.pumping); }
    enqueue(record) {
        if (this.stopped || this.queue.length + this.inFlight >= this.policy.queueSize) {
            this.counters.dropped++;
            return;
        }
        this.queue.push(record);
        this.counters.accepted++;
        this.schedule();
    }
    schedule() {
        if (this.stopped || !this.queue.length || this.timer || this.pumping)
            return;
        this.timer = setTimeout(() => { this.timer = undefined; void this.pump(); }, this.policy.intervalMs);
        this.timer.unref();
    }
    status() {
        return { enabled: true, protocol: this.policy.protocol, ...this.counters, queued: this.queue.length,
            inFlight: this.inFlight, lastSuccessAt: this.lastSuccessAt, lastFailure: this.lastFailure,
            closed: this.stopped && this.inFlight === 0 && this.queue.length === 0,
            deliveryGuarantee: 'best-effort; journal remains authoritative' };
    }
    pump() {
        if (this.pumping)
            return this.pumping;
        clearTimeout(this.timer);
        this.timer = undefined;
        this.pumping = (async () => {
            while (this.queue.length) {
                if (!this.canExport())
                    break;
                const batch = this.queue.splice(0, this.policy.batchSize);
                this.inFlight = batch.length;
                this.lastFailure = null;
                try {
                    let bytes;
                    try {
                        bytes = this.serialize(batch);
                    }
                    catch {
                        throw new ExportFailure('serialization');
                    }
                    this.controller = new AbortController();
                    const response = await postOtlp(this.endpoint, bytes, this.policy, this.credential, this.controller, this.signal);
                    let rejected;
                    try {
                        rejected = this.rejected(response);
                    }
                    catch {
                        throw new ExportFailure('response');
                    }
                    if (!Number.isSafeInteger(rejected) || rejected < 0 || rejected > batch.length)
                        throw new ExportFailure('response');
                    this.counters.rejected += rejected;
                    this.counters.exported += batch.length - rejected;
                    this.counters.successfulBatches++;
                    this.lastSuccessAt = new Date().toISOString();
                    this.lastFailure = rejected ? 'partial-rejection' : null;
                }
                catch (error) {
                    this.counters.failedBatches++;
                    this.counters.dropped += batch.length;
                    this.lastFailure = error instanceof ExportFailure ? error.category : 'transport';
                }
                finally {
                    this.controller = undefined;
                    this.inFlight = 0;
                }
            }
        })().finally(() => { this.pumping = undefined; this.schedule(); });
        return this.pumping;
    }
    async forceFlush() { await boundedFlush(this.pump(), this.policy.flushTimeoutMs); }
    shutdown() {
        return this.closing ??= (async () => {
            this.stopped = true;
            clearTimeout(this.timer);
            this.timer = undefined;
            await this.forceFlush();
            this.counters.dropped += this.queue.length;
            this.queue = [];
            this.controller?.abort();
            await this.pumping;
        })();
    }
}
