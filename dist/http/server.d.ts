import type { SpanContext } from '@opentelemetry/api';
import type { HttpRateSqlOperation, HttpRateSqlObservation } from './rate-sql-observation.ts';
import type { operationCapabilities } from './operation-host.ts';
import type { PreviewSession } from '../preview/session.ts';
import type { ReleaseSession } from '../releases/service-session.ts';
import { type RuntimeTlsOptions } from './tls.ts';
import type { HttpRequestObservation } from '../telemetry/http.ts';
import type { AsyncSlotObservation } from '../telemetry/async-slots.ts';
import type { HttpConnectionObservation, HttpTransport, HttpTransportFailure } from '../telemetry/connections.ts';
import { type ReviewerDecisionRequest, type ReviewerDecisionReceipt, type ReviewerDecisionContext } from '../access/reviewer.ts';
import { type CallerOperation, type CallerReleasePin, type CallerRunResult } from '../access/caller.ts';
import type { CallerCancellationReceipt } from '../access/caller-cancellation.ts';
import type { CallerControlCheckpoint, CallerControlReceipt } from '../access/caller-control.ts';
import type { TraceRequestContext } from '../telemetry/baggage.ts';
import { type AsyncRunPolicy, type AsyncRunHost } from './async-runs.ts';
import { type HttpRateLimits } from './rate-limits.ts';
import { type CoordinatedHttpRateLimits } from './coordinated-rate-limits.ts';
import { type ReleaseWebhookConfig } from '../releases/webhooks.ts';
import type { ReleaseMessageSession } from '../releases/messages.ts';
import { type HttpAccessObservation, type HttpAccessStage } from './access-observation.ts';
export interface RuntimeServerOptions {
    token: string;
    actor: string;
    port?: number;
    maxRequestBytes?: number;
    maxResponseBytes?: number;
    maxConcurrentRequests?: number;
    tls?: RuntimeTlsOptions;
    /** Opt-in reviewer route; release hosts additionally expose one scoped request read. */
    reviewerDecisions?: boolean;
    /** Management-only pinned-release caller operations; disabled by default. No reserved owner capacity. */
    callerOperations?: boolean;
    /** Owner-only start/status routes. Explicit bounded background capacity; disabled by default. */
    asyncRuns?: AsyncRunPolicy;
    /** HMAC-authenticated intake for one API release; requires explicit shared async capacity. */
    webhooks?: ReleaseWebhookConfig;
    /** Startup-only, instance-local request quotas. Disabled by default; not distributed or durable. */
    rateLimits?: HttpRateLimits;
    /** Trusted SDK-only atomic coordinator. Explicit shared scope/policy; no discovery or local fallback. */
    coordinatedRateLimits?: CoordinatedHttpRateLimits;
    /** Opt-in local-machine trust: mint project-only preview sessions without an owner key in the browser. */
    previewAutoConnect?: boolean;
}
/** Internal owned host port. Importing the transport never imports or opens a storage backend. */
export interface RuntimeServiceHost {
    capabilities(): object;
    operations?: ReturnType<typeof operationCapabilities>;
    operation?(value: unknown): Promise<unknown>;
    asyncRuns?: AsyncRunHost;
    releaseMessages?: ReleaseMessageSession;
    reviewerDecision?(token: string, value: ReviewerDecisionRequest, context: ReviewerDecisionContext): Promise<ReviewerDecisionReceipt>;
    reviewerRequest?(token: string): Promise<unknown>;
    callerOperation?(token: string, value: CallerOperation, context: <Result extends CallerRunResult | CallerCancellationReceipt | CallerControlCheckpoint | CallerControlReceipt>(pin: CallerReleasePin, execute: () => Promise<Result>) => Promise<Result>): Promise<CallerRunResult | CallerCancellationReceipt | CallerControlCheckpoint | CallerControlReceipt>;
    withTraceParent<T>(parent: string | undefined, operation: () => T): T;
    withTraceContext?<T>(context: TraceRequestContext, operation: () => T): T;
    observeHttpRequest?(method: string | undefined, path: string | undefined): HttpRequestObservation | undefined;
    observeHttpAccess?(stage: HttpAccessStage): HttpAccessObservation | undefined;
    observeHttpRateSql?(operation: HttpRateSqlOperation, parent: SpanContext | undefined): HttpRateSqlObservation | undefined;
    observeHttpAsyncSlot?(): AsyncSlotObservation | undefined;
    observeHttpConnection?(transport: HttpTransport): HttpConnectionObservation | undefined;
    observeHttpTransportFailure?(transport: HttpTransport, failure: HttpTransportFailure): void;
    close(): Promise<void>;
    health?(): Promise<unknown>;
    /** Process-local OTel identity, not HTTP fencing authority or exporter delivery proof. */
    telemetryResource?(): {
        serviceInstanceId: string;
    } | undefined;
    failure?(error: unknown): {
        status: number;
        code: string;
    } | undefined;
    release?: {
        pin: ReleaseSession['pin'];
    };
    preparePreview?(): Promise<Pick<PreviewSession, 'pin' | 'authenticate' | 'bootstrap' | 'revoke' | 'operation'>>;
}
/** Single-owner loopback HTTP or explicit direct HTTPS. Scoped preview remains loopback-only. */
export declare function startRuntimeServer(options: RuntimeServerOptions, open: (actor: string) => Promise<RuntimeServiceHost>): Promise<{
    preview?: {
        project: {
            id: string;
            generation: number;
            revision: string;
        };
        retention: string;
        visualReview: string;
    };
    release?: Readonly<{
        id: string;
        sha256: string;
        revision: string;
        version: string;
        runtime: Readonly<{
            version: string;
            sha256: string;
        }>;
    }>;
    tls?: {
        minimumVersion: string;
        certificateSha256: string;
    };
    listener: {
        address: string;
        port: number;
    };
    telemetryResource?: {
        serviceInstanceId: string;
    };
    url: string;
    instanceId: `${string}-${string}-${string}-${string}-${string}`;
    protocol: string;
    transport: string;
    close: (timeoutMs?: number) => Promise<{
        activeAsyncRuns?: number;
        status: "draining" | "closed";
        activeRequests: number;
    }>;
    closed: Promise<void>;
}>;
