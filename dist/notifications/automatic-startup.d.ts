import type { NotificationRuntimePolicy } from './config.ts';
import { type Release } from '../releases/snapshot.ts';
type Automatic = NonNullable<NotificationRuntimePolicy['automatic']>;
/** Trusted startup import, not execution or approval authority. Exact-release hosts
 * cannot use their notification file to select a project or another release.
 * Packaged entries separately verify actual embedded runtime bytes before this call.
 */
export declare function prepareAutomaticStartupRelease(value: unknown, config: Automatic | undefined): Release | undefined;
/** Read retained state first. Only absence of this exact reviewed startup release
 * permits the candidate; corrupt or conflicting existing state is never replaced.
 */
export declare function automaticStartupReleaseRead<T>(id: string, read: () => T | Promise<T>, startup: Release | undefined): Promise<T | Release>;
/** Existing sole owner's verified reads only. Never send, recover a reservation, alter a scope or resolve credentials. */
export declare function verifyAutomaticStartupScopes(config: Automatic, host: {
    project(id: string, generation?: number): {
        generation: number;
        acceptedRevision: string;
    } | Promise<{
        generation: number;
        acceptedRevision: string;
    }>;
    release(id: string): {
        sha256: string;
        snapshot: {
            workflow: {
                revision: string;
            };
        };
    } | Promise<{
        sha256: string;
        snapshot: {
            workflow: {
                revision: string;
            };
        };
    }>;
}): Promise<void>;
export {};
