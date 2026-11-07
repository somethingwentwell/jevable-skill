import type { RuntimeOperation } from '../http/operations.ts';
import { type WorkflowCompilerLimits } from '../workflow/index.ts';
import { type TraceViewerConfig } from '../telemetry/navigation.ts';
/** The owner fixes actor identity and retains all state; the preview never owns a second database. */
export interface PreviewOperations {
    call(command: RuntimeOperation): Promise<unknown>;
}
/** One explicitly admitted preview project, never an adapter to a desktop/harness session. */
export declare class PreviewSession {
    private readonly owner;
    private readonly limits;
    private readonly tokens;
    private readonly releaseCursors;
    private projectPin;
    get pin(): {
        id: string;
        generation: number;
        revision: string;
    };
    private readonly rendered;
    private readonly graph;
    private readonly traceViewer;
    private constructor();
    static create(owner: PreviewOperations, source: string, projectId?: string, limits?: WorkflowCompilerLimits, traceViewer?: TraceViewerConfig): Promise<PreviewSession>;
    /** Read-only startup for exactly a reviewed active accepted project. No create fallback. */
    static attach(owner: PreviewOperations, source: string, value: unknown, limits?: WorkflowCompilerLimits, traceViewer?: TraceViewerConfig): Promise<PreviewSession>;
    bootstrap(): {
        token: string;
        expiresAt: string;
        project: {
            id: string;
            generation: number;
            revision: string;
        };
        scope: string;
        retention: string;
    };
    authenticate(header: string | undefined): string | undefined;
    revoke(token: string): void;
    private matches;
    private scopedCase;
    private scopedRun;
    private list;
    private packEvidence;
    operation(value: unknown): Promise<unknown>;
}
