import { constants } from 'node:fs';
import { open, stat, statfs } from 'node:fs/promises';
import { z } from 'zod';
const identity = (info) => ({ dev: String(info.dev), ino: String(info.ino) });
async function kernelText(path, maximum) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const bytes = Buffer.alloc(maximum + 1), result = await file.read(bytes, 0, bytes.length, 0);
        if (result.bytesRead > maximum)
            throw new Error('Unsupported kernel identity.');
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, result.bytesRead));
    }
    finally {
        await file.close();
    }
}
/** Kernel-only identity. Probe failure never weakens exclusion. No shell/OS helper,
 * native addon, network, desktop discovery or untrusted context override.
 * Conservative Linux ext/XFS/Btrfs/tmpfs only; overlay, NFS and FUSE are excluded.
 */
export async function currentOwnerContext(path, info) {
    if (process.platform !== 'linux')
        return null;
    try {
        const fs = await statfs(path, { bigint: true });
        if (![0xef53n, 0x58465342n, 0x9123683en, 0x01021994n].includes(fs.type))
            return null;
        const bootId = z.uuid().parse((await kernelText('/proc/sys/kernel/random/boot_id', 128)).trim());
        if (!(await kernelText('/proc/self/stat', 4096)).startsWith(`${process.pid} (`))
            return null;
        // Intentionally follow only fixed kernel namespace links. Refuse procfs views that
        // do not expose this process under its own PID, or expose another namespace there.
        const self = await stat('/proc/self/ns/pid', { bigint: true });
        const pid = await stat(`/proc/${process.pid}/ns/pid`, { bigint: true });
        if (self.dev !== pid.dev || self.ino !== pid.ino)
            return null;
        return { platform: 'linux', bootId, pidNamespace: identity(self), filesystemType: String(fs.type), directory: identity(info) };
    }
    catch {
        return null;
    }
}
