import { isDeepStrictEqual } from 'node:util';
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { inspectNotificationRecord } from "./schema.js";
/** Call inside the adapter's atomic admission transaction with the latest record for this event/endpoint pair. */
export function validateNotificationIntent(value, previousValue) {
    const record = inspectNotificationRecord(value);
    if (record.outcome.status !== 'pending')
        throw new WorkflowRuntimeError('conflict');
    const previous = previousValue === undefined ? undefined : inspectNotificationRecord(previousValue);
    if (record.telemetry && !isDeepStrictEqual(record.telemetry.previous, previous?.telemetry?.trace))
        throw new WorkflowRuntimeError('conflict');
    if (!previous) {
        if (record.request.redeliverOf)
            throw new WorkflowRuntimeError('conflict');
    }
    else if (record.request.redeliverOf !== previous.request.requestId
        || record.request.requestId === previous.request.requestId
        || record.request.eventSha256 !== previous.request.eventSha256
        || record.request.endpointId !== previous.request.endpointId
        || record.request.endpointSha256 !== previous.request.endpointSha256
        || record.createdAt < previous.createdAt)
        throw new WorkflowRuntimeError('conflict');
    return record;
}
/** Call under the same atomic owner/CAS guard as persistence. A terminal receipt cannot be retargeted or rewritten. */
export function validateNotificationSettlement(previousValue, value) {
    const previous = inspectNotificationRecord(previousValue), record = inspectNotificationRecord(value);
    const { outcome: priorOutcome, ...before } = previous, { outcome, ...after } = record;
    if (outcome.status !== 'settled' || !isDeepStrictEqual(before, after)
        || priorOutcome.status === 'settled' && !isDeepStrictEqual(priorOutcome, outcome))
        throw new WorkflowRuntimeError('conflict');
    return { record, changed: priorOutcome.status === 'pending' };
}
