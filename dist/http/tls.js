import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { isIP } from 'node:net';
import { createSecureContext } from 'node:tls';
import { z } from 'zod';
import { WorkflowRuntimeError } from "../runtime/errors.js";
const tlsSchema = z.strictObject({ publicOrigin: z.string().max(2048), bindAddress: z.string().max(256),
    certificateFile: z.string().min(1).max(4096), privateKeyFile: z.string().min(1).max(4096) });
const MAX_PEM_BYTES = 262_144;
const invalid = () => new WorkflowRuntimeError('invalid-command');
/** Reject symlinks/special files and bound reads, including files that grow after stat. */
export async function readTlsPemFile(path, privateKey = false) {
    try {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size < 1 || stat.size > MAX_PEM_BYTES
                || (privateKey && process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())))
                throw invalid();
            const bytes = Buffer.alloc(MAX_PEM_BYTES + 1);
            let length = 0;
            while (length < bytes.length) {
                const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
                if (!bytesRead)
                    break;
                length += bytesRead;
            }
            if (length > MAX_PEM_BYTES)
                throw invalid();
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
        }
        finally {
            await file.close();
        }
    }
    catch {
        throw invalid();
    }
}
/** Only PEM certificate bundles; no silent system-CA fallback for an invalid explicit CA. */
export function validateCa(ca) {
    if (typeof ca !== 'string' || !ca.length || Buffer.byteLength(ca) > MAX_PEM_BYTES)
        throw invalid();
    const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu);
    if (!certificates?.length || ca.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu, '').trim())
        throw invalid();
    try {
        for (const cert of certificates)
            new X509Certificate(cert);
    }
    catch {
        throw invalid();
    }
    return ca;
}
export async function loadRuntimeTls(value) {
    // Parse synchronously before reading files so callers cannot change configuration mid-startup.
    const parsed = tlsSchema.safeParse(value);
    if (!parsed.success)
        throw invalid();
    const options = parsed.data;
    let origin;
    try {
        origin = new URL(options.publicOrigin);
    }
    catch {
        throw invalid();
    }
    if (origin.protocol !== 'https:' || options.publicOrigin !== origin.origin || origin.port === '0'
        || !isIP(options.bindAddress))
        throw invalid();
    const cert = validateCa(await readTlsPemFile(options.certificateFile));
    const key = await readTlsPemFile(options.privateKeyFile, true);
    try {
        const leaf = new X509Certificate(cert), hostname = origin.hostname.replace(/^\[|\]$/gu, '');
        if (!leaf.checkPrivateKey(createPrivateKey(key)) || Date.parse(leaf.validFrom) > Date.now()
            || Date.parse(leaf.validTo) <= Date.now()
            || !(isIP(hostname) ? leaf.checkIP(hostname) : leaf.checkHost(hostname, { subject: 'never' })))
            throw invalid();
        createSecureContext({ cert, key, minVersion: 'TLSv1.2' });
        return { cert, key, publicOrigin: origin.origin, authority: origin.host, bindAddress: options.bindAddress,
            certificateSha256: leaf.fingerprint256.replaceAll(':', '').toLowerCase() };
    }
    catch {
        throw invalid();
    }
}
/** TLS is opt-in as a complete profile. A bind-address flag alone cannot expose plaintext HTTP. */
export function tlsOptionsFromFlags(values) {
    const names = ['public-origin', 'bind-address', 'tls-cert-file', 'tls-key-file'];
    if (names.every(name => values[name] === undefined))
        return undefined;
    if (names.some(name => typeof values[name] !== 'string' || !values[name]))
        throw invalid();
    return { publicOrigin: values['public-origin'], bindAddress: values['bind-address'],
        certificateFile: values['tls-cert-file'], privateKeyFile: values['tls-key-file'] };
}
