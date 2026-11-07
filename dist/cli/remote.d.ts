import { z } from 'zod';
import { RuntimeClient } from '../http/client.ts';
import { type CliValues } from './runtime.ts';
/** Validate explicit remote selection before credentials, storage or network access. */
export declare function remoteSelection(values: CliValues): void;
/** Read-only handshake, then pin every operation to that instance. No discovery or retry. */
export declare function connectRemoteOperations(values: CliValues): Promise<{
    client: RuntimeClient<{
        operation: "grants.issue";
        command: {
            id: string;
            scope: {
                kind: "caller";
                release: {
                    id: string;
                    sha256: string;
                    revision: string;
                };
                permissions: ("start" | "read" | "control" | "cancel")[];
            } | {
                kind: "reviewer";
                runId: string;
                attemptId: string;
                revision: string;
                decisions: string[];
            };
            expiresAt: string;
            tokenSha256: string;
        };
    } | {
        operation: "grants.show";
        id: string;
    } | {
        operation: "grants.list";
        page: {
            after?: string | undefined;
            limit?: number | undefined;
        };
    } | {
        operation: "grants.revoke";
        command: {
            id: string;
            requestId: string;
            expectedGeneration: 1;
        };
    } | {
        operation: "validate";
        yaml: string;
    } | {
        operation: "check";
        yaml: string;
        triggerMode?: "api" | undefined;
    } | {
        operation: "templates.list";
        language?: "en" | "zh" | undefined;
    } | {
        operation: "templates.render";
        id: string;
        language?: "en" | "zh" | undefined;
        name?: string | undefined;
        model?: {
            provider: string;
            model: string;
        } | undefined;
    } | {
        operation: "import.preview";
        source: string;
    } | {
        operation: "projects.list";
    } | {
        operation: "projects.show";
        id: string;
    } | {
        operation: "projects.command";
        command: Record<string, unknown>;
    } | {
        operation: "projects.diff";
        id: string;
        from: string;
        to: string;
    } | {
        operation: "projects.delete";
        id: string;
        expectedGeneration: number;
        confirmId: string;
    } | {
        operation: "projects.deletions";
        page?: {
            after?: string | undefined;
            limit?: number | undefined;
        } | undefined;
    } | {
        id: string;
        expectedGeneration: number;
        revision: string;
        operation: "projects.export";
        history?: boolean | undefined;
        tests?: boolean | undefined;
    } | {
        operation: "projects.import.inspect";
        json: string;
    } | {
        operation: "projects.import";
        json: string;
        reviewedSha256: string;
        newId?: string | undefined;
    } | {
        operation: "projects.import.vendor";
        command: {
            id: string;
            source: string;
            title: string;
            yaml: string;
            reviewedSourceSha256: string;
            reviewedConversionSha256: string;
            reviewedRevision: string;
        };
    } | {
        operation: "projects.import.vendor.show";
        id: string;
        inspect?: boolean | undefined;
    } | {
        operation: "releases.list";
        page?: {
            after?: string | undefined;
            limit?: number | undefined;
        } | undefined;
    } | {
        operation: "releases.show";
        id: string;
    } | {
        operation: "releases.create";
        id: string;
        projectId: string;
        expectedGeneration: number;
        revision: string;
        version: string;
        runtimeStorage: "sqlite" | "postgres";
        runtime: {
            version: string;
            sha256: string;
        };
        runtimeRateCoordinator?: "postgres" | undefined;
        notes?: string | undefined;
    } | {
        operation: "runs.start";
        id: string;
        yaml: string;
        input: z.core.util.JSONType;
        paused?: boolean | undefined;
        triggerMode?: "api" | undefined;
    } | {
        runId: string;
        input: z.core.util.JSONType;
        id: string;
        expectedGeneration: number;
        revision: string;
        operation: "projects.run";
        paused?: boolean | undefined;
        triggerMode?: "api" | undefined;
    } | {
        operation: "tests.list";
        page?: {
            after?: string | undefined;
            limit?: number | undefined;
        } | undefined;
    } | {
        id: string;
        project: {
            id: string;
            generation: number;
            revision: string;
        };
        operation: "tests.generate";
        triggerMode?: "api" | undefined;
        limit?: number | undefined;
    } | {
        operation: "tests.generations";
        page?: {
            after?: string | undefined;
            limit?: number | undefined;
        } | undefined;
    } | {
        operation: "tests.generation";
        id: string;
    } | {
        operation: "tests.show";
        id: string;
        generation?: number | undefined;
    } | {
        operation: "tests.history";
        id: string;
    } | {
        operation: "tests.erasure-review";
        id: string;
    } | {
        operation: "tests.erase";
        request: {
            requestId: string;
            test: {
                id: string;
                generation: number;
                sha256: string;
            };
            reviewedHistorySha256: string;
            confirmId: string;
        };
    } | {
        operation: "tests.erasure";
        requestId: string;
    } | {
        operation: "tests.command";
        command: Record<string, unknown>;
    } | {
        operation: "tests.run";
        test: {
            id: string;
            generation: number;
            sha256: string;
        };
        runId: string;
    } | {
        operation: "tests.result";
        runId: string;
        inspect?: boolean | undefined;
    } | {
        operation: "runs.list";
        page?: {
            after?: string | undefined;
            limit?: number | undefined;
        } | undefined;
    } | {
        operation: "runs.show";
        id: string;
    } | {
        operation: "runs.inspect";
        id: string;
    } | {
        operation: "runs.events";
        id: string;
    } | {
        operation: "runs.export";
        id: string;
        includePrivate?: boolean | undefined;
    } | {
        operation: "usage.report";
        selection: unknown;
    } | {
        operation: "activity.report";
    } | {
        operation: "runs.resume";
        id: string;
    } | {
        requestId: string;
        expectedCheckpointSha256: string;
        mode: "continue" | "step" | "pause" | "recover";
        operation: "runs.advance";
        id: string;
        breakpoints?: string[] | undefined;
    } | {
        operation: "runs.cancel";
        id: string;
        requestId: string;
    } | {
        operation: "approvals.show";
        id: string;
    } | {
        operation: "approvals.list";
        page: {
            after?: string | undefined;
            limit?: number | undefined;
        };
    } | {
        operation: "approvals.decide";
        id: string;
        attemptId: string;
        action: string;
        pauseAfter?: boolean | undefined;
        expireOnly?: boolean | undefined;
    } | {
        operation: "notifications.destinations";
    } | {
        operation: "notifications.automatic-status";
    } | {
        operation: "notifications.automatic-show";
        requestId: string;
    } | {
        operation: "notifications.automatic-list";
        page: {
            after?: string | undefined;
            limit?: number | undefined;
        };
    } | {
        operation: "notifications.prepare";
        pin: {
            runId: string;
            revision: string;
            attemptId: string;
            eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
        };
        endpointId: string;
    } | {
        operation: "notifications.send";
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
    } | {
        operation: "notifications.show";
        requestId: string;
    } | {
        operation: "notifications.abort";
        requestId: string;
    } | {
        operation: "notifications.list";
        page: {
            after?: string | undefined;
            limit?: number | undefined;
            filter?: {
                outcome?: "accepted" | "pending" | "uncertain" | "rejected" | undefined;
                eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
                createdFrom?: string | undefined;
                createdBefore?: string | undefined;
            } | undefined;
        };
    } | {
        operation: "notifications.project-list";
        project: {
            id: string;
            generation: number;
            revision: string;
        };
        page: {
            after?: string | undefined;
            limit?: number | undefined;
            filter?: {
                outcome?: "accepted" | "pending" | "uncertain" | "rejected" | undefined;
                eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
                createdFrom?: string | undefined;
                createdBefore?: string | undefined;
            } | undefined;
        };
    } | {
        operation: "providers.list";
    } | {
        operation: "providers.discover";
        id: string;
    } | {
        operation: "providers.audit";
        page?: {
            after?: string | undefined;
            limit?: number | undefined;
        } | undefined;
    } | {
        operation: "telemetry.status";
    } | {
        operation: "telemetry.flush";
    } | {
        operation: "telemetry.probe";
    } | {
        operation: "providers.set";
        connection: unknown;
        expectedGeneration: number;
    } | {
        operation: "credentials.status";
        ref: string;
    } | {
        operation: "credentials.set";
        ref: string;
        value: string;
        expectedGeneration: number;
    } | {
        operation: "credentials.clear";
        ref: string;
        expectedGeneration: number;
    }>;
    instanceId: string;
    storage: "sqlite" | "postgres";
}>;
