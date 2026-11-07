/** Shared executable-output admission. No CLI dispatcher/runtime-state dependency, cancellation or retry. */
export const CLI_OUTPUT_LIMITS = Object.freeze({ stdoutBytes: 32_000_000, stderrBytes: 64_000, pendingBytes: 64_000_000 });
export class CliOutputError extends Error {
    code;
    channel;
    constructor(code, channel) {
        super('CLI output is not confirmed complete; inspect retained identities before retrying.');
        this.code = code;
        this.channel = channel;
    }
}
const limit = (channel) => channel === 'stdout' ? CLI_OUTPUT_LIMITS.stdoutBytes : CLI_OUTPUT_LIMITS.stderrBytes;
export function encodeCliJson(value, channel = 'stdout', pretty = true) {
    let text;
    try {
        const json = JSON.stringify(value, null, pretty ? 2 : undefined);
        if (json === undefined)
            throw new Error();
        text = json + '\n';
    }
    catch {
        throw new CliOutputError('output-encoding-failed', channel);
    }
    if (Buffer.byteLength(text, 'utf8') > limit(channel))
        throw new CliOutputError('output-limit', channel);
    return text;
}
/** Admit a whole UTF-8 response/NDJSON record before its first write. Native writes
 * await callbacks, including asynchronous EPIPE; no stream is ended/destroyed here.
 * Limits bound admitted output and pending writes, not serialization heap or total stream length.
 */
export function createCliOutput(custom) {
    let failure, pendingBytes = 0, finished = false;
    const pending = new Set();
    const nativeListeners = new Map();
    const record = (error) => { failure ??= error; return error; };
    function nativeWrite(channel, text) {
        const stream = channel === 'stdout' ? process.stdout : process.stderr;
        if (!nativeListeners.has(channel)) {
            const listener = () => { record(new CliOutputError('output-write-failed', channel)); };
            nativeListeners.set(channel, listener);
            stream.on('error', listener);
        }
        return new Promise(resolve => {
            try {
                stream.write(text, error => { if (error)
                    record(new CliOutputError('output-write-failed', channel)); resolve(); });
            }
            catch {
                record(new CliOutputError('output-write-failed', channel));
                resolve();
            }
        });
    }
    function write(channel, text) {
        if (finished || (failure && channel === 'stdout'))
            throw record(new CliOutputError('output-write-failed', channel));
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > limit(channel) || pendingBytes + bytes > CLI_OUTPUT_LIMITS.pendingBytes)
            throw record(new CliOutputError('output-limit', channel));
        let result;
        try {
            result = custom ? (channel === 'stdout' ? custom.out(text) : custom.err(text)) : nativeWrite(channel, text);
        }
        catch {
            throw record(new CliOutputError('output-write-failed', channel));
        }
        if (result === undefined)
            return;
        pendingBytes += bytes;
        const completion = Promise.resolve(result).then(() => { }, () => { record(new CliOutputError('output-write-failed', channel)); })
            .finally(() => { pendingBytes -= bytes; pending.delete(completion); });
        pending.add(completion);
    }
    async function settle() { while (pending.size)
        await Promise.all([...pending]); }
    return {
        io: { out: (text) => write('stdout', text), err: (text) => write('stderr', text) },
        record,
        get error() { return failure; },
        async finish() {
            if (finished)
                return;
            await settle();
            if (failure) {
                // Only fixed bounded metadata. Never embed output, arguments, paths or a writer's error/cause.
                const diagnostic = encodeCliJson({ schemaVersion: 1, status: 'error', code: failure.code, channel: failure.channel,
                    output: 'not-confirmed-complete', limitBytes: limit(failure.channel), pendingLimitBytes: CLI_OUTPUT_LIMITS.pendingBytes,
                    execution: 'not-cancelled-replayed-or-rolled-back-by-output-handler',
                    recovery: 'Inspect original retained run/request/artifact identities. Output failure does not prove that a write or execution failed; never invent a replacement identity or automatically redispatch.' }, 'stderr', false);
                try {
                    write('stderr', diagnostic);
                }
                catch { /* A broken stderr cannot carry a diagnostic; exit still signals failure. */ }
                await settle();
            }
            // Node calls write callbacks before emitting error. Keep listeners through that turn.
            if (nativeListeners.size)
                await new Promise(resolve => setImmediate(resolve));
            for (const [channel, listener] of nativeListeners)
                (channel === 'stdout' ? process.stdout : process.stderr).removeListener('error', listener);
            nativeListeners.clear();
            finished = true;
        },
    };
}
