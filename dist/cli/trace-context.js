import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { parseTraceParent } from "../telemetry/config.js";
import { parseTraceRequestContext, selectBaggage } from "../telemetry/baggage.js";
import { CliStorageUsageError } from "./usage.js";
const maxBytes = 65_536;
/** One private snapshot per invocation. Never an ambient carrier, credential or persisted input. */
export async function readCliTraceContext(value) {
    if (value === undefined)
        return undefined;
    const invalid = () => new CliStorageUsageError('Trace context requires a bounded owner-only JSON file with only traceparent and baggage; values are not displayed.');
    if (typeof value !== 'string' || !value)
        throw invalid();
    try {
        if ((await lstat(value)).isSymbolicLink())
            throw invalid();
        const file = await open(value, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > maxBytes || process.platform !== 'win32'
                && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
                throw invalid();
            const bytes = Buffer.alloc(maxBytes + 1);
            let offset = 0;
            while (offset < bytes.length) {
                const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null);
                if (!bytesRead)
                    break;
                offset += bytesRead;
            }
            if (offset > maxBytes)
                throw invalid();
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
            const context = parseTraceRequestContext(JSON.parse(text));
            parseTraceParent(context.traceparent);
            const baggage = selectBaggage(context.baggage);
            return Object.freeze({ ...(context.traceparent === undefined ? {} : { traceparent: context.traceparent }),
                ...(baggage === undefined ? {} : { baggage }) });
        }
        finally {
            await file.close();
        }
    }
    catch {
        throw invalid();
    }
}
