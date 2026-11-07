import { type WorkflowCompilerLimits } from '../workflow/index.ts';
import { type SuiteEntryResult, type TestSuiteHost } from './suite.ts';
export declare const TEST_COVERAGE_MAX_STEPS = 100000;
export interface TestCoverageNode {
    scope: string;
    nodeId: string;
    kind: string;
    settledResults: number;
    runs: number;
}
export interface TestCoverageRoute {
    scope: string;
    from: string;
    port: string;
    to?: string;
    kind: 'continuation' | 'loop-return';
    selections: number;
    runs: number;
}
export interface TestSuiteCoverage {
    schemaVersion: 1;
    kind: 'JevableTestSuiteCoverage';
    suiteSha256: string;
    revision: string;
    observationStatus: 'complete' | 'partial' | 'interrupted';
    entries: SuiteEntryResult[];
    nodes: TestCoverageNode[];
    routes: TestCoverageRoute[];
    summary: {
        selectedRuns: number;
        observedRuns: number;
        terminalRuns: number;
        passedAssessments: number;
        nodesWithResults: number;
        totalNodes: number;
        routesWithSelections: number;
        totalRoutes: number;
        resultsWithoutRecordedPort: number;
        loopIterationReturns: number;
    };
    consistency: 'per-run-observations; not-an-atomic-snapshot';
    execution: 'not-requested';
    semantics: 'settled-results-and-recorded-port-selections; not-path-or-condition-coverage';
}
/** Aggregate exact retained test identities against one compiled revision. Reads only testResult;
 * never discovers cases, starts work, infers legacy ports, counts a waiting checkpoint as settled,
 * or counts loop return bookkeeping as another node execution. Private values are not returned. */
export declare function testSuiteCoverage(host: Pick<TestSuiteHost, 'testResult'>, value: unknown, source: string, options?: {
    limits?: WorkflowCompilerLimits;
    signal?: AbortSignal;
}): Promise<TestSuiteCoverage>;
