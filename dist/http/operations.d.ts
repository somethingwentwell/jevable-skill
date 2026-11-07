import { z } from 'zod';
import type { RuntimeOperationTarget } from './operation-host.ts';
declare const schema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    operation: z.ZodLiteral<"grants.issue">;
    command: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        scope: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"caller">;
            release: z.ZodObject<{
                id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
                sha256: z.ZodString;
                revision: z.ZodString;
            }, z.core.$strict>;
            permissions: z.ZodPipe<z.ZodArray<z.ZodEnum<{
                start: "start";
                read: "read";
                control: "control";
                cancel: "cancel";
            }>>, z.ZodTransform<("start" | "read" | "control" | "cancel")[], ("start" | "read" | "control" | "cancel")[]>>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"reviewer">;
            runId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
            attemptId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
            revision: z.ZodString;
            decisions: z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[], string[]>>;
        }, z.core.$strict>], "kind">;
        expiresAt: z.ZodISODateTime;
        tokenSha256: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"grants.show">;
    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"grants.list">;
    page: z.ZodObject<{
        after: z.ZodOptional<z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>>;
        limit: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"grants.revoke">;
    command: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        expectedGeneration: z.ZodLiteral<1>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"validate">;
    yaml: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"check">;
    yaml: z.ZodString;
    triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"templates.list">;
    language: z.ZodOptional<z.ZodEnum<{
        en: "en";
        zh: "zh";
    }>>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"templates.render">;
    id: z.ZodString;
    language: z.ZodOptional<z.ZodEnum<{
        en: "en";
        zh: "zh";
    }>>;
    name: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodObject<{
        provider: z.ZodString;
        model: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"import.preview">;
    source: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"projects.list">;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"projects.show">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"projects.command">;
    command: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"projects.diff">;
    id: z.ZodUUID;
    from: z.ZodString;
    to: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"projects.delete">;
    id: z.ZodUUID;
    expectedGeneration: z.ZodNumber;
    confirmId: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"projects.deletions">;
    page: z.ZodOptional<z.ZodObject<{
        after: z.ZodOptional<z.ZodUUID>;
        limit: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    history: z.ZodOptional<z.ZodBoolean>;
    tests: z.ZodOptional<z.ZodBoolean>;
    id: z.ZodUUID;
    expectedGeneration: z.ZodNumber;
    revision: z.ZodString;
    operation: z.ZodLiteral<"projects.export">;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"projects.import.inspect">;
    json: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"projects.import">;
    json: z.ZodString;
    reviewedSha256: z.ZodString;
    newId: z.ZodOptional<z.ZodUUID>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"projects.import.vendor">;
    command: z.ZodObject<{
        id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        source: z.ZodString;
        title: z.ZodString;
        yaml: z.ZodString;
        reviewedSourceSha256: z.ZodString;
        reviewedConversionSha256: z.ZodString;
        reviewedRevision: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"projects.import.vendor.show">;
    id: z.ZodUUID;
    inspect: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"releases.list">;
    page: z.ZodOptional<z.ZodObject<{
        after: z.ZodOptional<z.ZodUUID>;
        limit: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"releases.show">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"releases.create">;
    id: z.ZodUUID;
    projectId: z.ZodUUID;
    expectedGeneration: z.ZodNumber;
    revision: z.ZodString;
    version: z.ZodString;
    runtimeStorage: z.ZodEnum<{
        sqlite: "sqlite";
        postgres: "postgres";
    }>;
    runtime: z.ZodObject<{
        version: z.ZodString;
        sha256: z.ZodString;
    }, z.core.$strict>;
    runtimeRateCoordinator: z.ZodOptional<z.ZodLiteral<"postgres">>;
    notes: z.ZodOptional<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.start">;
    id: z.ZodUUID;
    yaml: z.ZodString;
    input: z.ZodJSONSchema;
    paused: z.ZodOptional<z.ZodBoolean>;
    triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
}, z.core.$strict>, z.ZodObject<{
    runId: z.ZodUUID;
    input: z.ZodJSONSchema;
    paused: z.ZodOptional<z.ZodBoolean>;
    triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
    id: z.ZodUUID;
    expectedGeneration: z.ZodNumber;
    revision: z.ZodString;
    operation: z.ZodLiteral<"projects.run">;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"tests.list">;
    page: z.ZodOptional<z.ZodObject<{
        after: z.ZodOptional<z.ZodUUID>;
        limit: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodUUID;
    triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
    project: z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
        revision: z.ZodString;
    }, z.core.$strict>;
    operation: z.ZodLiteral<"tests.generate">;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"tests.generations">;
    page: z.ZodOptional<z.ZodObject<{
        after: z.ZodOptional<z.ZodUUID>;
        limit: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"tests.generation">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"tests.show">;
    id: z.ZodUUID;
    generation: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"tests.history">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"tests.erasure-review">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"tests.erase">;
    request: z.ZodObject<{
        requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        test: z.ZodObject<{
            id: z.ZodUUID;
            generation: z.ZodNumber;
            sha256: z.ZodString;
        }, z.core.$strict>;
        reviewedHistorySha256: z.ZodString;
        confirmId: z.ZodUUID;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"tests.erasure">;
    requestId: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"tests.command">;
    command: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"tests.run">;
    test: z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
        sha256: z.ZodString;
    }, z.core.$strict>;
    runId: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"tests.result">;
    runId: z.ZodUUID;
    inspect: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.list">;
    page: z.ZodOptional<z.ZodObject<{
        after: z.ZodOptional<z.ZodUUID>;
        limit: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.show">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.inspect">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.events">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.export">;
    id: z.ZodUUID;
    includePrivate: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"usage.report">;
    selection: z.ZodUnknown;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"activity.report">;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.resume">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    requestId: z.ZodUUID;
    expectedCheckpointSha256: z.ZodString;
    mode: z.ZodEnum<{
        continue: "continue";
        step: "step";
        pause: "pause";
        recover: "recover";
    }>;
    breakpoints: z.ZodOptional<z.ZodArray<z.ZodString>>;
    operation: z.ZodLiteral<"runs.advance">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"runs.cancel">;
    id: z.ZodUUID;
    requestId: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"approvals.show">;
    id: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"approvals.list">;
    page: z.ZodObject<{
        after: z.ZodOptional<z.ZodUUID>;
        limit: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"approvals.decide">;
    id: z.ZodUUID;
    attemptId: z.ZodUUID;
    action: z.ZodString;
    pauseAfter: z.ZodOptional<z.ZodBoolean>;
    expireOnly: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.destinations">;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.automatic-status">;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.automatic-show">;
    requestId: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.automatic-list">;
    page: z.ZodObject<{
        after: z.ZodOptional<z.ZodUUID>;
        limit: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.prepare">;
    pin: z.ZodObject<{
        runId: z.ZodUUID;
        revision: z.ZodString;
        attemptId: z.ZodUUID;
        eventKind: z.ZodOptional<z.ZodEnum<{
            cancelled: "cancelled";
            expired: "expired";
            requested: "requested";
            decided: "decided";
        }>>;
    }, z.core.$strict>;
    endpointId: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.send">;
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
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.show">;
    requestId: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.abort">;
    requestId: z.ZodUUID;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.list">;
    page: z.ZodObject<{
        after: z.ZodOptional<z.ZodUUID>;
        limit: z.ZodDefault<z.ZodNumber>;
        filter: z.ZodOptional<z.ZodPipe<z.ZodObject<{
            outcome: z.ZodOptional<z.ZodEnum<{
                accepted: "accepted";
                pending: "pending";
                uncertain: "uncertain";
                rejected: "rejected";
            }>>;
            eventKind: z.ZodOptional<z.ZodEnum<{
                cancelled: "cancelled";
                expired: "expired";
                requested: "requested";
                decided: "decided";
            }>>;
            createdFrom: z.ZodOptional<z.ZodISODateTime>;
            createdBefore: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strict>, z.ZodTransform<{
            outcome?: "accepted" | "pending" | "uncertain" | "rejected" | undefined;
            eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
            createdFrom?: string | undefined;
            createdBefore?: string | undefined;
        }, {
            outcome?: "accepted" | "pending" | "uncertain" | "rejected" | undefined;
            eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
            createdFrom?: string | undefined;
            createdBefore?: string | undefined;
        }>>>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"notifications.project-list">;
    project: z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
        revision: z.ZodString;
    }, z.core.$strict>;
    page: z.ZodObject<{
        after: z.ZodOptional<z.ZodUUID>;
        limit: z.ZodDefault<z.ZodNumber>;
        filter: z.ZodOptional<z.ZodPipe<z.ZodObject<{
            outcome: z.ZodOptional<z.ZodEnum<{
                accepted: "accepted";
                pending: "pending";
                uncertain: "uncertain";
                rejected: "rejected";
            }>>;
            eventKind: z.ZodOptional<z.ZodEnum<{
                cancelled: "cancelled";
                expired: "expired";
                requested: "requested";
                decided: "decided";
            }>>;
            createdFrom: z.ZodOptional<z.ZodISODateTime>;
            createdBefore: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strict>, z.ZodTransform<{
            outcome?: "accepted" | "pending" | "uncertain" | "rejected" | undefined;
            eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
            createdFrom?: string | undefined;
            createdBefore?: string | undefined;
        }, {
            outcome?: "accepted" | "pending" | "uncertain" | "rejected" | undefined;
            eventKind?: "cancelled" | "expired" | "requested" | "decided" | undefined;
            createdFrom?: string | undefined;
            createdBefore?: string | undefined;
        }>>>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"providers.list">;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"providers.discover">;
    id: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"providers.audit">;
    page: z.ZodOptional<z.ZodObject<{
        after: z.ZodOptional<z.ZodString>;
        limit: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"telemetry.status">;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"telemetry.flush">;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"telemetry.probe">;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"providers.set">;
    connection: z.ZodUnknown;
    expectedGeneration: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"credentials.status">;
    ref: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"credentials.set">;
    ref: z.ZodString;
    value: z.ZodString;
    expectedGeneration: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"credentials.clear">;
    ref: z.ZodString;
    expectedGeneration: z.ZodNumber;
}, z.core.$strict>], "operation">;
export type RuntimeOperation = z.input<typeof schema>;
export { schema as runtimeOperationSchema };
/** Single-owner adapter: actor is fixed by the host, not accepted from request bodies. */
export declare function dispatchOperation(target: RuntimeOperationTarget, value: unknown, actor: string): Promise<unknown>;
