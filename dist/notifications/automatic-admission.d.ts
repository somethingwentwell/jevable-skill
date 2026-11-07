import { z } from 'zod';
import { type ApprovalNotificationEvent, type NotificationRequest, type NotificationRecord } from './schema.ts';
import { type AutomaticApprovalPolicy } from './automatic-policy.ts';
export declare const automaticAdmissionLimits: z.ZodObject<{
    maxAdmissions: z.ZodNumber;
    maxEvents: z.ZodNumber;
}, z.core.$strict>;
export type AutomaticAdmissionLimits = z.infer<typeof automaticAdmissionLimits>;
export declare const automaticAdmissionPage: z.ZodObject<{
    after: z.ZodOptional<z.ZodUUID>;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export type AutomaticAdmissionPage = z.input<typeof automaticAdmissionPage>;
export declare const automaticFailureCode: z.ZodEnum<{
    "invalid-command": "invalid-command";
    "not-found": "not-found";
    conflict: "conflict";
    limit: "limit";
    busy: "busy";
    corrupt: "corrupt";
    closed: "closed";
    uncertain: "uncertain";
}>;
export type AutomaticFailureCode = z.infer<typeof automaticFailureCode>;
declare const admission: z.ZodObject<{
    format: z.ZodLiteral<"jevable.ai/automatic-approval-admission/v1">;
    policy: z.ZodUnknown;
    policySha256: z.ZodString;
    destinations: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        endpointSha256: z.ZodString;
    }, z.core.$strict>>;
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
    event: z.ZodObject<{
        specversion: z.ZodLiteral<"1.0">;
        id: z.ZodString;
        source: z.ZodLiteral<"urn:jevable:workflow-runtime">;
        type: z.ZodEnum<{
            "ai.jevable.approval.requested": "ai.jevable.approval.requested";
            "ai.jevable.approval.decided": "ai.jevable.approval.decided";
            "ai.jevable.approval.expired": "ai.jevable.approval.expired";
            "ai.jevable.approval.cancelled": "ai.jevable.approval.cancelled";
        }>;
        time: z.ZodISODateTime;
        datacontenttype: z.ZodLiteral<"application/json">;
        data: z.ZodObject<{
            runId: z.ZodUUID;
            revision: z.ZodString;
            attemptId: z.ZodUUID;
            nodeId: z.ZodString;
            expiresAt: z.ZodISODateTime;
            scope: z.ZodOptional<z.ZodObject<{
                loop: z.ZodPipe<z.ZodString, z.ZodTransform<import("../index.ts").NodeId, string>>;
                index: z.ZodNumber;
            }, z.core.$strict>>;
            loopExpiresAt: z.ZodOptional<z.ZodISODateTime>;
            release: z.ZodOptional<z.ZodObject<{
                id: z.ZodUUID;
                sha256: z.ZodString;
            }, z.core.$strict>>;
            project: z.ZodOptional<z.ZodObject<{
                id: z.ZodUUID;
                generation: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>;
    }, z.core.$strict>;
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
}, z.core.$strict>;
export type AutomaticAdmissionRecord = Omit<z.infer<typeof admission>, 'policy'> & {
    policy: AutomaticApprovalPolicy;
};
export declare const automaticAdmissionSemantics: "reservation-is-not-dispatch-authority; failures-may-follow-external-effects; never-replay-on-read-or-restart";
/** Validate serialized, private-value-free provenance and the exact deterministic request. No delivery or credentials. */
export declare function inspectAutomaticAdmission(value: unknown): AutomaticAdmissionRecord;
/** Source-only producer. A reservation is not permission to send; the owner must separately validate journal history. */
export declare function prepareAutomaticAdmission(policyValue: unknown, event: ApprovalNotificationEvent, destinationsValue: unknown, request: NotificationRequest, createdAt: string, failure?: AutomaticFailureCode): AutomaticAdmissionRecord;
export declare function sameAutomaticAdmissionIdentity(a: AutomaticAdmissionRecord, b: AutomaticAdmissionRecord): boolean;
export declare function validateAutomaticAdmissionCreation(value: unknown, previousValue?: unknown): {
    record: AutomaticAdmissionRecord;
    changed: boolean;
};
export declare function validateAutomaticAdmissionSettlement(previousValue: unknown, value: unknown): {
    record: AutomaticAdmissionRecord;
    changed: boolean;
};
/** Join actual retained dispatcher evidence; HTTP success is not human delivery or approval. */
export declare function verifyAutomaticAdmissionDelivery(record: AutomaticAdmissionRecord, value: unknown): void;
export declare function automaticDeliveryRecorded(recordValue: unknown, deliveryValue: NotificationRecord, at: string): AutomaticAdmissionRecord;
export declare function automaticAdmissionFailed(recordValue: unknown, code: AutomaticFailureCode, at: string): AutomaticAdmissionRecord;
export declare function parseAutomaticAdmissionPage(value: AutomaticAdmissionPage): {
    limit: number;
    after?: string | undefined;
};
export {};
