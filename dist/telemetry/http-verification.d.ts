import { z } from 'zod';
export declare const httpObservationLedgerSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    ownerAttribute: z.ZodEnum<{
        "service.instance.id": "service.instance.id";
        "k8s.pod.uid": "k8s.pod.uid";
    }>;
    owners: z.ZodArray<z.ZodUUID>;
    clockDomain: z.ZodLiteral<"shared-unix-milliseconds">;
    intents: z.ZodArray<z.ZodObject<{
        id: z.ZodUUID;
        ownerId: z.ZodUUID;
        startedMs: z.ZodNumber;
        method: z.ZodEnum<{
            POST: "POST";
            GET: "GET";
            HEAD: "HEAD";
            PUT: "PUT";
            DELETE: "DELETE";
            CONNECT: "CONNECT";
            OPTIONS: "OPTIONS";
            TRACE: "TRACE";
            PATCH: "PATCH";
            _OTHER: "_OTHER";
        }>;
        route: z.ZodNullable<z.ZodEnum<{
            "/": "/";
            "/v1/capabilities": "/v1/capabilities";
            "/v1/health": "/v1/health";
            "/v1/operations": "/v1/operations";
            "/v1/preview/bootstrap": "/v1/preview/bootstrap";
            "/v1/preview/operations": "/v1/preview/operations";
            "/v1/preview/logout": "/v1/preview/logout";
            "/v1/reviewer/decisions": "/v1/reviewer/decisions";
            "/v1/caller/operations": "/v1/caller/operations";
            "/v1/caller/stream": "/v1/caller/stream";
            "/v1/async-runs": "/v1/async-runs";
            "/v1/webhooks": "/v1/webhooks";
            "/v1/async-runs/{id}": "/v1/async-runs/{id}";
        }>>;
    }, z.core.$strict>>;
    settlements: z.ZodArray<z.ZodObject<{
        id: z.ZodUUID;
        endedMs: z.ZodNumber;
        status: z.ZodNumber;
        context: z.ZodString;
        bodyEnded: z.ZodLiteral<true>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type HttpObservationLedger = z.infer<typeof httpObservationLedgerSchema>;
export interface HttpObservationSignals {
    traces: string;
    metrics: string;
    logs: string;
}
export type HttpObservationVerificationFailure = 'invalid-input' | 'incomplete-evidence' | 'inconsistent-evidence' | 'limit';
export declare class HttpObservationVerificationError extends Error {
    readonly code: HttpObservationVerificationFailure;
    constructor(code: HttpObservationVerificationFailure);
}
/**
 * Reconcile supplied independent completed-response evidence with unfiltered Jevable HTTP signals.
 * Requires sampled response contexts, cumulative metrics, a shared clock and one resource instance
 * per declared owner. No I/O or execution. A match is not attestation of capture completeness,
 * backend durability, disconnected requests, business commits or production qualification.
 */
export declare function verifyHttpObservations(input: unknown, signals: HttpObservationSignals): {
    scope: string;
    rateAdmissionLinks?: {
        contexts: number;
        sampled: number;
        unsampled: number;
        scope: string;
    };
    status: "matched-recorded-http-observations";
    responseJoins: number;
    requestSpans: number;
    requestLogs: number;
    cumulativeRequestTotal: number;
    boundedSeries: number;
    distributionSnapshots: number;
    owners: {
        ownerId: string;
        responses: number;
    }[];
};
