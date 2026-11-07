import { z } from 'zod';
import { type LocalRun } from './run-types.ts';
export declare const approvalPageSchema: z.ZodObject<{
    after: z.ZodOptional<z.ZodUUID>;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export type ApprovalPage = z.input<typeof approvalPageSchema>;
export interface ApprovalInboxHost {
    listRuns(page: z.output<typeof approvalPageSchema>): unknown | Promise<unknown>;
    showRun(id: string): LocalRun | Promise<LocalRun>;
}
export declare const APPROVAL_INBOX_LIMITS: Readonly<{
    runs: 200;
    readBytes: 64000000;
    reportBytes: 4000000;
}>;
/** One metadata page, then verified current reads of waiting candidates only. Never execute or settle expiry. */
export declare function createApprovalInbox(host: ApprovalInboxHost, value?: ApprovalPage): Promise<{
    schemaVersion: number;
    format: "jevable.ai/approval-inbox";
    tasks: {
        runId: string;
        revision: string;
        nodeId: string;
        attemptId: string;
        expiresAt: string;
        observedAt: string;
        observedRunUpdatedAt: string;
        cancellationRequested: boolean;
        expiry: "not-expired-at-observation" | "expired-at-observation";
        scope?: {
            loop: import("../index.ts").NodeId;
            index: number;
        } | undefined;
        loopExpiresAt?: string | undefined;
        loopExpiry?: "not-expired-at-observation" | "expired-at-observation" | undefined;
        project?: {
            id: string;
            generation: number;
        } | undefined;
        release?: {
            id: string;
            sha256: string;
        } | undefined;
        test?: {
            id: string;
            generation: number;
            sha256: string;
        } | undefined;
    }[];
    nextCursor: string | null;
    scannedRuns: number;
    changedCandidates: number;
    page: {
        limit: number;
        after?: string | undefined;
    };
    consistency: "live-run-keyset; not-a-snapshot; restart-scan-to-find-new-waits-behind-cursor";
    emptyPage: "follow-nextCursor-even-when-tasks-is-empty";
    authority: "listing-does-not-authorize-decisions; inspect-current-task-before-deciding";
    expiry: "observational-only; no-expired-wait-is-settled-by-listing";
    privacy: "review-payloads-titles-actions-actors-credentials-excluded; identifiers-retained";
    execution: "not-started-or-resumed";
}>;
export type ApprovalInbox = Awaited<ReturnType<typeof createApprovalInbox>>;
