import { type TraceViewerConfig } from '../telemetry/navigation.ts';
/** Verifies a metadata-only runtime envelope, then prepares links without contacting or opening their destination. */
export declare function prepareTraceNavigation(expected: {
    runId: string;
    revision: string;
}, evidence: unknown, destination?: TraceViewerConfig): Promise<{
    snapshotSha256: string;
    schemaVersion: 1;
    format: "jevable.ai/trace-navigation";
    runId: string;
    revision: string;
    workflowStatus: string;
    destination: TraceViewerConfig | null;
    availability: "delivery-unverified" | "trace-context-not-recorded";
    execution: "not-started-or-resumed";
    references: import("../telemetry/navigation.ts").TraceReference[];
}>;
