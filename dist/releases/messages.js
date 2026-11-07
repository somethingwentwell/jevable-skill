import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_COMPILER_LIMITS } from "../limits.js";
import { compileRuntimeWorkflow } from "../runtime/admission.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { admitWorkflowData } from "../workflow/value-schema.js";
import { inspectRelease } from "./snapshot.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const pinSchema = z.strictObject({ id: z.uuid(), sha256: hash, revision: hash });
// Exact identities, not labels to trim, URLs to fetch, credentials or authorization.
const sourceSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u);
const messageIdSchema = z.string().regex(/^[\x21-\x7e]{1,256}$/u);
export const releaseMessageIdentitySchema = z.strictObject({ release: pinSchema, source: sourceSchema, messageId: messageIdSchema });
const requestSchema = z.strictObject({ messageId: messageIdSchema, input: z.unknown() });
/** Offline message-entry admission, shared with signed service startup before storage ownership. */
export function inspectMessageRelease(snapshot) {
    const artifact = inspectRelease(snapshot);
    const graph = compileRuntimeWorkflow(artifact.snapshot.workflow.yaml, DEFAULT_COMPILER_LIMITS);
    const entry = graph.nodes[0].plan;
    if (entry.kind !== 'trigger' || !entry.modes.includes('api'))
        throw new WorkflowRuntimeError('invalid-command');
    return artifact;
}
/** Deterministic UUIDv8: an exact release, reviewed sender namespace and stable message ID.
 * Input, delivery time, attempts, credentials and service instance are deliberately excluded.
 * This is identity derivation, never sender authentication or an exactly-once-effect guarantee.
 */
export function releaseMessageRunId(value) {
    const parsed = releaseMessageIdentitySchema.safeParse(value);
    if (!parsed.success)
        throw new WorkflowRuntimeError('invalid-command');
    const { release, source, messageId } = parsed.data;
    const tuple = ['jevable.ai/release-message/v1', release.id.toLowerCase(), release.sha256, release.revision, source, messageId];
    const bytes = createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** Trusted owned SDK adapter for a separately authenticated message consumer.
 * Does not open storage, start a listener, accept signatures, acknowledge a queue, retry,
 * approve, resume, close the owner or turn an uncertain start into success.
 */
export class ReleaseMessageSession {
    runtime;
    artifact;
    source;
    constructor(runtime, snapshot, source) {
        this.runtime = runtime;
        const parsed = sourceSchema.safeParse(source);
        if (!parsed.success || !runtime || typeof runtime.runReleaseAsync !== 'function' || typeof runtime.show !== 'function') {
            throw new WorkflowRuntimeError('invalid-command');
        }
        // Own a validated detached snapshot before any asynchronous operation can retarget it.
        this.artifact = inspectMessageRelease(snapshot);
        this.source = parsed.data;
    }
    get release() {
        return { id: this.artifact.snapshot.id, sha256: this.artifact.sha256, revision: this.artifact.snapshot.workflow.revision };
    }
    runId(messageId) {
        return releaseMessageRunId({ release: this.release, source: this.source, messageId });
    }
    async start(value) {
        const parsed = requestSchema.safeParse(value);
        if (!parsed.success)
            throw new WorkflowRuntimeError('invalid-command');
        // Bound and detach JSON before entering the owned runtime; no coercion or dropped values.
        const input = admitWorkflowData(parsed.data.input, DEFAULT_COMPILER_LIMITS.binding.data);
        const admitted = await this.runtime.runReleaseAsync(this.artifact.snapshot, input, { id: this.runId(parsed.data.messageId), triggerMode: 'api' });
        return { ...admitted, message: { source: this.source, id: parsed.data.messageId } };
    }
    async show(messageId) {
        const id = this.runId(messageId), run = await this.runtime.show(id), pin = this.release;
        if (run.id !== id || run.release?.id !== pin.id || run.release.sha256 !== pin.sha256 || run.revision !== pin.revision
            || run.triggerMode !== 'api' || run.caller !== undefined || run.project !== undefined || run.test !== undefined) {
            throw new WorkflowRuntimeError('not-found');
        }
        return run;
    }
}
