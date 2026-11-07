import { z } from 'zod';
export declare const USAGE_REPORT_LIMITS: Readonly<{
    runs: 100;
    calls: 10000;
    groups: 1000;
    sourceBytes: 64000000;
    reportBytes: 16000000;
}>;
export interface UsageReportHost {
    exportRun(id: string, includePrivate: boolean): unknown | Promise<unknown>;
    /** Opt-in checked requested-provider/model projection; no private payloads or endpoint/credential routes. */
    exportUsageRun?(id: string): unknown | Promise<unknown>;
}
/** Shared consuming grammar, including strict run pins and usage-only refinements. */
export declare const usageSelectionSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    runs: z.ZodArray<z.ZodObject<{
        id: z.ZodUUID;
        revision: z.ZodString;
    }, z.core.$strict>>;
    window: z.ZodOptional<z.ZodObject<{
        from: z.ZodISODateTime;
        before: z.ZodISODateTime;
    }, z.core.$strict>>;
    groupBy: z.ZodOptional<z.ZodEnum<{
        provider: "provider";
        "provider-model": "provider-model";
    }>>;
}, z.core.$strict>;
/** Usage-only scope; evidence ZIP selections retain their original strict grammar. */
export declare function inspectUsageSelection(value: unknown): {
    selection: {
        groupBy?: "provider" | "provider-model";
        window?: {
            from: string;
            before: string;
        };
        schemaVersion: 1;
        runs: {
            id: string;
            revision: string;
        }[];
    };
    sha256: string;
};
export type UsageSelection = ReturnType<typeof inspectUsageSelection>['selection'];
/** Read only the explicit, revision-pinned selection. No enumeration, provider calls, pricing or private payload projection. */
export declare function createUsageReport(host: UsageReportHost, value: unknown): Promise<{
    summary: {
        inputTokens: {
            reportedTokens: string | null;
            reportingCalls: number;
            completedCallsWithoutField: number;
            coverage: "unavailable" | "complete-for-observed-intents" | "partial";
        };
        outputTokens: {
            reportedTokens: string | null;
            reportingCalls: number;
            completedCallsWithoutField: number;
            coverage: "unavailable" | "complete-for-observed-intents" | "partial";
        };
        modelIntents: number;
        unavailableHistories: number;
        unrecordedCalls: number;
        completedCalls: number;
        failedCalls: number;
        pendingCalls: number;
        recordedTries: number;
        failedOrPendingTries: number;
    };
    runs: {
        groups?: {
            key: {
                provider: string | null;
                model?: string | null;
            };
            summary: {
                inputTokens: {
                    reportedTokens: string | null;
                    reportingCalls: number;
                    completedCallsWithoutField: number;
                    coverage: "unavailable" | "complete-for-observed-intents" | "partial";
                };
                outputTokens: {
                    reportedTokens: string | null;
                    reportingCalls: number;
                    completedCallsWithoutField: number;
                    coverage: "unavailable" | "complete-for-observed-intents" | "partial";
                };
                modelIntents: number;
                unavailableHistories: number;
                unrecordedCalls: number;
                completedCalls: number;
                failedCalls: number;
                pendingCalls: number;
                recordedTries: number;
                failedOrPendingTries: number;
            };
            unlocatedModelIntents: number;
        }[];
        windowCoverage?: {
            observedModelIntents: number;
            outsideWindow: number;
            unlocatedModelIntents: number;
        };
        id: string;
        revision: string;
        workflowStatus: string;
        observedRunUpdatedAt: string;
        snapshotSha256: string;
        modelHistory: "unavailable" | "recorded";
        summary: {
            inputTokens: {
                reportedTokens: string | null;
                reportingCalls: number;
                completedCallsWithoutField: number;
                coverage: "unavailable" | "complete-for-observed-intents" | "partial";
            };
            outputTokens: {
                reportedTokens: string | null;
                reportingCalls: number;
                completedCallsWithoutField: number;
                coverage: "unavailable" | "complete-for-observed-intents" | "partial";
            };
            modelIntents: number;
            unavailableHistories: number;
            unrecordedCalls: number;
            completedCalls: number;
            failedCalls: number;
            pendingCalls: number;
            recordedTries: number;
            failedOrPendingTries: number;
        };
        calls: ({
            evidence: "not-recorded";
            recordedTries: null;
            inputTokens: null;
            outputTokens: null;
            usageIdentity?: {
                provider: string;
                model: string;
            } | null;
            intentAt?: string;
            scope?: {
                loop: string;
                index: number;
            };
            nodeId: string;
            attemptId: string;
        } | {
            evidence: "recorded";
            status: "completed" | "failed" | "pending";
            recordedTries: number;
            failedOrPendingTries: number;
            inputTokens: string | null;
            outputTokens: string | null;
            usageIdentity?: {
                provider: string;
                model: string;
            } | null;
            intentAt?: string;
            scope?: {
                loop: string;
                index: number;
            };
            nodeId: string;
            attemptId: string;
        })[];
    }[];
    groupBy?: "provider" | "provider-model";
    groupIdentity?: "verified-requested-provider-model; not-billing-or-provider-response-version";
    groups?: {
        key: {
            provider: string | null;
            model?: string | null;
        };
        summary: {
            inputTokens: {
                reportedTokens: string | null;
                reportingCalls: number;
                completedCallsWithoutField: number;
                coverage: "unavailable" | "complete-for-observed-intents" | "partial";
            };
            outputTokens: {
                reportedTokens: string | null;
                reportingCalls: number;
                completedCallsWithoutField: number;
                coverage: "unavailable" | "complete-for-observed-intents" | "partial";
            };
            modelIntents: number;
            unavailableHistories: number;
            unrecordedCalls: number;
            completedCalls: number;
            failedCalls: number;
            pendingCalls: number;
            recordedTries: number;
            failedOrPendingTries: number;
        };
        unlocatedModelIntents: number;
    }[];
    window?: {
        basis: "original-model-intent";
        bounds: "from-inclusive-before-exclusive";
        retryAllocation: "entire-call; not-per-try-or-prorated";
        from: string;
        before: string;
    };
    windowCoverage?: {
        observedModelIntents: number;
        outsideWindow: number;
        unlocatedModelIntents: number;
    };
    schemaVersion: number;
    format: "jevable.ai/usage-report";
    selectionSha256: string;
    source: "configured-model-store";
    consistency: "per-run-observations; not-an-atomic-snapshot";
    tokenEncoding: "decimal-integer-string";
    billing: "not-estimated; not-provider-account-totals";
    semantics: "intent-is-not-dispatch; successful-response-usage-counted-once; failed-tries-may-have-unreported-usage";
    privacy: "payloads-credentials-provider-routes-excluded; requested-provider-model-identities-opted-in; identifiers-retained" | "payloads-credentials-provider-routes-excluded; identifiers-retained";
    authenticity: "retained-evidence-checksums; not-independent-proof";
    execution: "not-started-or-resumed";
}>;
export type UsageReport = Awaited<ReturnType<typeof createUsageReport>>;
