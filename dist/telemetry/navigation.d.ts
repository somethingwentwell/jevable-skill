export interface TracePathViewerConfig {
    schemaVersion: 1;
    origin: string;
    pathTemplate: string;
    spanParameter?: 'spanID' | 'spanId' | 'span';
}
export interface GrafanaTempoViewerConfig {
    schemaVersion: 2;
    kind: 'grafana-tempo-explore';
    origin: string;
    datasourceUid: string;
    orgId: number;
    range: {
        from: string;
        to: string;
    };
    pathPrefix?: string;
}
export type TraceViewerConfig = TracePathViewerConfig | GrafanaTempoViewerConfig;
export interface TraceReference {
    source: string;
    traceId: string;
    spanId: string;
    traceFlags: 0 | 1;
    url: string | null;
    nodeId?: string;
    attemptId?: string;
    tryId?: string;
    requestId?: string;
    loop?: string;
    iteration?: number;
    sequence?: string;
    index?: number;
}
/** Serializable, network-free trace destination and metadata projection. No exporter settings or credentials are read. */
export declare function traceNavigationTools(): {
    config: (value: unknown) => TraceViewerConfig;
    project: (value: unknown, destination?: TraceViewerConfig) => {
        schemaVersion: 1;
        format: "jevable.ai/trace-navigation";
        runId: string;
        revision: string;
        workflowStatus: string;
        destination: TraceViewerConfig | null;
        availability: "delivery-unverified" | "trace-context-not-recorded";
        execution: "not-started-or-resumed";
        references: TraceReference[];
    };
};
