import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { ProviderError } from "./config.js";
const MAX_BYTES = 8193;
/** Never accept a secret as a CLI argument. One trailing newline from a secret file/pipe is removed. */
function secretValue(bytes) {
    let value;
    try {
        value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r?\n$/u, '');
    }
    catch {
        throw new ProviderError('invalid-config');
    }
    if (!/^[\x21-\x7e]{1,8192}$/u.test(value))
        throw new ProviderError('invalid-config');
    return value;
}
export async function readSecretFile(path) {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES || (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.())))
            throw new ProviderError('invalid-config');
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
            if (!bytesRead)
                break;
            offset += bytesRead;
        }
        if (offset > MAX_BYTES)
            throw new ProviderError('invalid-config');
        return secretValue(buffer.subarray(0, offset));
    }
    finally {
        await file.close();
    }
}
export async function readSecretStdin() {
    if (process.stdin.isTTY)
        throw new ProviderError('invalid-config');
    const chunks = [];
    let count = 0;
    for await (const chunk of process.stdin) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        count += bytes.byteLength;
        if (count > MAX_BYTES)
            throw new ProviderError('invalid-config');
        chunks.push(bytes);
    }
    return secretValue(Buffer.concat(chunks));
}
