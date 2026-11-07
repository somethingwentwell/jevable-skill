import type { LocalRuntime } from '../runtime/local.ts';
import type { PostgresRuntime } from '../runtime/postgres.ts';
type Operations = 'activityReport' | 'check' | 'projects' | 'project' | 'editProject' | 'diffProject' | 'deleteProject' | 'grant' | 'grants' | 'issueGrant' | 'revokeGrant' | 'createVendorImport' | 'vendorImport' | 'projectDeletions' | 'exportProject' | 'inspectProjectImport' | 'importProject' | 'run' | 'runProject' | 'testCases' | 'generateTests' | 'testGenerations' | 'testGeneration' | 'testCase' | 'testHistory' | 'editTest' | 'eraseTest' | 'testErasure' | 'runTest' | 'testResult' | 'list' | 'show' | 'exportRun' | 'events' | 'resume' | 'advance' | 'cancel' | 'decide' | 'connections' | 'discoverModels' | 'providerAudit' | 'telemetryStatus' | 'telemetryFlush' | 'telemetryProbe' | 'configureConnection' | 'credentialStatus' | 'setCredential' | 'clearCredential' | 'releases' | 'release' | 'createRelease' | 'notificationDestinations' | 'prepareApprovalNotification' | 'sendApprovalNotification' | 'inspectApprovalNotification' | 'listApprovalNotifications' | 'listProjectApprovalNotifications' | 'abortApprovalNotification' | 'automaticApprovalNotificationStatus' | 'automaticApprovalAdmissions' | 'automaticApprovalAdmission';
type AwaitableMethods<T> = {
    [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => R | Promise<Awaited<R>> : never;
};
/** Only operation methods cross this boundary. No concrete backend is imported at runtime. */
export type RuntimeOperationTarget = {
    storage: 'sqlite';
    runtime: AwaitableMethods<Pick<LocalRuntime, Operations | 'listPage'>>;
} | {
    storage: 'postgres';
    runtime: Pick<PostgresRuntime, Operations>;
};
export declare function operationCapabilities(storage: RuntimeOperationTarget['storage'], automaticDelivery?: boolean): {
    readonly storage: "sqlite" | "postgres";
    readonly delegatedGrants: {
        readonly operations: readonly ["grants.issue", "grants.show", "grants.list", "grants.revoke"];
        readonly administration: "management-owner-only";
        readonly scopes: readonly ["exact-release-caller", "exact-run-attempt-reviewer"];
        readonly tokens: "client-prepared; digest-only-issuance";
        readonly catalogue: "metadata-only; explicit-live-keyset-pages";
        readonly delegatedHttpAuthentication: false;
        readonly delegatedExecution: false;
        readonly transfer: false;
        readonly authority: "owner-administration-only; caller-and-reviewer-separate-opt-in-routes";
    };
    readonly collectorProbe: {
        readonly operation: "telemetry.probe";
        readonly explicit: true;
        readonly destinations: "configured-startup-only";
        readonly recordsPerSignal: 1;
        readonly concurrentProbes: 1;
        readonly workflowExecution: false;
        readonly retries: false;
        readonly sampling: "explicit-synthetic; independent-of-workflow-sampling";
        readonly durableReceipt: false;
        readonly result: "collector-response-only; not-backend-storage-or-dashboard";
    };
    readonly activity: {
        readonly operation: "activity.report";
        readonly scope: "selected-owner-retained-data";
        readonly coherent: true;
        readonly accountTotals: false;
        readonly lifetimeTotals: false;
        readonly billing: false;
        readonly execution: false;
        readonly firstRun: "earliest-retained-creation-time; UUID-tie-break; current-recorded-status";
        readonly importedHistory: "distinct-from-local-actions";
    };
    readonly testLifecycle: {
        readonly command: "tests.command";
        readonly operation: "archive";
        readonly reversible: true;
        readonly newRunAdmission: "active-cases-only";
        readonly historyAndResults: "retained";
        readonly listing: "all-with-optional-lifecycle-metadata";
        readonly erasure: {
            readonly operations: readonly ["tests.erasure-review", "tests.erase", "tests.erasure"];
            readonly authority: "management-owner-only";
            readonly scope: "archived-manual-never-accepted-draft; unreferenced-only";
            readonly review: "pins-only; references-not-discovered";
            readonly retry: "observe-original-receipt";
            readonly actor: "host-fixed";
            readonly securePhysicalErasure: false;
        };
    };
    readonly vendorImport: {
        readonly operations: readonly ["import.preview", "projects.import.vendor", "projects.import.vendor.show"];
        readonly creation: "atomic-project-and-private-origin; caller-retained-project-id";
        readonly review: readonly ["source", "conversion", "draft"];
        readonly inspect: "explicit-private-opt-in";
        readonly projectTransfer: "origin-excluded";
        readonly execution: false;
    };
    readonly modelDiscovery: {
        readonly operation: "providers.discover";
        readonly protocols: readonly ["openai-compatible"];
        readonly automatic: false;
        readonly permissionMutation: false;
        readonly maxModels: 1000;
        readonly maxTimeoutSeconds: 30;
        readonly redirects: false;
        readonly retries: false;
    };
    readonly releases: {
        readonly operations: readonly ["releases.list", "releases.show", "releases.create"];
        readonly createRuntimeGuard: "installed-bundle-version-and-sha256";
        readonly packaging: "client-side";
        readonly deployment: false;
        readonly notes: {
            readonly optional: true;
            readonly immutable: true;
            readonly includedInReleaseHash: true;
            readonly maxUtf8Bytes: 16384;
            readonly exportVisibility: "release-metadata";
            readonly executionAuthority: false;
        };
    };
    readonly runEvidenceSchemaVersion: 1 | 2;
    readonly usage: {
        readonly operation: "usage.report";
        readonly selection: "explicit-run-ids-and-revisions";
        readonly maxRuns: 100;
        readonly billing: false;
        readonly grouping: readonly ["provider", "provider-model"];
        readonly maxGroups: 1000;
        readonly identities: "explicit-opt-in; verified-requested-model; no-account-totals";
        readonly window: "optional-paired-UTC-millisecond-from-inclusive-before-exclusive; original-model-intent; no-discovery";
    };
    readonly approvalInbox: {
        readonly operation: "approvals.list";
        readonly paginationRequired: true;
        readonly scope: "one-live-run-page";
        readonly automaticExpiry: false;
    };
    readonly approvalNotifications: {
        readonly available: true;
        readonly eventKinds: readonly ["requested", "decided", "expired", "cancelled"];
        readonly operations: readonly ["notifications.destinations", "notifications.prepare", "notifications.send", "notifications.show", "notifications.list", "notifications.project-list", "notifications.abort", "notifications.automatic-status", "notifications.automatic-show", "notifications.automatic-list"];
        readonly automaticDiagnostics: {
            readonly readOnly: true;
            readonly paginationRequired: true;
            readonly maxLimit: 200;
            readonly policyBody: false;
            readonly replay: false;
        };
        readonly history: {
            readonly operation: "notifications.list";
            readonly paginationRequired: true;
            readonly maxLimit: 200;
            readonly order: "request-id-ascending";
            readonly consistency: "live-keyset; not-a-snapshot";
        };
        readonly projectHistory: {
            readonly operation: "notifications.project-list";
            readonly scope: "exact-historical-project-id-generation-revision";
            readonly paginationRequired: true;
            readonly maxLimit: 200;
            readonly cursor: "matching-delivery-only";
            readonly automaticDelivery: false;
        };
        readonly scope: "management-owner";
        readonly configuration: "operator-startup-only";
        readonly automaticDelivery: boolean;
        readonly disconnect: "admitted-send-continues; inspect-retained-request-id";
        readonly redelivery: "explicit-new-id-and-latest-predecessor";
    };
    readonly journalSequenceEncoding: "decimal-int64" | "safe-integer";
    readonly pagination: {
        readonly schemaVersion: 2;
        readonly defaultLimit: 100;
        readonly maxLimit: 200;
        readonly operations: readonly ["runs.list", "tests.list", "tests.generations", "projects.deletions", "providers.audit", "releases.list"];
        readonly required: boolean;
        readonly recordOrder: "id-ascending";
        readonly auditOrder: "sequence-ascending";
        readonly consistency: "live-keyset; not-a-snapshot";
    };
};
export {};
