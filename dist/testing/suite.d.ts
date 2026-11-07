import { z } from 'zod';
import { type TestIdentity } from './schema.ts';
import { type SuiteObservationIdentity, type SuiteObservation } from './suite-observation.ts';
declare const selectionSchema: z.ZodObject<{
    title: z.ZodString;
    failurePolicy: z.ZodEnum<{
        continue: "continue";
        stop: "stop";
    }>;
    concurrency: z.ZodOptional<z.ZodNumber>;
    tests: z.ZodArray<z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
        sha256: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
declare const suiteSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    kind: z.ZodLiteral<"JevableTestSuite">;
    title: z.ZodString;
    failurePolicy: z.ZodEnum<{
        continue: "continue";
        stop: "stop";
    }>;
    concurrency: z.ZodOptional<z.ZodNumber>;
    entries: z.ZodArray<z.ZodObject<{
        test: z.ZodObject<{
            id: z.ZodUUID;
            generation: z.ZodNumber;
            sha256: z.ZodString;
        }, z.core.$strict>;
        runId: z.ZodUUID;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type TestSuite = z.infer<typeof suiteSchema>;
export type TestSuiteSelection = z.infer<typeof selectionSchema>;
export { selectionSchema as testSuiteSelectionSchema, suiteSchema as testSuiteSchema };
export declare const TEST_SUITE_MAX_BYTES = 100000;
/** Preparation allocates run identities only; save this manifest before any dispatch. */
export declare function createTestSuite(value: TestSuiteSelection): {
    suite: {
        schemaVersion: 1;
        kind: "JevableTestSuite";
        title: string;
        failurePolicy: "continue" | "stop";
        entries: {
            test: {
                id: string;
                generation: number;
                sha256: string;
            };
            runId: string;
        }[];
        concurrency?: number | undefined;
    };
    sha256: string;
};
export declare function inspectTestSuite(value: unknown): {
    suite: {
        schemaVersion: 1;
        kind: "JevableTestSuite";
        title: string;
        failurePolicy: "continue" | "stop";
        entries: {
            test: {
                id: string;
                generation: number;
                sha256: string;
            };
            runId: string;
        }[];
        concurrency?: number | undefined;
    };
    sha256: string;
};
export interface TestSuiteHost {
    observeTestSuite?(identity: SuiteObservationIdentity): SuiteObservation | undefined;
    testResult(runId: string): unknown | Promise<unknown>;
    testCase(id: string): unknown | Promise<unknown>;
    project(id: string): unknown | Promise<unknown>;
    runTest(test: TestIdentity, runId: string): unknown | Promise<unknown>;
}
declare const status: z.ZodEnum<{
    cancelled: "cancelled";
    completed: "completed";
    paused: "paused";
    failed: "failed";
    waiting: "waiting";
    executing: "executing";
}>;
export interface SuiteEntryResult {
    index: number;
    test: TestIdentity;
    runId: string;
    observation: 'not-observed' | 'retained' | 'submitted';
    result?: {
        assessment: 'passed' | 'failed' | 'pending' | 'uncertain';
        workflowStatus: z.infer<typeof status>;
        terminal: boolean;
        revision: string;
        checkpointSha256: string;
        observedRunUpdatedAt: string;
        matchedChecks: number;
        totalChecks: number;
    };
    error?: {
        stage: 'read' | 'preflight' | 'submission';
        code: string;
        execution: 'not-requested' | 'may-have-started; inspect-retained-run';
    };
}
export type SuiteStatus = 'passed' | 'failed' | 'pending' | 'attention' | 'uncertain' | 'blocked' | 'interrupted';
export interface TestSuiteReport {
    schemaVersion: 1;
    suiteSha256: string;
    mode: 'run' | 'result';
    status: SuiteStatus;
    failurePolicy: 'stop' | 'continue';
    concurrency?: number;
    entries: SuiteEntryResult[];
    consistency: 'per-run-observations; not-an-atomic-snapshot';
}
/** Shared retained-assessment admission for read-only suite projections. */
export declare function readSuiteEntryResult(value: unknown, entry: SuiteEntryResult): NonNullable<SuiteEntryResult['result']>;
/** Read saved assessments, including missing runs. No acceptance or execution is performed. */
export declare function testSuiteResult(host: TestSuiteHost, value: unknown): Promise<TestSuiteReport>;
/** Whole-batch review preflight, then bounded guarded dispatch. Completed work is never rolled back. */
export declare function runTestSuite(host: TestSuiteHost, value: unknown, reviewedSha256: string, options?: {
    signal?: AbortSignal;
}): Promise<TestSuiteReport>;
