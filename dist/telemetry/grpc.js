import { connect, constants, sensitiveHeaders } from 'node:http2';
import { ExportFailure } from "./failure.js";
const METHODS = {
    traces: '/opentelemetry.proto.collector.trace.v1.TraceService/Export',
    metrics: '/opentelemetry.proto.collector.metrics.v1.MetricsService/Export',
    logs: '/opentelemetry.proto.collector.logs.v1.LogsService/Export',
};
/** One bounded unary OTLP call per connection. No retries, discovery, compression or shared channel. */
export function postGrpc(endpoint, bytes, signal, key, abortSignal, remainingMs) {
    return new Promise((resolve, reject) => {
        let session, stream;
        let settled = false, headersSeen = false, trailersSeen = false, status, size = 0;
        // The limit includes exactly one five-byte envelope. Never allocate from a peer's length.
        const response = Buffer.alloc(64005);
        const finish = (error, body) => {
            if (settled)
                return;
            settled = true;
            abortSignal.removeEventListener('abort', abort);
            stream?.destroy();
            session?.destroy();
            if (error)
                reject(error);
            else
                resolve(body);
        };
        const abort = () => finish(new ExportFailure('transport'));
        if (abortSignal.aborted) {
            abort();
            return;
        }
        abortSignal.addEventListener('abort', abort, { once: true });
        try {
            session = connect(endpoint, { rejectUnauthorized: true, minVersion: 'TLSv1.2', maxHeaderListPairs: 64,
                maxSessionMemory: 8, settings: { enablePush: false, maxHeaderListSize: 16384 } });
            session.on('error', abort);
            session.on('close', abort);
            session.on('stream', pushed => { pushed.destroy(); finish(new ExportFailure('response')); });
            session.on('goaway', (code, lastStream) => {
                if (code !== constants.NGHTTP2_NO_ERROR || stream?.id === undefined || stream.id > lastStream)
                    abort();
            });
            stream = session.request({ ':method': 'POST', ':path': METHODS[signal],
                'grpc-timeout': `${Math.max(1, Math.ceil(remainingMs))}m`, 'content-type': 'application/grpc+proto',
                te: 'trailers', 'grpc-accept-encoding': 'identity', ...(key ? { authorization: `Bearer ${key}` } : {}),
                [sensitiveHeaders]: ['authorization'] });
            stream.on('error', abort);
            stream.on('aborted', abort);
            stream.on('close', abort);
            stream.on('response', (headers, flags) => {
                if (headersSeen || headers[':status'] !== 200 || typeof headers['content-type'] !== 'string'
                    || !/^application\/grpc(?:\+proto)?(?:\s*;.*)?$/iu.test(headers['content-type'])
                    || (headers['grpc-encoding'] !== undefined && headers['grpc-encoding'] !== 'identity')) {
                    finish(new ExportFailure('response'));
                    return;
                }
                headersSeen = true;
                if (headers['grpc-status'] !== undefined) {
                    // Trailers-only responses are errors; a successful unary Export requires a message.
                    if (!(flags & constants.NGHTTP2_FLAG_END_STREAM) || headers['grpc-status'] !== '0') {
                        finish(new ExportFailure('response'));
                        return;
                    }
                    status = '0';
                }
            });
            stream.on('trailers', headers => {
                if (!headersSeen || trailersSeen || status !== undefined || headers['grpc-status'] !== '0'
                    || headers['grpc-status-details-bin'] !== undefined) {
                    finish(new ExportFailure('response'));
                    return;
                }
                trailersSeen = true;
                status = '0';
            });
            stream.on('data', (chunk) => {
                if (settled)
                    return;
                if (!headersSeen || trailersSeen || status !== undefined || size + chunk.length > response.length) {
                    finish(new ExportFailure('response'));
                    return;
                }
                chunk.copy(response, size);
                size += chunk.length;
                if (size >= 5 && (response[0] !== 0 || response.readUInt32BE(1) > 64000 || size > response.readUInt32BE(1) + 5))
                    finish(new ExportFailure('response'));
            });
            stream.on('end', () => {
                if (!headersSeen || !trailersSeen || status !== '0' || size < 5 || response[0] !== 0
                    || response.readUInt32BE(1) + 5 !== size || stream.rstCode !== constants.NGHTTP2_NO_ERROR) {
                    finish(new ExportFailure('response'));
                    return;
                }
                finish(undefined, Buffer.from(response.subarray(5, size)));
            });
            const framed = Buffer.alloc(bytes.byteLength + 5);
            framed.writeUInt32BE(bytes.byteLength, 1);
            framed.set(bytes, 5);
            stream.end(framed);
        }
        catch {
            abort();
        }
    });
}
