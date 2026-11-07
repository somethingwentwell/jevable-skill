import { postGrpc } from "./grpc.js";
import { ExportFailure } from "./failure.js";
export { ExportFailure } from "./failure.js";
/** A slow/failed storage read must not outlive the exporter deadline or leak its diagnostics. */
function resolveCredential(read, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => reject(new ExportFailure('transport'));
        if (signal.aborted) {
            abort();
            return;
        }
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => { signal.throwIfAborted(); return read(); }).then(value => {
            signal.removeEventListener('abort', abort);
            resolve(value);
        }, () => { signal.removeEventListener('abort', abort); reject(new ExportFailure('transport')); });
    });
}
/** One explicit, non-retrying request. Never expose credentials or collector error text. */
export async function postOtlp(endpoint, bytes, policy, credential, controller, signal = 'traces') {
    if (!bytes || bytes.byteLength > 4_000_000)
        throw new ExportFailure('serialization');
    let response;
    const timeout = setTimeout(() => controller.abort(), policy.timeoutMs);
    const deadline = performance.now() + policy.timeoutMs;
    try {
        controller.signal.throwIfAborted();
        const key = policy.authentication.kind === 'bearer' ? await resolveCredential(credential, controller.signal) : undefined;
        controller.signal.throwIfAborted();
        if (policy.authentication.kind === 'bearer' && !key)
            throw new ExportFailure('transport');
        if (policy.protocol === 'grpc')
            return await postGrpc(endpoint, bytes, signal, key, controller.signal, deadline - performance.now());
        response = await fetch(endpoint, { method: 'POST', redirect: 'manual', signal: controller.signal,
            headers: { 'content-type': 'application/x-protobuf', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: Buffer.from(bytes) });
        if (response.status !== 200 || !/^application\/x-protobuf(?:\s*;.*)?$/iu.test(response.headers.get('content-type') ?? ''))
            throw new ExportFailure('response');
        const reader = response.body?.getReader(), chunks = [];
        let size = 0;
        if (reader)
            try {
                for (;;) {
                    const next = await reader.read();
                    if (next.done)
                        break;
                    size += next.value.byteLength;
                    if (size > 64000)
                        throw new ExportFailure('response');
                    chunks.push(next.value);
                }
            }
            finally {
                await reader.cancel().catch(() => { });
                reader.releaseLock();
            }
        return Buffer.concat(chunks);
    }
    catch (error) {
        throw error instanceof ExportFailure ? error : new ExportFailure('transport');
    }
    finally {
        clearTimeout(timeout);
        await response?.body?.cancel().catch(() => { });
    }
}
export async function boundedFlush(work, timeoutMs) {
    let timer;
    try {
        await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    }
    finally {
        clearTimeout(timer);
    }
}
