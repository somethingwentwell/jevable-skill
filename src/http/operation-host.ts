import type { LocalRuntime } from '../runtime/local.ts'
import type { PostgresRuntime } from '../runtime/postgres.ts'
import { RELEASE_NOTES_MAX_BYTES } from '../releases/snapshot.ts'

type Operations = 'activityReport' | 'check' | 'projects' | 'project' | 'editProject' | 'diffProject' | 'deleteProject'
  | 'grant' | 'grants' | 'issueGrant' | 'revokeGrant'
  | 'createVendorImport' | 'vendorImport'
  | 'projectDeletions' | 'exportProject' | 'inspectProjectImport' | 'importProject' | 'run' | 'runProject'
  | 'testCases' | 'generateTests' | 'testGenerations' | 'testGeneration' | 'testCase' | 'testHistory'
  | 'editTest' | 'eraseTest' | 'testErasure' | 'runTest' | 'testResult' | 'list' | 'show' | 'exportRun' | 'events' | 'resume'
  | 'advance' | 'cancel' | 'decide' | 'connections' | 'discoverModels' | 'providerAudit' | 'telemetryStatus'
  | 'telemetryFlush' | 'telemetryProbe' | 'configureConnection' | 'credentialStatus' | 'setCredential' | 'clearCredential'
  | 'releases' | 'release' | 'createRelease'
  | 'notificationDestinations' | 'prepareApprovalNotification' | 'sendApprovalNotification' | 'inspectApprovalNotification'
  | 'listApprovalNotifications' | 'listProjectApprovalNotifications' | 'abortApprovalNotification'
  | 'automaticApprovalNotificationStatus' | 'automaticApprovalAdmissions' | 'automaticApprovalAdmission'

type AwaitableMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => R | Promise<Awaited<R>> : never
}

/** Only operation methods cross this boundary. No concrete backend is imported at runtime. */
export type RuntimeOperationTarget =
  | { storage: 'sqlite'; runtime: AwaitableMethods<Pick<LocalRuntime, Operations | 'listPage'>> }
  | { storage: 'postgres'; runtime: Pick<PostgresRuntime, Operations> }

export function operationCapabilities(storage: RuntimeOperationTarget['storage'], automaticDelivery = false) {
  return {
    storage,
    delegatedGrants: { operations: ['grants.issue', 'grants.show', 'grants.list', 'grants.revoke'], administration: 'management-owner-only',
      scopes: ['exact-release-caller', 'exact-run-attempt-reviewer'], tokens: 'client-prepared; digest-only-issuance',
      catalogue: 'metadata-only; explicit-live-keyset-pages', delegatedHttpAuthentication: false, delegatedExecution: false,
      transfer: false, authority: 'owner-administration-only; caller-and-reviewer-separate-opt-in-routes' },
    collectorProbe: { operation: 'telemetry.probe', explicit: true, destinations: 'configured-startup-only',
      recordsPerSignal: 1, concurrentProbes: 1, workflowExecution: false, retries: false,
      sampling: 'explicit-synthetic; independent-of-workflow-sampling', durableReceipt: false,
      result: 'collector-response-only; not-backend-storage-or-dashboard' },
    activity: { operation: 'activity.report', scope: 'selected-owner-retained-data', coherent: true,
      accountTotals: false, lifetimeTotals: false, billing: false, execution: false,
      firstRun: 'earliest-retained-creation-time; UUID-tie-break; current-recorded-status', importedHistory: 'distinct-from-local-actions' },
    testLifecycle: { command: 'tests.command', operation: 'archive', reversible: true, newRunAdmission: 'active-cases-only',
      historyAndResults: 'retained', listing: 'all-with-optional-lifecycle-metadata', erasure: {
        operations: ['tests.erasure-review', 'tests.erase', 'tests.erasure'], authority: 'management-owner-only',
        scope: 'archived-manual-never-accepted-draft; unreferenced-only', review: 'pins-only; references-not-discovered',
        retry: 'observe-original-receipt', actor: 'host-fixed', securePhysicalErasure: false } },
    vendorImport: { operations: ['import.preview', 'projects.import.vendor', 'projects.import.vendor.show'],
      creation: 'atomic-project-and-private-origin; caller-retained-project-id', review: ['source', 'conversion', 'draft'],
      inspect: 'explicit-private-opt-in', projectTransfer: 'origin-excluded', execution: false },
    modelDiscovery: { operation: 'providers.discover', protocols: ['openai-compatible'], automatic: false, permissionMutation: false,
      maxModels: 1000, maxTimeoutSeconds: 30, redirects: false, retries: false },
    releases: { operations: ['releases.list', 'releases.show', 'releases.create'],
      createRuntimeGuard: 'installed-bundle-version-and-sha256', packaging: 'client-side', deployment: false,
      notes: { optional: true, immutable: true, includedInReleaseHash: true, maxUtf8Bytes: RELEASE_NOTES_MAX_BYTES,
        exportVisibility: 'release-metadata', executionAuthority: false } },
    runEvidenceSchemaVersion: storage === 'postgres' ? 2 : 1,
    usage: { operation: 'usage.report', selection: 'explicit-run-ids-and-revisions', maxRuns: 100, billing: false,
      grouping: ['provider', 'provider-model'], maxGroups: 1000, identities: 'explicit-opt-in; verified-requested-model; no-account-totals',
      window: 'optional-paired-UTC-millisecond-from-inclusive-before-exclusive; original-model-intent; no-discovery' },
    approvalInbox: { operation: 'approvals.list', paginationRequired: true, scope: 'one-live-run-page', automaticExpiry: false },
    approvalNotifications: { available: true, eventKinds: ['requested', 'decided', 'expired', 'cancelled'],
      operations: ['notifications.destinations', 'notifications.prepare', 'notifications.send', 'notifications.show', 'notifications.list', 'notifications.project-list', 'notifications.abort',
        'notifications.automatic-status', 'notifications.automatic-show', 'notifications.automatic-list'],
      automaticDiagnostics: { readOnly: true, paginationRequired: true, maxLimit: 200, policyBody: false, replay: false },
      history: { operation: 'notifications.list', paginationRequired: true, maxLimit: 200, order: 'request-id-ascending', consistency: 'live-keyset; not-a-snapshot' },
      projectHistory: { operation: 'notifications.project-list', scope: 'exact-historical-project-id-generation-revision',
        paginationRequired: true, maxLimit: 200, cursor: 'matching-delivery-only', automaticDelivery: false },
      scope: 'management-owner', configuration: 'operator-startup-only', automaticDelivery,
      disconnect: 'admitted-send-continues; inspect-retained-request-id', redelivery: 'explicit-new-id-and-latest-predecessor' },
    journalSequenceEncoding: storage === 'postgres' ? 'decimal-int64' : 'safe-integer',
    pagination: {
      schemaVersion: 2, defaultLimit: 100, maxLimit: 200,
      operations: ['runs.list', 'tests.list', 'tests.generations', 'projects.deletions', 'providers.audit', 'releases.list'],
      required: storage === 'postgres', recordOrder: 'id-ascending', auditOrder: 'sequence-ascending',
      consistency: 'live-keyset; not-a-snapshot',
    },
  } as const
}
