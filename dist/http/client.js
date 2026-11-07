import { PROTOCOL_VERSION } from "../capabilities.js";
import { RuntimeHttpError } from "./errors.js";
export { RuntimeHttpError } from "./errors.js";
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { validateCa } from "./tls.js";
import { z } from 'zod';
import { createParser } from 'eventsource-parser';
import { grantTokenProof } from "../access/grants.js";
import { reviewerDecisionRequestSchema, reviewerDecisionReceiptSchema } from "../access/reviewer.js";
import { parseTraceParent } from "../telemetry/config.js";
import { parseTraceRequestContext, selectBaggage } from "../telemetry/baggage.js";
import { admitWorkflowData } from "../workflow/index.js";
import { callerOperationSchema, callerStartRequestSchema, callerReleasePinSchema, callerRunReceiptSchema, callerRunResultSchema, callerCancellationRequestSchema } from "../access/caller.js";
import { callerCancellationReceiptSchema } from "../access/caller-cancellation.js";
import { callerControlRequestSchema, callerControlCheckpointSchema, callerControlReceiptSchema } from "../access/caller-control.js";
import { callerStreamOptionsSchema, admitCallerStreamEvent } from "./caller-stream.js";
import { asyncRunRequestSchema, asyncRunReceiptSchema, asyncReleasePinSchema } from "./async-runs.js";
function admitClientTraceContext(value) {
    try {
        const context = parseTraceRequestContext(typeof value === 'string' ? { traceparent: value } : value ?? {});
        parseTraceParent(context.traceparent);
        const baggage = selectBaggage(context.baggage);
        return { ...context, baggage };
    }
    catch {
        throw new RuntimeHttpError('invalid-command');
    }
}
/** Bounded delta seconds only. A header is a hint, never an instruction to schedule a retry. */
function rateRetryAfter(response, code, status) {
    const value = response.headers['retry-after'];
    return status === 429 && code === 'rate-limit' && typeof value === 'string' && /^[1-9][0-9]{0,3}$/u.test(value)
        && Number(value) <= 3600 ? Number(value) : undefined;
}
/** Explicit loopback HTTP or verified HTTPS; no discovery, redirects or automatic retries. */
class RuntimeHttpTransport {
    token;
    timeoutMs;
    maxResponseBytes;
    endpoint;
    ca;
    expectedInstanceId;
    constructor(endpoint, token, timeoutMs = 30_000, maxResponseBytes = 20_000_000, tls = {}, kind = 'owner') {
        this.token = token;
        this.timeoutMs = timeoutMs;
        this.maxResponseBytes = maxResponseBytes;
        let url;
        try {
            url = new URL(endpoint);
        }
        catch {
            throw new RuntimeHttpError('invalid-endpoint');
        }
        if ((url.protocol !== 'https:' && (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port))
            || url.port === '0' || url.username || url.password
            || url.pathname !== '/' || url.search || url.hash || !(kind === 'owner' ? /^[a-f0-9]{64}$/u.test(token) : grantTokenProof(token))
            || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000
            || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 64_000_000)
            throw new RuntimeHttpError('invalid-config');
        try {
            if (!tls || typeof tls !== 'object' || Object.keys(tls).some(key => key !== 'ca' && key !== 'expectedInstanceId')
                || (tls.expectedInstanceId !== undefined && !z.uuid().safeParse(tls.expectedInstanceId).success)
                || (tls.ca !== undefined && url.protocol !== 'https:'))
                throw new Error();
            this.ca = tls.ca === undefined ? undefined : validateCa(tls.ca);
            this.expectedInstanceId = tls.expectedInstanceId;
        }
        catch {
            throw new RuntimeHttpError('invalid-config');
        }
        this.endpoint = url.origin;
    }
    /** Explicit one-way owner pin, shared by every later request. Never relax or silently replace it. */
    pinInstance(instanceId) {
        if (!z.uuid().safeParse(instanceId).success)
            throw new RuntimeHttpError('invalid-config');
        if (this.expectedInstanceId !== undefined && this.expectedInstanceId !== instanceId)
            throw new RuntimeHttpError('conflict');
        this.expectedInstanceId = instanceId;
    }
    async request(path, command, traceParent, admission = {}) {
        const context = admitClientTraceContext(traceParent);
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response;
        try {
            const payload = command === undefined ? undefined : JSON.stringify(command);
            response = await new Promise((resolve, reject) => {
                const request = this.endpoint.startsWith('https:') ? httpsRequest : httpRequest;
                const outgoing = request(this.endpoint + path, { method: command === undefined ? 'GET' : 'POST', signal: controller.signal,
                    agent: false, maxHeaderSize: 16_384, rejectUnauthorized: true, minVersion: 'TLSv1.2',
                    ...(this.ca === undefined ? {} : { ca: this.ca }),
                    headers: { Authorization: `Bearer ${this.token}`, 'X-Jevable-Protocol': PROTOCOL_VERSION,
                        ...(context.traceparent === undefined ? {} : { traceparent: context.traceparent }),
                        ...(context.baggage === undefined ? {} : { baggage: context.baggage }),
                        ...(this.expectedInstanceId === undefined ? {} : { 'X-Jevable-Instance': this.expectedInstanceId }),
                        ...(admission.releaseSha256 === undefined ? {} : { 'X-Jevable-Release-Sha256': admission.releaseSha256 }),
                        ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) } }, resolve);
                outgoing.on('error', reject);
                outgoing.end(payload);
            });
            const status = response.statusCode ?? 0;
            if (response.headers['x-jevable-protocol'] !== PROTOCOL_VERSION)
                throw new RuntimeHttpError('protocol-mismatch', status);
            if (status >= 300 && status < 400)
                throw new RuntimeHttpError('redirect-refused', status);
            if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(response.headers['content-type'] ?? '')
                || response.headers['content-encoding'] !== undefined)
                throw new RuntimeHttpError('invalid-response', status);
            const chunks = [];
            let bytes = 0;
            for await (const chunk of response) {
                bytes += chunk.byteLength;
                if (bytes > this.maxResponseBytes)
                    throw new RuntimeHttpError('response-limit', status);
                chunks.push(chunk);
            }
            let value;
            try {
                value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            }
            catch {
                throw new RuntimeHttpError('invalid-response', status);
            }
            if (status < 200 || status >= 300) {
                const code = value && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
                    && /^[a-z][a-z0-9-]{0,63}$/u.test(value.code) ? value.code : 'operation-failed';
                throw new RuntimeHttpError(code, status, rateRetryAfter(response, code, status));
            }
            return admission.admit ? admission.admit(value, status, response) : value;
        }
        catch (error) {
            if (error instanceof RuntimeHttpError)
                throw error;
            throw new RuntimeHttpError(controller.signal.aborted ? 'request-timeout' : 'transport-uncertain');
        }
        finally {
            clearTimeout(timer);
            response?.destroy();
        }
    }
    /** One explicit POST stream. Abort/disconnect/EOF never reconnect, resume or repeat the request. */
    async *requestEvents(path, command, signal) {
        const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, this.timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        let response;
        try {
            if (signal?.aborted) {
                controller.abort();
                return;
            }
            const payload = JSON.stringify(command);
            response = await new Promise((resolve, reject) => {
                const request = this.endpoint.startsWith('https:') ? httpsRequest : httpRequest;
                const outgoing = request(this.endpoint + path, { method: 'POST', signal: controller.signal, agent: false, maxHeaderSize: 16_384,
                    rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(this.ca === undefined ? {} : { ca: this.ca }),
                    headers: { Authorization: `Bearer ${this.token}`, 'X-Jevable-Protocol': PROTOCOL_VERSION,
                        ...(this.expectedInstanceId === undefined ? {} : { 'X-Jevable-Instance': this.expectedInstanceId }),
                        Accept: 'text/event-stream', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, resolve);
                outgoing.on('error', reject);
                outgoing.end(payload);
            });
            const status = response.statusCode ?? 0;
            if (response.headers['x-jevable-protocol'] !== PROTOCOL_VERSION)
                throw new RuntimeHttpError('protocol-mismatch', status);
            if (status >= 300 && status < 400)
                throw new RuntimeHttpError('redirect-refused', status);
            if (status !== 200) {
                if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(response.headers['content-type'] ?? '')
                    || response.headers['content-encoding'] !== undefined)
                    throw new RuntimeHttpError('invalid-response', status);
                const chunks = [];
                let bytes = 0;
                for await (const chunk of response) {
                    bytes += chunk.length;
                    if (bytes > Math.min(this.maxResponseBytes, 16384))
                        throw new RuntimeHttpError('response-limit', status);
                    chunks.push(chunk);
                }
                let value;
                try {
                    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
                }
                catch {
                    throw new RuntimeHttpError('invalid-response', status);
                }
                const code = value && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
                    && /^[a-z][a-z0-9-]{0,63}$/u.test(value.code) ? value.code : 'operation-failed';
                throw new RuntimeHttpError(code, status, rateRetryAfter(response, code, status));
            }
            if (!/^text\/event-stream(?:\s*;\s*charset=utf-8)?$/iu.test(response.headers['content-type'] ?? '')
                || response.headers['content-encoding'] !== undefined)
                throw new RuntimeHttpError('invalid-response', status);
            const decoder = new TextDecoder('utf-8', { fatal: true }), pending = [];
            let bytes = 0, events = 0, frameBytes = 0, buffered = '';
            const parser = createParser({
                onError() { throw new RuntimeHttpError('invalid-response'); },
                onRetry() { throw new RuntimeHttpError('invalid-response'); },
                onEvent(event) {
                    if (++events > 1000 || event.id !== undefined || !['snapshot', 'stopped'].includes(event.event ?? ''))
                        throw new RuntimeHttpError('invalid-response');
                    let data;
                    try {
                        data = JSON.parse(event.data);
                    }
                    catch {
                        throw new RuntimeHttpError('invalid-response');
                    }
                    pending.push({ event: event.event, data });
                },
            });
            const feed = (text) => {
                buffered += text;
                let end;
                while ((end = buffered.indexOf('\n')) !== -1) {
                    let line = buffered.slice(0, end);
                    buffered = buffered.slice(end + 1);
                    if (line.endsWith('\r'))
                        line = line.slice(0, -1);
                    frameBytes += Buffer.byteLength(line) + 1;
                    if (line.includes('\r') || frameBytes > 16384)
                        throw new RuntimeHttpError('invalid-response');
                    parser.feed(line + '\n');
                    if (!line)
                        frameBytes = 0;
                }
                if (Buffer.byteLength(buffered) > 16384)
                    throw new RuntimeHttpError('invalid-response');
            };
            const decode = (chunk) => {
                try {
                    return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true });
                }
                catch {
                    throw new RuntimeHttpError('invalid-response');
                }
            };
            for await (const chunk of response) {
                if (signal?.aborted)
                    return;
                bytes += chunk.length;
                if (bytes > this.maxResponseBytes)
                    throw new RuntimeHttpError('response-limit');
                feed(decode(chunk));
                while (pending.length)
                    yield pending.shift();
            }
            feed(decode());
            if (buffered || frameBytes)
                throw new RuntimeHttpError('invalid-response');
            while (pending.length)
                yield pending.shift();
        }
        catch (error) {
            if (signal?.aborted)
                return;
            if (error instanceof RuntimeHttpError)
                throw error;
            throw new RuntimeHttpError(controller.signal.aborted ? 'request-timeout' : 'transport-uncertain');
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            controller.abort();
            response?.destroy();
        }
    }
}
/** Owner-only async admission/status. Explicit instance pin, no discovery, retries or execution controls. */
export class AsyncRunClient extends RuntimeHttpTransport {
    instanceId;
    release;
    constructor(endpoint, token, instanceId, options = {}) {
        if (!z.uuid().safeParse(instanceId).success || !options || typeof options !== 'object' || Array.isArray(options)
            || Object.keys(options).some(key => !['timeoutMs', 'maxResponseBytes', 'ca', 'release'].includes(key))
            || options.timeoutMs !== undefined && typeof options.timeoutMs !== 'number'
            || options.maxResponseBytes !== undefined && typeof options.maxResponseBytes !== 'number')
            throw new RuntimeHttpError('invalid-config');
        const release = options.release === undefined ? undefined : asyncReleasePinSchema.safeParse(options.release);
        if (release && !release.success)
            throw new RuntimeHttpError('invalid-config');
        super(endpoint, token, options.timeoutMs ?? 30_000, options.maxResponseBytes ?? 20_000_000, { expectedInstanceId: instanceId, ...(options.ca === undefined ? {} : { ca: options.ca }) });
        this.instanceId = instanceId;
        this.release = release?.data;
    }
    async start(value, traceContext) {
        let request;
        try {
            request = asyncRunRequestSchema.parse(admitWorkflowData(value, { maxBytes: 4_000_000, maxDepth: 64, maxValues: 100_000 }));
        }
        catch {
            throw new RuntimeHttpError('invalid-command');
        }
        if (this.release && (request.kind !== 'release' || !this.sameRelease(request.release, this.release)))
            throw new RuntimeHttpError('invalid-command');
        return await this.request('/v1/async-runs', request, traceContext, {
            admit: (value, status, response) => {
                const receipt = this.receipt(value, request.id);
                const locations = response.rawHeaders.filter((_, index) => index % 2 === 0 && response.rawHeaders[index].toLowerCase() === 'location');
                if (locations.length !== 1 || response.headers.location !== '/v1/async-runs/' + receipt.run.id
                    || !(status === 202 && receipt.observation === 'created' || status === 200 && receipt.observation === 'retained'))
                    throw new RuntimeHttpError('invalid-response', status);
                const run = receipt.run;
                if (run.test || run.triggerMode !== request.triggerMode || (run.startedPaused === true) !== (request.paused === true)
                    || request.kind === 'workflow' && (run.project || run.release)
                    || request.kind === 'project' && (run.release || !run.project || !this.sameId(run.project.id, request.project.id)
                        || run.project.generation !== request.project.generation || run.revision !== request.project.revision)
                    || request.kind === 'release' && (run.project || !run.release || !this.sameRelease({ ...run.release, revision: run.revision }, request.release)))
                    throw new RuntimeHttpError('invalid-response', status);
                return receipt;
            },
        });
    }
    /** A metadata read only. Never resumes, waits for completion, or returns private run payloads. */
    async show(id) {
        if (!z.uuid().safeParse(id).success)
            throw new RuntimeHttpError('invalid-command');
        return await this.request('/v1/async-runs/' + id, undefined, undefined, {
            ...(this.release === undefined ? {} : { releaseSha256: this.release.sha256 }),
            admit: (value, status) => {
                const receipt = this.receipt(value, id);
                if (status !== 200 || receipt.observation !== 'read')
                    throw new RuntimeHttpError('invalid-response', status);
                return receipt;
            },
        });
    }
    sameId(a, b) { return a.toLowerCase() === b.toLowerCase(); }
    sameRelease(a, b) {
        return this.sameId(a.id, b.id) && a.sha256 === b.sha256 && a.revision === b.revision;
    }
    receipt(value, id) {
        const parsed = asyncRunReceiptSchema.safeParse(value);
        if (!parsed.success || !this.sameId(parsed.data.instanceId, this.instanceId) || !this.sameId(parsed.data.run.id, id)
            || Date.parse(parsed.data.run.updatedAt) < Date.parse(parsed.data.run.createdAt)
            || this.release && (!parsed.data.run.release || parsed.data.run.project || parsed.data.run.test
                || !this.sameRelease({ ...parsed.data.run.release, revision: parsed.data.run.revision }, this.release)))
            throw new RuntimeHttpError('invalid-response');
        return parsed.data;
    }
}
/** Grant-only pinned-release operations. Never authenticates owner operations or discovers a host. */
export class CallerClient extends RuntimeHttpTransport {
    instanceId;
    release;
    constructor(endpoint, token, instanceId, release, timeoutMs = 30_000, maxResponseBytes = 20_000_000, tls = {}) {
        const pin = callerReleasePinSchema.safeParse(release);
        if (!pin.success || !z.uuid().safeParse(instanceId).success || !tls || typeof tls !== 'object' || Object.keys(tls).some(key => key !== 'ca'))
            throw new RuntimeHttpError('invalid-config');
        super(endpoint, token, timeoutMs, maxResponseBytes, { ...tls, expectedInstanceId: instanceId }, 'caller');
        this.instanceId = instanceId;
        this.release = pin.data;
    }
    async start(value, traceParent) {
        let parsed;
        try {
            parsed = callerStartRequestSchema.safeParse(admitWorkflowData(value, { maxBytes: 4_000_000, maxDepth: 64, maxValues: 100_000 }));
        }
        catch {
            throw new RuntimeHttpError('invalid-command');
        }
        if (!parsed.success)
            throw new RuntimeHttpError('invalid-command');
        return this.call({ operation: 'start', release: this.release, ...parsed.data }, traceParent);
    }
    async read(id, traceParent) {
        const parsed = callerOperationSchema.safeParse({ operation: 'read', release: this.release, id });
        if (!parsed.success || parsed.data.operation !== 'read')
            throw new RuntimeHttpError('invalid-command');
        return this.call({ operation: 'read', release: this.release, id: parsed.data.id }, traceParent);
    }
    /** Observe metadata only, even when read permission also permits completed output. */
    async *stream(id, options = {}) {
        if (!options || typeof options !== 'object' || Array.isArray(options))
            throw new RuntimeHttpError('invalid-command');
        const { signal, ...settings } = options, parsed = callerStreamOptionsSchema.safeParse(settings);
        if (!z.uuid().safeParse(id).success || !parsed.success || signal !== undefined && !(signal instanceof AbortSignal))
            throw new RuntimeHttpError('invalid-command');
        id = id.toLowerCase();
        let last;
        for await (const packet of this.requestEvents('/v1/caller/stream', { ...parsed.data, id, release: this.release }, signal)) {
            let event;
            try {
                event = admitCallerStreamEvent(packet.data, this.instanceId, id, this.release, last);
            }
            catch {
                throw new RuntimeHttpError('invalid-response');
            }
            if (event.type !== packet.event)
                throw new RuntimeHttpError('invalid-response');
            last = event;
            yield event;
            if (event.type === 'stopped')
                return;
        }
        if (signal?.aborted) {
            yield { schemaVersion: 1, type: 'stopped', sequence: (last?.sequence ?? 0) + 1, instanceId: this.instanceId,
                reason: 'interrupted', execution: 'not-requested' };
            return;
        }
        throw new RuntimeHttpError('stream-incomplete');
    }
    async cancel(id, value, traceParent) {
        let parsed;
        try {
            parsed = callerOperationSchema.safeParse({ operation: 'cancel', release: this.release, id,
                request: callerCancellationRequestSchema.parse(admitWorkflowData(value, { maxBytes: 4096, maxDepth: 8, maxValues: 32 })) });
        }
        catch {
            throw new RuntimeHttpError('invalid-command');
        }
        if (!parsed.success || parsed.data.operation !== 'cancel')
            throw new RuntimeHttpError('invalid-command');
        return this.call(parsed.data, traceParent);
    }
    async checkpoint(id, traceParent) {
        const parsed = callerOperationSchema.safeParse({ operation: 'checkpoint', release: this.release, id });
        if (!parsed.success || parsed.data.operation !== 'checkpoint')
            throw new RuntimeHttpError('invalid-command');
        return this.call(parsed.data, traceParent);
    }
    async control(id, value, traceParent) {
        let parsed;
        try {
            parsed = callerOperationSchema.safeParse({ operation: 'control', release: this.release, id,
                request: callerControlRequestSchema.parse(admitWorkflowData(value, { maxBytes: 16384, maxDepth: 8, maxValues: 256 })) });
        }
        catch {
            throw new RuntimeHttpError('invalid-command');
        }
        if (!parsed.success || parsed.data.operation !== 'control')
            throw new RuntimeHttpError('invalid-command');
        return this.call(parsed.data, traceParent);
    }
    async call(command, traceParent) {
        try {
            admitClientTraceContext(traceParent);
        }
        catch {
            throw new RuntimeHttpError('invalid-command');
        }
        let raw;
        try {
            raw = admitWorkflowData(await this.request('/v1/caller/operations', command, traceParent), { maxBytes: 64_000_000, maxDepth: 64, maxValues: 100_000 });
        }
        catch (error) {
            if (error instanceof RuntimeHttpError)
                throw error;
            throw new RuntimeHttpError('invalid-response');
        }
        const parsed = z.strictObject({ schemaVersion: z.literal(1), instanceId: z.literal(this.instanceId),
            result: command.operation === 'start' ? callerRunReceiptSchema : command.operation === 'cancel'
                ? callerCancellationReceiptSchema : command.operation === 'checkpoint' ? callerControlCheckpointSchema
                : command.operation === 'control' ? callerControlReceiptSchema : callerRunResultSchema }).safeParse(raw);
        const id = command.operation === 'start' ? command.options.id : command.id;
        if (!parsed.success || parsed.data.result.id !== id || parsed.data.result.revision !== this.release.revision
            || parsed.data.result.release.id !== this.release.id || parsed.data.result.release.sha256 !== this.release.sha256
            || (command.operation === 'cancel' || command.operation === 'control') && (!('requestId' in parsed.data.result) || parsed.data.result.requestId !== command.request.requestId)
            || command.operation === 'control' && (!('mode' in parsed.data.result) || parsed.data.result.mode !== command.request.mode))
            throw new RuntimeHttpError('invalid-response');
        return parsed.data;
    }
}
/** Owner-only management client. Grant tokens cannot construct or authenticate it. */
export class RuntimeClient extends RuntimeHttpTransport {
    constructor(endpoint, token, timeoutMs = 30_000, maxResponseBytes = 20_000_000, tls = {}) {
        super(endpoint, token, timeoutMs, maxResponseBytes, tls);
    }
    capabilities() { return this.request('/v1/capabilities'); }
    health() { return this.request('/v1/health'); }
    operation(command, traceParent) { return this.request('/v1/operations', command, traceParent); }
}
/** Separate grant-only client. No discovery, owner operations, storage, token lookup or retries. */
export class ReviewerClient extends RuntimeHttpTransport {
    instanceId;
    constructor(endpoint, token, instanceId, timeoutMs = 30_000, maxResponseBytes = 16_384, tls = {}) {
        if (!z.uuid().safeParse(instanceId).success || !tls || typeof tls !== 'object' || Object.keys(tls).some(key => key !== 'ca'))
            throw new RuntimeHttpError('invalid-config');
        super(endpoint, token, timeoutMs, maxResponseBytes, { ...tls, expectedInstanceId: instanceId }, 'reviewer');
        this.instanceId = instanceId;
    }
    async decide(value, traceParent) {
        const parsed = reviewerDecisionRequestSchema.safeParse(value);
        if (!parsed.success)
            throw new RuntimeHttpError('invalid-command');
        try {
            admitClientTraceContext(traceParent);
        }
        catch {
            throw new RuntimeHttpError('invalid-command');
        }
        const response = z.strictObject({ schemaVersion: z.literal(1), instanceId: z.literal(this.instanceId), result: reviewerDecisionReceiptSchema })
            .safeParse(await this.request('/v1/reviewer/decisions', parsed.data, traceParent));
        if (!response.success || response.data.result.requestId !== parsed.data.requestId || response.data.result.action !== parsed.data.action
            || response.data.result.pauseAfter !== (parsed.data.pauseAfter === true))
            throw new RuntimeHttpError('invalid-response');
        return response.data;
    }
}
