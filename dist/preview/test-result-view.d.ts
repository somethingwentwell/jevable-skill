export interface PreviewTestResultTarget {
    runId: string;
    revision: string;
    inspect: boolean;
    test?: {
        id: string;
        generation: number;
        sha256: string;
    };
}
export interface PreviewTestResultView {
    heading: string;
    explanation: string;
    workflow: string;
    inspected: boolean;
    checks: {
        label: string;
        outcome: string;
        expected: string;
        actual: string;
        excerpt: boolean;
    }[];
}
/** Pure browser-safe presentation of an already-authorized retained assessment.
 * No result evaluation, workflow control, private-value reconstruction or IO. */
export declare function projectPreviewTestResult(value: unknown, target: PreviewTestResultTarget): PreviewTestResultView;
