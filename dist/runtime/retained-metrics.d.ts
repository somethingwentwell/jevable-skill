import type { LocalRun } from './run-types.ts';
export declare const RETAINED_STATUSES: readonly ["paused", "executing", "waiting", "completed", "failed", "cancelled"];
export type RetainedMetricSnapshot = {
    available: false;
} | {
    available: true;
    runs: Record<typeof RETAINED_STATUSES[number], number>;
    approvals: Record<'awaiting' | 'expired', {
        count: number;
        oldestAgeSeconds: number;
    }>;
};
type Event = {
    kind: string;
    at: string;
    data: unknown;
};
/** Owned diagnostic projection, never execution authority. No workflow payloads or periodic database reads. */
export declare class RetainedRunMetrics {
    private readonly maxRuns;
    private readonly healthy;
    private readonly records;
    private initialized;
    private invalid;
    constructor(maxRuns: number, healthy?: () => boolean);
    ready(): void;
    invalidate(): void;
    /** Only after complete ledger/model validation; used by the owner's startup scan. */
    restore(record: LocalRun, events: readonly Event[]): void;
    /** Called inside the owner's serialized write boundary, only after commit acknowledgement. */
    committed(record: LocalRun, kind: string): void;
    private observe;
    snapshot(now?: number): RetainedMetricSnapshot;
}
export {};
