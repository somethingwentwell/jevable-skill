import { type Release } from './snapshot.ts';
import type { LocalRuntime } from '../runtime/local.ts';
import type { PostgresRuntime } from '../runtime/postgres.ts';
import type { RuntimeServerOptions, startRuntimeServer } from '../http/server.ts';
import { type CliIO } from '../process/cli-output.ts';
import type { CoordinatedHttpRateLimits } from '../http/coordinated-rate-limits.ts';
import type { PostgresHttpRateCoordinatorCode } from '../http/postgres-rate-config.ts';
/** Safe backend-owned quota startup category; never adopt a driver message or private config. */
export declare class ReleaseRateCoordinatorStartupError extends Error {
    readonly code: PostgresHttpRateCoordinatorCode;
    constructor(code: PostgresHttpRateCoordinatorCode);
}
type Methods = 'check' | 'connections' | 'configureConnection' | 'credentialStatus' | 'setCredential' | 'clearCredential' | 'runRelease' | 'show' | 'events' | 'exportRun' | 'exportUsageRun' | 'advance' | 'decide' | 'cancel' | 'close' | 'grant' | 'issueGrant' | 'revokeGrant' | 'decideWithGrant' | 'reviewerReleaseWithGrant' | 'notificationDestinations' | 'prepareApprovalNotification' | 'sendApprovalNotification' | 'inspectApprovalNotification' | 'listApprovalNotifications' | 'abortApprovalNotification' | 'automaticApprovalNotificationStatus' | 'automaticApprovalAdmissions' | 'automaticApprovalAdmission';
type Values = Record<string, string | boolean | undefined>;
export interface ReleaseBackend {
    storage: 'sqlite' | 'postgres';
    /** Explicit optional SQLite bundle capability, not a workflow storage switch. */
    rateCoordinator?: 'postgres';
    open(values: Values, directory: string, release: Release): Promise<Pick<LocalRuntime, Methods | 'list' | 'listReleasePage'> | Pick<PostgresRuntime, Methods | 'list' | 'listRelease'>>;
    serve(values: Values, directory: string, options: RuntimeServerOptions & {
        release: {
            snapshot: unknown;
        };
    }): ReturnType<typeof startRuntimeServer>;
    /** Optional explicit backend adapter: validate/capture private settings without I/O to a database,
     * then return an opener. Shared/SQLite app code imports no PostgreSQL runtime or driver.
     */
    prepareRateCoordinator?(values: Values): Promise<() => Promise<{
        admission(): CoordinatedHttpRateLimits;
        close(): Promise<void>;
    }>>;
}
/** Bundled release execution surface, intentionally not the authoring CLI. */
export declare function runReleaseApp(backend: ReleaseBackend, value: unknown, argv: string[], directory: string, io?: CliIO): Promise<number>;
export {};
