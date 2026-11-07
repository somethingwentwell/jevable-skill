import { z } from 'zod';
import { type PostgresJournalOptions } from './postgres-config.ts';
export { parsePostgresConfiguration } from './postgres-config.ts';
export type { PostgresJournalOptions } from './postgres-config.ts';
import { type JournalTransactionObserver } from './transaction-observation.ts';
import { type JournalConditions } from './conditions.ts';
export { JournalError } from './errors.ts';
declare const collection: z.ZodEnum<{
    projects: "projects";
    runs: "runs";
    releases: "releases";
    "access-grants": "access-grants";
    "project-deletions": "project-deletions";
    "release-versions": "release-versions";
    "test-cases": "test-cases";
    "test-generations": "test-generations";
    "provider-connections": "provider-connections";
    "provider-credentials": "provider-credentials";
    "model-calls": "model-calls";
    "approval-deliveries": "approval-deliveries";
    "approval-delivery-subjects": "approval-delivery-subjects";
    "test-erasures": "test-erasures";
    "test-erasure-subjects": "test-erasure-subjects";
    "approval-automatic-admissions": "approval-automatic-admissions";
}>;
export type JournalCollection = z.infer<typeof collection>;
declare const batchSchema: z.ZodObject<{
    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    changes: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        operation: z.ZodLiteral<"put">;
        collection: z.ZodEnum<{
            projects: "projects";
            runs: "runs";
            releases: "releases";
            "access-grants": "access-grants";
            "project-deletions": "project-deletions";
            "release-versions": "release-versions";
            "test-cases": "test-cases";
            "test-generations": "test-generations";
            "provider-connections": "provider-connections";
            "provider-credentials": "provider-credentials";
            "model-calls": "model-calls";
            "approval-deliveries": "approval-deliveries";
            "approval-delivery-subjects": "approval-delivery-subjects";
            "test-erasures": "test-erasures";
            "test-erasure-subjects": "test-erasure-subjects";
            "approval-automatic-admissions": "approval-automatic-admissions";
        }>;
        key: z.ZodString;
        expectedVersion: z.ZodString;
        value: z.ZodJSONSchema;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"delete">;
        collection: z.ZodEnum<{
            projects: "projects";
            runs: "runs";
            releases: "releases";
            "access-grants": "access-grants";
            "project-deletions": "project-deletions";
            "release-versions": "release-versions";
            "test-cases": "test-cases";
            "test-generations": "test-generations";
            "provider-connections": "provider-connections";
            "provider-credentials": "provider-credentials";
            "model-calls": "model-calls";
            "approval-deliveries": "approval-deliveries";
            "approval-delivery-subjects": "approval-delivery-subjects";
            "test-erasures": "test-erasures";
            "test-erasure-subjects": "test-erasure-subjects";
            "approval-automatic-admissions": "approval-automatic-admissions";
        }>;
        key: z.ZodString;
        expectedVersion: z.ZodString;
    }, z.core.$strict>], "operation">>;
    events: z.ZodArray<z.ZodObject<{
        collection: z.ZodEnum<{
            projects: "projects";
            runs: "runs";
            releases: "releases";
            "access-grants": "access-grants";
            "project-deletions": "project-deletions";
            "release-versions": "release-versions";
            "test-cases": "test-cases";
            "test-generations": "test-generations";
            "provider-connections": "provider-connections";
            "provider-credentials": "provider-credentials";
            "model-calls": "model-calls";
            "approval-deliveries": "approval-deliveries";
            "approval-delivery-subjects": "approval-delivery-subjects";
            "test-erasures": "test-erasures";
            "test-erasure-subjects": "test-erasure-subjects";
            "approval-automatic-admissions": "approval-automatic-admissions";
        }>;
        key: z.ZodString;
        kind: z.ZodString;
        data: z.ZodJSONSchema;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type JournalBatch = z.infer<typeof batchSchema>;
declare const receiptSchema: z.ZodObject<{
    id: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    requestSha256: z.ZodString;
    ownerId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    epoch: z.ZodString;
    recordedAt: z.ZodString;
    changes: z.ZodArray<z.ZodObject<{
        collection: z.ZodEnum<{
            projects: "projects";
            runs: "runs";
            releases: "releases";
            "access-grants": "access-grants";
            "project-deletions": "project-deletions";
            "release-versions": "release-versions";
            "test-cases": "test-cases";
            "test-generations": "test-generations";
            "provider-connections": "provider-connections";
            "provider-credentials": "provider-credentials";
            "model-calls": "model-calls";
            "approval-deliveries": "approval-deliveries";
            "approval-delivery-subjects": "approval-delivery-subjects";
            "test-erasures": "test-erasures";
            "test-erasure-subjects": "test-erasure-subjects";
            "approval-automatic-admissions": "approval-automatic-admissions";
        }>;
        key: z.ZodString;
        version: z.ZodString;
        deleted: z.ZodBoolean;
    }, z.core.$strict>>;
    eventSequences: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export type JournalReceipt = z.infer<typeof receiptSchema>;
/** Low-level namespace journal; typed adapters and runtime hosts own domain validation and execution. */
export declare class PostgresJournal {
    private readonly client;
    private readonly options;
    readonly ownerId: `${string}-${string}-${string}-${string}-${string}`;
    private epoch;
    private state;
    private tail;
    private readonly occupancy;
    private transactions;
    private transactionObserver;
    private readonly transactionObservationSuppression;
    private closing;
    private ending;
    private readonly abort;
    private constructor();
    get signal(): AbortSignal;
    status(): {
        state: "closed" | "open" | "closing" | "opening" | "lost";
        namespace: string;
        ownerId: `${string}-${string}-${string}-${string}-${string}`;
        epoch: string;
    };
    /** Memory-only transaction occupancy. Availability is decided by the owning runtime, not these counts. */
    queueOccupancy(): {
        waiting: number;
        active: number;
    };
    /** Explicit diagnostics only: enabling/snapshotting never performs SQL or replays earlier transactions. */
    enableTransactionMetrics(): void;
    transactionMetrics(): import("./transaction-statistics.ts").TransactionMetricSnapshot;
    /** Explicit host diagnostics only. Configure while idle; never reconstruct prior transactions. */
    setTransactionObserver(observer: JournalTransactionObserver | undefined): void;
    /** Request-local suppression for diagnostic exporter credential reads; real SQL/statistics remain unchanged. */
    withTransactionObservationsSuppressed<T>(work: () => T): T;
    /** Explicit endpoint/credentials, no connection string, ambient PG configuration, pooling or automatic reconnect. */
    static open(value: PostgresJournalOptions): Promise<PostgresJournal>;
    private lose;
    private parseJson;
    private admit;
    private enqueue;
    private identity;
    get(kind: JournalCollection, id: string): Promise<{
        collection: "projects" | "runs" | "releases" | "access-grants" | "project-deletions" | "release-versions" | "test-cases" | "test-generations" | "provider-connections" | "provider-credentials" | "model-calls" | "approval-deliveries" | "approval-delivery-subjects" | "test-erasures" | "test-erasure-subjects" | "approval-automatic-admissions";
        key: string;
        version: string;
        deleted: boolean;
        value: unknown;
    } | undefined>;
    /** Identity existence only; never decodes the retained payload. */
    exists(kind: JournalCollection, id: string): Promise<boolean>;
    /** Internal case UUID guard; includes tombstones and normalized removal bindings without reading private payloads. */
    testCaseIdentity(id: string): Promise<{
        retained: boolean;
        live: boolean;
    }>;
    /** Internal exact caller selector. Filter in SQL before loading private run bytes, in one owner transaction. */
    callerRun(value: {
        id: string;
        grantId: string;
        release: {
            id: string;
            sha256: string;
            revision: string;
        };
    }): Promise<{
        collection: "projects" | "runs" | "releases" | "access-grants" | "project-deletions" | "release-versions" | "test-cases" | "test-generations" | "provider-connections" | "provider-credentials" | "model-calls" | "approval-deliveries" | "approval-delivery-subjects" | "test-erasures" | "test-erasure-subjects" | "approval-automatic-admissions";
        key: string;
        version: string;
        deleted: boolean;
        value: unknown;
    } | undefined>;
    private readRecord;
    /** Count live records without loading private payloads, for domain capacity guards under the shared owner gate. */
    count(kind: JournalCollection): Promise<number>;
    /** One bounded, complete collection snapshot; never silently truncate it. */
    records(kind: JournalCollection, limit?: number): Promise<{
        collection: "projects" | "runs" | "releases" | "access-grants" | "project-deletions" | "release-versions" | "test-cases" | "test-generations" | "provider-connections" | "provider-credentials" | "model-calls" | "approval-deliveries" | "approval-delivery-subjects" | "test-erasures" | "test-erasure-subjects" | "approval-automatic-admissions";
        key: string;
        version: string;
        deleted: boolean;
        value: unknown;
    }[]>;
    /** Keyset page of live records. Each page is a transaction, not a cross-page snapshot. */
    page(kind: JournalCollection, after?: string, limit?: number): Promise<{
        records: {
            collection: "projects" | "runs" | "releases" | "access-grants" | "project-deletions" | "release-versions" | "test-cases" | "test-generations" | "provider-connections" | "provider-credentials" | "model-calls" | "approval-deliveries" | "approval-delivery-subjects" | "test-erasures" | "test-erasure-subjects" | "approval-automatic-admissions";
            key: string;
            version: string;
            deleted: boolean;
            value: unknown;
        }[];
        nextCursor: string | null;
    }>;
    private readRows;
    receipt(id: string): Promise<{
        id: string;
        requestSha256: string;
        ownerId: string;
        epoch: string;
        recordedAt: string;
        changes: {
            collection: "projects" | "runs" | "releases" | "access-grants" | "project-deletions" | "release-versions" | "test-cases" | "test-generations" | "provider-connections" | "provider-credentials" | "model-calls" | "approval-deliveries" | "approval-delivery-subjects" | "test-erasures" | "test-erasure-subjects" | "approval-automatic-admissions";
            key: string;
            version: string;
            deleted: boolean;
        }[];
        eventSequences: string[];
    } | undefined>;
    private readReceipt;
    /** A stable batch UUID identifies one atomic mutation set plus its evidence, not an external-effect retry. */
    commit(value: JournalBatch, guard?: JournalConditions): Promise<JournalReceipt>;
    events(after?: string, limit?: number, kinds?: JournalCollection[], recordKey?: string): Promise<{
        events: {
            sequence: string;
            batchId: string;
            collection: JournalCollection;
            key: string;
            kind: string;
            epoch: string;
            at: string;
            data: unknown;
        }[];
        cursor: string;
    }>;
    health(): Promise<{
        database: "reachable";
        state: "closed" | "open" | "closing" | "opening" | "lost";
        namespace: string;
        ownerId: `${string}-${string}-${string}-${string}-${string}`;
        epoch: string;
    }>;
    /** Drain already admitted transactions, then release ownership by ending this exact connection. */
    close(): Promise<void>;
}
