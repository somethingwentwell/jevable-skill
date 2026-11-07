import { z } from 'zod';
import { type AutomaticAdmissionRecord, type AutomaticAdmissionPage } from './automatic-admission.ts';
import { type NotificationReleaseScope } from './release-history.ts';
export declare const automaticDiagnosticSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    request: z.ZodObject<{
        runId: z.ZodUUID;
        revision: z.ZodString;
        attemptId: z.ZodUUID;
        eventKind: z.ZodOptional<z.ZodEnum<{
            cancelled: "cancelled";
            expired: "expired";
            requested: "requested";
            decided: "decided";
        }>>;
        requestId: z.ZodUUID;
        endpointId: z.ZodString;
        endpointSha256: z.ZodString;
        eventSha256: z.ZodString;
        redeliverOf: z.ZodOptional<z.ZodUUID>;
    }, z.core.$strict>;
    policySha256: z.ZodString;
    createdAt: z.ZodISODateTime;
    outcome: z.ZodDiscriminatedUnion<[z.ZodObject<{
        status: z.ZodLiteral<"reserved">;
    }, z.core.$strict>, z.ZodObject<{
        status: z.ZodLiteral<"failed">;
        at: z.ZodISODateTime;
        code: z.ZodEnum<{
            "invalid-command": "invalid-command";
            "not-found": "not-found";
            conflict: "conflict";
            limit: "limit";
            busy: "busy";
            corrupt: "corrupt";
            closed: "closed";
            uncertain: "uncertain";
        }>;
    }, z.core.$strict>, z.ZodObject<{
        status: z.ZodLiteral<"delivery-recorded">;
        at: z.ZodISODateTime;
        deliverySha256: z.ZodString;
        deliveryStatus: z.ZodEnum<{
            pending: "pending";
            settled: "settled";
        }>;
    }, z.core.$strict>], "status">;
    release: z.ZodOptional<z.ZodObject<{
        id: z.ZodUUID;
        sha256: z.ZodString;
    }, z.core.$strict>>;
    semantics: z.ZodLiteral<"reservation-is-not-dispatch-authority; failures-may-follow-external-effects; never-replay-on-read-or-restart">;
}, z.core.$strict>;
export declare const automaticDiagnosticPageSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    admissions: z.ZodArray<z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        request: z.ZodObject<{
            runId: z.ZodUUID;
            revision: z.ZodString;
            attemptId: z.ZodUUID;
            eventKind: z.ZodOptional<z.ZodEnum<{
                cancelled: "cancelled";
                expired: "expired";
                requested: "requested";
                decided: "decided";
            }>>;
            requestId: z.ZodUUID;
            endpointId: z.ZodString;
            endpointSha256: z.ZodString;
            eventSha256: z.ZodString;
            redeliverOf: z.ZodOptional<z.ZodUUID>;
        }, z.core.$strict>;
        policySha256: z.ZodString;
        createdAt: z.ZodISODateTime;
        outcome: z.ZodDiscriminatedUnion<[z.ZodObject<{
            status: z.ZodLiteral<"reserved">;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"failed">;
            at: z.ZodISODateTime;
            code: z.ZodEnum<{
                "invalid-command": "invalid-command";
                "not-found": "not-found";
                conflict: "conflict";
                limit: "limit";
                busy: "busy";
                corrupt: "corrupt";
                closed: "closed";
                uncertain: "uncertain";
            }>;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"delivery-recorded">;
            at: z.ZodISODateTime;
            deliverySha256: z.ZodString;
            deliveryStatus: z.ZodEnum<{
                pending: "pending";
                settled: "settled";
            }>;
        }, z.core.$strict>], "status">;
        release: z.ZodOptional<z.ZodObject<{
            id: z.ZodUUID;
            sha256: z.ZodString;
        }, z.core.$strict>>;
        semantics: z.ZodLiteral<"reservation-is-not-dispatch-authority; failures-may-follow-external-effects; never-replay-on-read-or-restart">;
    }, z.core.$strict>>;
    nextCursor: z.ZodNullable<z.ZodUUID>;
    semantics: z.ZodLiteral<"reservation-is-not-dispatch-authority; failures-may-follow-external-effects; never-replay-on-read-or-restart">;
}, z.core.$strict>;
export declare const automaticDiagnosticStatusSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    configured: z.ZodBoolean;
    policySha256: z.ZodOptional<z.ZodString>;
    routeCount: z.ZodOptional<z.ZodNumber>;
    live: z.ZodNullable<z.ZodObject<{
        pending: z.ZodNumber;
        admitting: z.ZodNumber;
        active: z.ZodNumber;
        sealed: z.ZodBoolean;
        fault: z.ZodOptional<z.ZodObject<{
            code: z.ZodEnum<{
                "invalid-command": "invalid-command";
                "not-found": "not-found";
                conflict: "conflict";
                limit: "limit";
                busy: "busy";
                corrupt: "corrupt";
                closed: "closed";
                uncertain: "uncertain";
            }>;
            requestId: z.ZodOptional<z.ZodUUID>;
            runId: z.ZodOptional<z.ZodUUID>;
            transition: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        semantics: z.ZodLiteral<"live-commits-only; no-replay; failure-is-not-proof-of-no-effect">;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Public diagnostic projection excludes the full policy, other routes/destinations,
 * event body and private review values. It is neither delivery nor approval authority.
 */
export declare function automaticDiagnostic(value: AutomaticAdmissionRecord): {
    schemaVersion: 1;
    request: {
        runId: string;
        revision: string;
        attemptId: string;
        requestId: string;
        endpointId: string;
        endpointSha256: string;
        eventSha256: string;
        eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
        redeliverOf?: string | undefined;
    };
    policySha256: string;
    createdAt: string;
    outcome: {
        status: "reserved";
    } | {
        status: "failed";
        at: string;
        code: "invalid-command" | "not-found" | "conflict" | "limit" | "busy" | "corrupt" | "closed" | "uncertain";
    } | {
        status: "delivery-recorded";
        at: string;
        deliverySha256: string;
        deliveryStatus: "pending" | "settled";
    };
    semantics: "reservation-is-not-dispatch-authority; failures-may-follow-external-effects; never-replay-on-read-or-restart";
    release?: {
        id: string;
        sha256: string;
    } | undefined;
};
export declare function automaticDiagnosticMatches(record: AutomaticAdmissionRecord, scope: NotificationReleaseScope): boolean;
/** Live bounded filtering; retain one page and return matching cursors only. The
 * underlying owner verifies every record, including skipped foreign histories.
 */
export declare function automaticDiagnosticPage(reader: {
    get(id: string): Promise<AutomaticAdmissionRecord>;
    page(page: AutomaticAdmissionPage): Promise<{
        records: AutomaticAdmissionRecord[];
        nextCursor: string | null;
    }>;
}, value: AutomaticAdmissionPage, scopeValue?: NotificationReleaseScope): Promise<{
    schemaVersion: 1;
    admissions: {
        schemaVersion: 1;
        request: {
            runId: string;
            revision: string;
            attemptId: string;
            requestId: string;
            endpointId: string;
            endpointSha256: string;
            eventSha256: string;
            eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
            redeliverOf?: string | undefined;
        };
        policySha256: string;
        createdAt: string;
        outcome: {
            status: "reserved";
        } | {
            status: "failed";
            at: string;
            code: "invalid-command" | "not-found" | "conflict" | "limit" | "busy" | "corrupt" | "closed" | "uncertain";
        } | {
            status: "delivery-recorded";
            at: string;
            deliverySha256: string;
            deliveryStatus: "pending" | "settled";
        };
        semantics: "reservation-is-not-dispatch-authority; failures-may-follow-external-effects; never-replay-on-read-or-restart";
        release?: {
            id: string;
            sha256: string;
        } | undefined;
    }[];
    nextCursor: string | null;
    semantics: "reservation-is-not-dispatch-authority; failures-may-follow-external-effects; never-replay-on-read-or-restart";
}>;
/** Check untrusted selected-owner metadata before CLI output; no raw foreign fields. */
export declare function inspectAutomaticDiagnosticPage(value: unknown, request: AutomaticAdmissionPage): {
    schemaVersion: 1;
    admissions: {
        schemaVersion: 1;
        request: {
            runId: string;
            revision: string;
            attemptId: string;
            requestId: string;
            endpointId: string;
            endpointSha256: string;
            eventSha256: string;
            eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
            redeliverOf?: string | undefined;
        };
        policySha256: string;
        createdAt: string;
        outcome: {
            status: "reserved";
        } | {
            status: "failed";
            at: string;
            code: "invalid-command" | "not-found" | "conflict" | "limit" | "busy" | "corrupt" | "closed" | "uncertain";
        } | {
            status: "delivery-recorded";
            at: string;
            deliverySha256: string;
            deliveryStatus: "pending" | "settled";
        };
        semantics: "reservation-is-not-dispatch-authority; failures-may-follow-external-effects; never-replay-on-read-or-restart";
        release?: {
            id: string;
            sha256: string;
        } | undefined;
    }[];
    nextCursor: string | null;
    semantics: "reservation-is-not-dispatch-authority; failures-may-follow-external-effects; never-replay-on-read-or-restart";
};
