import { z } from 'zod';
export declare const suiteObservationSchema: z.ZodObject<{
    sha256: z.ZodString;
    mode: z.ZodEnum<{
        result: "result";
        run: "run";
    }>;
    failurePolicy: z.ZodEnum<{
        continue: "continue";
        stop: "stop";
    }>;
    entries: z.ZodNumber;
    concurrency: z.ZodNumber;
}, z.core.$strict>;
export type SuiteObservationIdentity = z.infer<typeof suiteObservationSchema>;
export declare const SUITE_OUTCOMES: Set<string>;
/** Invocation-local dispatch counts, not retained workflow states or distributed capacity. */
export interface SuiteCaseSnapshot {
    waiting: number;
    running: number;
    settled: number;
}
export type SuiteCaseReporter = (snapshot: SuiteCaseSnapshot) => void;
export interface SuiteObservation {
    within(work: () => Promise<unknown>): unknown;
    finish(outcome: string): void;
    cases?(snapshot: Readonly<SuiteCaseSnapshot>): void;
}
/** Optional diagnostics never substitute results, mask failures or invoke work twice. */
export declare function withSuiteObservation<T extends {
    status: string;
}>(host: {
    observeTestSuite?: (identity: SuiteObservationIdentity) => SuiteObservation | undefined;
}, identity: SuiteObservationIdentity, work: (cases: SuiteCaseReporter) => Promise<T>): Promise<T>;
