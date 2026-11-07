import { z } from 'zod';
import { type GrantMetadata, type GrantPrincipal } from './grants.ts';
import type { GrantActionAdmission, GrantActionTarget } from './actions.ts';
import type { LocalRun } from '../runtime/run-types.ts';
export declare const reviewerDecisionRequestSchema: z.ZodObject<{
    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    action: z.ZodString;
    pauseAfter: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export type ReviewerDecisionRequest = z.input<typeof reviewerDecisionRequestSchema>;
/** Trusted host propagation runs only after live reviewer role/action authentication. Not HTTP input. */
export type ReviewerDecisionContext = (operation: () => Promise<ReviewerDecisionReceipt>) => Promise<ReviewerDecisionReceipt>;
export declare const reviewerBindingSchema: z.ZodObject<{
    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    scope: z.ZodObject<{
        kind: z.ZodLiteral<"reviewer">;
        runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        revision: z.ZodString;
        decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
    }, z.core.$strict>;
    deadline: z.ZodISODateTime;
    pauseAfter: z.ZodBoolean;
}, z.core.$strict>;
export type ReviewerDecisionBinding = z.infer<typeof reviewerBindingSchema>;
export declare const reviewerDecisionEvidenceSchema: z.ZodObject<{
    kind: z.ZodLiteral<"action">;
    action: z.ZodString;
    actor: z.ZodString;
    at: z.ZodISODateTime;
    delegation: z.ZodObject<{
        requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        grantId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        scope: z.ZodObject<{
            kind: z.ZodLiteral<"reviewer">;
            runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
            attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
            revision: z.ZodString;
            decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
        }, z.core.$strict>;
        deadline: z.ZodISODateTime;
        pauseAfter: z.ZodBoolean;
    }, z.core.$strict>;
}, z.core.$strict>;
export type ReviewerDecisionEvidence = z.infer<typeof reviewerDecisionEvidenceSchema>;
type Event = {
    kind: string;
    data: unknown;
};
/** PostgreSQL retains the decision request as the atomic journal batch identity as well. */
export declare function verifyReviewerBatchIdentity(kind: string, data: unknown, batchId: string): {
    kind: "action";
    action: string;
    actor: string;
    at: string;
    delegation: {
        requestId: string;
        grantId: string;
        scope: {
            kind: "reviewer";
            runId: string;
            attemptId: string;
            revision: string;
            decisions: string[];
        };
        deadline: string;
        pauseAfter: boolean;
    };
} | undefined;
/** Checked grant readers resolve these privately; no token or principal survives in run evidence. */
export declare function reviewerGrantIds(record: LocalRun, events: readonly Event[]): string[];
/** Historical consistency, not live authority. A privileged database writer can still rewrite every source. */
export declare function verifyReviewerDecisions(record: LocalRun, events: readonly Event[], grants?: readonly GrantMetadata[]): void;
/** Derive the only live target from retained evidence. Expiry-less legacy waits need an owner decision. */
export declare function reviewerTarget(record: LocalRun, events: readonly Event[]): GrantActionTarget;
export declare function reviewerDecision(admission: GrantActionAdmission, request: z.output<typeof reviewerDecisionRequestSchema>): ReviewerDecisionEvidence;
/** This is receipt observation only; callers must freshly authenticate the exact reviewer/action first. */
export declare function reviewerRetry(record: LocalRun, events: readonly Event[], principal: GrantPrincipal, request: z.output<typeof reviewerDecisionRequestSchema>): ReviewerDecisionReceipt | undefined;
export interface ReviewerDecisionReceipt {
    schemaVersion: 1;
    requestId: string;
    runId: string;
    attemptId: string;
    revision: string;
    action: string;
    at: string;
    pauseAfter: boolean;
    status: LocalRun['state']['status'];
}
export declare const reviewerDecisionReceiptSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    revision: z.ZodString;
    action: z.ZodString;
    at: z.ZodISODateTime;
    pauseAfter: z.ZodBoolean;
    status: z.ZodEnum<{
        cancelled: "cancelled";
        completed: "completed";
        paused: "paused";
        failed: "failed";
        waiting: "waiting";
        executing: "executing";
    }>;
}, z.core.$strict>;
export declare function reviewerReceipt(record: LocalRun, decision: ReviewerDecisionEvidence): ReviewerDecisionReceipt;
export {};
