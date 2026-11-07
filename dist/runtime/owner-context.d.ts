import { type BigIntStats } from 'node:fs';
export interface RuntimeOwnerContext {
    platform: 'linux';
    bootId: string;
    pidNamespace: {
        dev: string;
        ino: string;
    };
    filesystemType: string;
    directory: {
        dev: string;
        ino: string;
    };
}
/** Kernel-only identity. Probe failure never weakens exclusion. No shell/OS helper,
 * native addon, network, desktop discovery or untrusted context override.
 * Conservative Linux ext/XFS/Btrfs/tmpfs only; overlay, NFS and FUSE are excluded.
 */
export declare function currentOwnerContext(path: string, info: BigIntStats): Promise<RuntimeOwnerContext | null>;
