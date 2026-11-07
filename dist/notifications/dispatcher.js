import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { approvalNotificationEventSchema, approvalNotificationPinSchema, notificationEndpointSchema, notificationRequestSchema, inspectNotificationRecord, notificationReceipt, notificationSha256, notificationAbortSemantics, notificationRequiresLiveWait, notificationWaitExpired, notificationRequestPin } from "./schema.js";
import { notificationSigningKey, postApprovalNotification } from "./transport.js";
/** Internal shared engine; persistence adapters and operator-facing API/CLI integration remain separate. */
export class ApprovalNotificationDispatcher {
    host;
    persistence;
    endpoints = new Map();
    active = new Map();
    maxInFlight;
    constructor(host, persistence, values, limits = {}) {
        this.host = host;
        this.persistence = persistence;
        const policy = z.strictObject({ maxInFlight: z.number().int().min(1).max(64).default(16) }).safeParse(limits);
        if (!policy.success)
            throw new WorkflowRuntimeError('invalid-command');
        this.maxInFlight = policy.data.maxInFlight;
        if (!Array.isArray(values) || values.length > 32)
            throw new WorkflowRuntimeError('invalid-command');
        for (const value of values) {
            const parsed = notificationEndpointSchema.safeParse(value);
            if (!parsed.success || this.endpoints.has(parsed.data.id))
                throw new WorkflowRuntimeError('invalid-command');
            this.endpoints.set(parsed.data.id, parsed.data);
        }
    }
    endpoint(id) {
        const endpoint = this.endpoints.get(id);
        if (!endpoint)
            throw new WorkflowRuntimeError('not-found');
        return endpoint;
    }
    destinations() {
        return [...this.endpoints.values()].map(endpoint => ({ id: endpoint.id, endpointSha256: notificationSha256(endpoint) }));
    }
    async event(pin) {
        const parsed = approvalNotificationEventSchema.safeParse(await this.host.requested(pin));
        if (!parsed.success)
            throw new WorkflowRuntimeError('corrupt');
        const event = parsed.data, { source, type, time, data } = event;
        if (data.runId !== pin.runId || data.revision !== pin.revision || data.attemptId !== pin.attemptId
            || type !== `ai.jevable.approval.${pin.eventKind ?? 'requested'}`
            || event.id !== notificationSha256({ source, type, time, data }))
            throw new WorkflowRuntimeError('corrupt');
        return event;
    }
    /** Preparation is read-only and does not resolve credentials, dispatch, settle expiry or authorize sending. */
    async prepare(pinValue, endpointId) {
        const parsed = approvalNotificationPinSchema.safeParse(pinValue);
        if (!parsed.success)
            throw new WorkflowRuntimeError('invalid-command');
        const pin = notificationRequestPin(parsed.data), endpoint = this.endpoint(endpointId), event = await this.event(pin);
        return { ...pin, endpointId, endpointSha256: notificationSha256(endpoint), eventSha256: notificationSha256(event), event,
            delivery: 'not-attempted' };
    }
    async inspect(requestId) {
        if (!notificationRequestSchema.shape.requestId.safeParse(requestId).success)
            throw new WorkflowRuntimeError('invalid-command');
        const value = await this.persistence.get(requestId);
        if (value === undefined)
            throw new WorkflowRuntimeError('not-found');
        const record = inspectNotificationRecord(value);
        if (record.request.requestId !== requestId)
            throw new WorkflowRuntimeError('corrupt');
        return notificationReceipt(record);
    }
    /** Signal one currently owned delivery; retained pending intents after restart are not repaired or settled. */
    async abort(requestId) {
        const receipt = await this.inspect(requestId);
        const controller = receipt.outcome.status === 'pending' ? this.active.get(requestId) : undefined;
        controller?.abort();
        return { schemaVersion: 1, requestId, status: controller ? 'abort-requested' : 'not-active', receipt,
            semantics: notificationAbortSemantics };
    }
    /** Explicit initial send or redelivery. Identical IDs read receipts, even after expiry or configuration removal. */
    async send(value, actor, options = {}) {
        const signals = [this.host.signal, options.signal].filter((signal) => signal !== undefined);
        if (signals.some(signal => !(signal instanceof AbortSignal)))
            throw new WorkflowRuntimeError('invalid-command');
        const controller = new AbortController();
        const signal = AbortSignal.any([...signals, controller.signal]);
        const parsed = notificationRequestSchema.safeParse(value);
        if (!parsed.success || typeof actor !== 'string' || !actor.length || actor.length > 256
            || parsed.data.redeliverOf === parsed.data.requestId)
            throw new WorkflowRuntimeError('invalid-command');
        // SDK optional undefined fields have no JSON wire/storage representation. Clone, never mutate the caller.
        const request = { ...parsed.data };
        if (request.eventKind === undefined)
            delete request.eventKind;
        if (request.redeliverOf === undefined)
            delete request.redeliverOf;
        const existing = await this.persistence.get(request.requestId);
        if (existing !== undefined) {
            const record = inspectNotificationRecord(existing);
            if (!isDeepStrictEqual(record.request, request) || record.actor !== actor)
                throw new WorkflowRuntimeError('conflict');
            return record;
        }
        if (signal?.aborted)
            throw new WorkflowRuntimeError('closed');
        const endpoint = this.endpoint(request.endpointId);
        if (notificationSha256(endpoint) !== request.endpointSha256)
            throw new WorkflowRuntimeError('conflict');
        let previous;
        if (request.redeliverOf) {
            if (this.active.has(request.redeliverOf))
                throw new WorkflowRuntimeError('busy');
            const value = await this.persistence.get(request.redeliverOf);
            if (value === undefined)
                throw new WorkflowRuntimeError('not-found');
            const record = inspectNotificationRecord(value);
            if (record.request.requestId !== request.redeliverOf || record.request.eventSha256 !== request.eventSha256
                || record.request.endpointSha256 !== request.endpointSha256 || record.request.endpointId !== request.endpointId)
                throw new WorkflowRuntimeError('conflict');
            previous = record;
        }
        const credential = await this.host.credential(endpoint.credentialRef);
        if (!credential || typeof credential.value !== 'string' || !Number.isSafeInteger(credential.generation) || credential.generation < 1)
            throw new WorkflowRuntimeError('invalid-command');
        const { value: secret, generation: credentialGeneration } = credential;
        notificationSigningKey(secret).fill(0);
        // Resolve after credential access so live wait or retained lifecycle evidence is checked close to admission.
        const event = await this.event({ runId: request.runId, revision: request.revision, attemptId: request.attemptId,
            ...(request.eventKind === undefined ? {} : { eventKind: request.eventKind }) });
        if (notificationSha256(event) !== request.eventSha256
            || notificationRequiresLiveWait(event) && notificationWaitExpired(event))
            throw new WorkflowRuntimeError('conflict');
        if (signal?.aborted)
            throw new WorkflowRuntimeError('closed');
        let record = inspectNotificationRecord({ schemaVersion: 1, request, event, actor, credentialGeneration,
            createdAt: new Date().toISOString(), outcome: { status: 'pending' } });
        if (this.active.size >= this.maxInFlight || this.active.has(request.requestId)
            || request.redeliverOf && this.active.has(request.redeliverOf))
            throw new WorkflowRuntimeError('busy');
        this.active.set(request.requestId, controller);
        let observation;
        const observed = { outcome: 'intent-not-acknowledged', intentAcknowledged: false, transportAttempted: false, settlementAcknowledged: false };
        try {
            observation = await this.host.observeNotification?.(record, previous);
            if (observation)
                record = inspectNotificationRecord({ ...record, telemetry: observation.telemetry });
            if (!await this.persistence.createIntent(structuredClone(record))) {
                const saved = inspectNotificationRecord(await this.persistence.get(request.requestId));
                if (!isDeepStrictEqual(saved.request, request) || saved.actor !== actor)
                    throw new WorkflowRuntimeError('conflict');
                observed.outcome = 'receipt-only';
                return saved;
            }
            observed.intentAcknowledged = true;
            observed.outcome = 'settlement-not-acknowledged';
            // A failed/uncertain intent acknowledgement exits above without any request. A retained pending row is never replayed.
            observed.transportAttempted = true;
            const result = await postApprovalNotification(endpoint, event, secret, signal);
            if (result.status === 'uncertain')
                observed.reason = result.reason;
            else
                observed.httpStatus = result.httpStatus;
            const settled = inspectNotificationRecord({ ...record, outcome: { status: 'settled', at: new Date().toISOString(), result } });
            await this.persistence.settle(structuredClone(settled));
            observed.settlementAcknowledged = true;
            observed.outcome = result.status;
            return settled;
        }
        finally {
            // Diagnostics never replace a durable result/error, or strand the dispatcher's active guard.
            try {
                observation?.finish(observed);
            }
            catch { /* Instrumentation is best effort; never retry delivery. */ }
            finally {
                this.active.delete(request.requestId);
            }
        }
    }
}
