import type { TelemetryPolicy } from './config.ts'
import { boundedFlush, ExportFailure, postOtlp, type OtlpCredential } from './otlp.ts'
import type { OtlpSignal } from './grpc.ts'

/** Shared bounded record transport for traces/logs; no retry, ambient settings or collector diagnostics. */
export class BoundedOtlpQueue<T> {
  private queue: T[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private pumping: Promise<void> | undefined
  private controller: AbortController | undefined
  private stopped = false
  private closing: Promise<void> | undefined
  private inFlight = 0
  private counters = { accepted: 0, exported: 0, rejected: 0, dropped: 0, failedBatches: 0, successfulBatches: 0 }
  private lastSuccessAt: string | null = null
  private lastFailure: 'transport' | 'partial-rejection' | 'response' | 'serialization' | null = null
  constructor(private readonly policy: TelemetryPolicy, private readonly endpoint: string,
    private readonly credential: OtlpCredential,
    private readonly serialize: (batch: T[]) => Uint8Array | undefined,
    private readonly rejected: (response: Uint8Array) => number,
    private readonly canExport: () => boolean = () => true,
    private readonly signal: OtlpSignal = 'traces') {}
  busy() { return Boolean(this.pumping) }
  enqueue(record: T) {
    if (this.stopped || this.queue.length + this.inFlight >= this.policy.queueSize) { this.counters.dropped++; return }
    this.queue.push(record); this.counters.accepted++; this.schedule()
  }
  private schedule() {
    if (this.stopped || !this.queue.length || this.timer || this.pumping) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.pump() }, this.policy.intervalMs)
    this.timer.unref()
  }
  status() { return { enabled: true, protocol: this.policy.protocol, ...this.counters, queued: this.queue.length,
    inFlight: this.inFlight, lastSuccessAt: this.lastSuccessAt, lastFailure: this.lastFailure,
    closed: this.stopped && this.inFlight === 0 && this.queue.length === 0,
    deliveryGuarantee: 'best-effort; journal remains authoritative' } }
  private pump(): Promise<void> {
    if (this.pumping) return this.pumping
    clearTimeout(this.timer); this.timer = undefined
    this.pumping = (async () => {
      while (this.queue.length) {
        if (!this.canExport()) break
        const batch = this.queue.splice(0, this.policy.batchSize); this.inFlight = batch.length; this.lastFailure = null
        try {
          let bytes: Uint8Array | undefined
          try { bytes = this.serialize(batch) } catch { throw new ExportFailure('serialization') }
          this.controller = new AbortController()
          const response = await postOtlp(this.endpoint, bytes, this.policy, this.credential, this.controller, this.signal)
          let rejected: number
          try { rejected = this.rejected(response) } catch { throw new ExportFailure('response') }
          if (!Number.isSafeInteger(rejected) || rejected < 0 || rejected > batch.length) throw new ExportFailure('response')
          this.counters.rejected += rejected; this.counters.exported += batch.length - rejected; this.counters.successfulBatches++
          this.lastSuccessAt = new Date().toISOString(); this.lastFailure = rejected ? 'partial-rejection' : null
        } catch (error) {
          this.counters.failedBatches++; this.counters.dropped += batch.length
          this.lastFailure = error instanceof ExportFailure ? error.category : 'transport'
        } finally { this.controller = undefined; this.inFlight = 0 }
      }
    })().finally(() => { this.pumping = undefined; this.schedule() })
    return this.pumping
  }
  async forceFlush() { await boundedFlush(this.pump(), this.policy.flushTimeoutMs) }
  shutdown() {
    return this.closing ??= (async () => {
      this.stopped = true; clearTimeout(this.timer); this.timer = undefined
      await this.forceFlush()
      this.counters.dropped += this.queue.length; this.queue = []; this.controller?.abort()
      await this.pumping
    })()
  }
}
