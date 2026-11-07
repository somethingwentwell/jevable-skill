export { RuntimeHttpError } from './errors.ts';
import type { RuntimeOperation } from './operations.ts';
import { type IncomingMessage } from 'node:http';
import { type ReviewerDecisionRequest } from '../access/reviewer.ts';
import { type TraceRequestContext } from '../telemetry/baggage.ts';
import { type CallerCancellationRequest, type CallerReleasePin, type CallerStartRequest, type CallerRunReceipt, type CallerRunResult } from '../access/caller.ts';
import { type CallerCancellationReceipt } from '../access/caller-cancellation.ts';
import { type CallerControlRequest, type CallerControlCheckpoint, type CallerControlReceipt } from '../access/caller-control.ts';
import { type CallerStreamOptions, type CallerStreamEvent } from './caller-stream.ts';
import { type AsyncRunRequest, type AsyncRunReceipt } from './async-runs.ts';
export interface RuntimeClientTlsOptions {
    ca?: string;
    expectedInstanceId?: string;
}
export type RuntimeTraceContext = string | TraceRequestContext;
export interface AsyncRunClientOptions {
    timeoutMs?: number;
    maxResponseBytes?: number;
    ca?: string;
    /** Required for an exact-release host; retained and checked on every request and receipt. */
    release?: {
        id: string;
        sha256: string;
        revision: string;
    };
}
interface ResponseAdmission {
    releaseSha256?: string;
    admit?: (value: unknown, status: number, response: IncomingMessage) => unknown;
}
/** Explicit loopback HTTP or verified HTTPS; no discovery, redirects or automatic retries. */
declare class RuntimeHttpTransport {
    private readonly token;
    private readonly timeoutMs;
    private readonly maxResponseBytes;
    private readonly endpoint;
    private readonly ca;
    private expectedInstanceId;
    protected constructor(endpoint: string, token: string, timeoutMs?: number, maxResponseBytes?: number, tls?: RuntimeClientTlsOptions, kind?: 'owner' | 'reviewer' | 'caller');
    /** Explicit one-way owner pin, shared by every later request. Never relax or silently replace it. */
    pinInstance(instanceId: string): void;
    protected request(path: string, command?: unknown, traceParent?: RuntimeTraceContext, admission?: ResponseAdmission): Promise<unknown>;
    /** One explicit POST stream. Abort/disconnect/EOF never reconnect, resume or repeat the request. */
    protected requestEvents(path: string, command: unknown, signal?: AbortSignal): AsyncGenerator<{
        event: string;
        data: unknown;
    }>;
}
/** Owner-only async admission/status. Explicit instance pin, no discovery, retries or execution controls. */
export declare class AsyncRunClient extends RuntimeHttpTransport {
    private readonly instanceId;
    private readonly release;
    constructor(endpoint: string, token: string, instanceId: string, options?: AsyncRunClientOptions);
    start(value: AsyncRunRequest, traceContext?: RuntimeTraceContext): Promise<AsyncRunReceipt>;
    /** A metadata read only. Never resumes, waits for completion, or returns private run payloads. */
    show(id: string): Promise<AsyncRunReceipt>;
    private sameId;
    private sameRelease;
    private receipt;
}
/** Grant-only pinned-release operations. Never authenticates owner operations or discovers a host. */
export declare class CallerClient extends RuntimeHttpTransport {
    private readonly instanceId;
    private readonly release;
    constructor(endpoint: string, token: string, instanceId: string, release: CallerReleasePin, timeoutMs?: number, maxResponseBytes?: number, tls?: Pick<RuntimeClientTlsOptions, 'ca'>);
    start(value: CallerStartRequest, traceParent?: RuntimeTraceContext): Promise<{
        schemaVersion: 1;
        instanceId: string;
        result: CallerRunReceipt;
    }>;
    read(id: string, traceParent?: RuntimeTraceContext): Promise<{
        schemaVersion: 1;
        instanceId: string;
        result: CallerRunResult;
    }>;
    /** Observe metadata only, even when read permission also permits completed output. */
    stream(id: string, options?: CallerStreamOptions): AsyncGenerator<CallerStreamEvent>;
    cancel(id: string, value: CallerCancellationRequest, traceParent?: RuntimeTraceContext): Promise<{
        schemaVersion: 1;
        instanceId: string;
        result: CallerCancellationReceipt;
    }>;
    checkpoint(id: string, traceParent?: RuntimeTraceContext): Promise<{
        schemaVersion: 1;
        instanceId: string;
        result: CallerControlCheckpoint;
    }>;
    control(id: string, value: CallerControlRequest, traceParent?: RuntimeTraceContext): Promise<{
        schemaVersion: 1;
        instanceId: string;
        result: CallerControlReceipt;
    }>;
    private call;
}
/** Owner-only management client. Grant tokens cannot construct or authenticate it. */
export declare class RuntimeClient<Operation = RuntimeOperation> extends RuntimeHttpTransport {
    constructor(endpoint: string, token: string, timeoutMs?: number, maxResponseBytes?: number, tls?: RuntimeClientTlsOptions);
    capabilities(): Promise<unknown>;
    health(): Promise<unknown>;
    operation(command: Operation, traceParent?: RuntimeTraceContext): Promise<unknown>;
}
/** Separate grant-only client. No discovery, owner operations, storage, token lookup or retries. */
export declare class ReviewerClient extends RuntimeHttpTransport {
    private readonly instanceId;
    constructor(endpoint: string, token: string, instanceId: string, timeoutMs?: number, maxResponseBytes?: number, tls?: Pick<RuntimeClientTlsOptions, 'ca'>);
    decide(value: ReviewerDecisionRequest, traceParent?: RuntimeTraceContext): Promise<{
        schemaVersion: 1;
        instanceId: string;
        result: {
            schemaVersion: 1;
            requestId: string;
            runId: string;
            attemptId: string;
            revision: string;
            action: string;
            at: string;
            pauseAfter: boolean;
            status: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
        };
    }>;
}
