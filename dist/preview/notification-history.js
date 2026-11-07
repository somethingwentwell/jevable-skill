/** Serialized, import-free metadata admission. Never owner-wide history, private events or dispatch. */
export function projectPreviewNotificationHistory(scope, page, value) {
    const fail = () => { throw Error('Notification history cannot be safely matched to this preview project.'); };
    const object = (value, fields) => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)))
            fail();
        return value;
    };
    const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max ? value : fail();
    const integer = (value, min, max) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail();
    const uuid = (value) => {
        const s = text(value, 36);
        return /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/iu.test(s) ? s : fail();
    };
    const hex = (value, length) => new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(text(value, length)) ? value : fail();
    const at = (value) => {
        const s = text(value, 128);
        if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(s) || !Number.isFinite(Date.parse(s))
            || new Date(s).toISOString().slice(0, 19) !== s.slice(0, 19))
            fail();
        return s;
    };
    const filterValue = (value) => {
        if (value === undefined)
            return undefined;
        const f = object(value, ['outcome', 'eventKind', 'createdFrom', 'createdBefore']);
        const outcome = f.outcome === undefined ? undefined : text(f.outcome, 16);
        const eventKind = f.eventKind === undefined ? undefined : text(f.eventKind, 16);
        if (outcome !== undefined && !['pending', 'accepted', 'rejected', 'uncertain'].includes(outcome)
            || eventKind !== undefined && !['requested', 'decided', 'expired', 'cancelled'].includes(eventKind))
            fail();
        const bound = (value) => {
            if (value === undefined)
                return undefined;
            const s = at(value);
            if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(s) || new Date(s).toISOString() !== s)
                fail();
            return s;
        };
        const createdFrom = bound(f.createdFrom), createdBefore = bound(f.createdBefore);
        if (createdFrom !== undefined && createdBefore !== undefined && Date.parse(createdFrom) >= Date.parse(createdBefore))
            fail();
        const filter = { ...(outcome === undefined ? {} : { outcome: outcome }),
            ...(eventKind === undefined ? {} : { eventKind: eventKind }),
            ...(createdFrom === undefined ? {} : { createdFrom }), ...(createdBefore === undefined ? {} : { createdBefore }) };
        if (!Object.keys(filter).length)
            fail();
        return filter;
    };
    const expected = object(scope, ['id', 'generation', 'revision']), requested = object(page, ['after', 'limit', 'filter']);
    const pin = { id: uuid(expected.id), generation: integer(expected.generation, 1, Number.MAX_SAFE_INTEGER), revision: hex(expected.revision, 64) };
    const limit = requested.limit === undefined ? 100 : integer(requested.limit, 1, 200);
    const filter = filterValue(requested.filter);
    let previous = requested.after === undefined ? undefined : uuid(requested.after);
    const envelope = object(value, ['schemaVersion', 'project', 'deliveries', 'nextCursor', 'order', 'consistency', 'semantics', 'filter']);
    if (JSON.stringify(filterValue(envelope.filter)) !== JSON.stringify(filter))
        fail();
    const reported = object(envelope.project, ['id', 'generation', 'revision']);
    if (reported.id !== pin.id || reported.generation !== pin.generation || reported.revision !== pin.revision || envelope.schemaVersion !== 1
        || envelope.order !== 'request-id-ascending' || envelope.consistency !== 'live-keyset; not-a-snapshot'
        || envelope.semantics !== 'pending-is-not-proof-of-dispatch; HTTP-acceptance-is-not-human-delivery-or-approval'
        || !Array.isArray(envelope.deliveries) || envelope.deliveries.length > limit)
        fail();
    const deliveries = envelope.deliveries.map(value => {
        const row = object(value, ['request', 'createdAt', 'outcome', 'trace']);
        const r = object(row.request, ['requestId', 'runId', 'revision', 'attemptId', 'endpointId', 'endpointSha256', 'eventSha256', 'eventKind', 'redeliverOf']);
        const requestId = uuid(r.requestId), endpointId = text(r.endpointId, 128), createdAt = at(row.createdAt);
        if (previous !== undefined && requestId <= previous || r.revision !== pin.revision || !/^[A-Za-z][A-Za-z0-9._/-]{0,127}$/u.test(endpointId))
            fail();
        previous = requestId;
        const eventKind = r.eventKind === undefined ? undefined : text(r.eventKind, 16);
        if (eventKind !== undefined && !['requested', 'decided', 'expired', 'cancelled'].includes(eventKind))
            fail();
        const redeliverOf = r.redeliverOf === undefined ? undefined : uuid(r.redeliverOf);
        if (redeliverOf === requestId)
            fail();
        const request = { requestId, runId: uuid(r.runId), revision: pin.revision, attemptId: uuid(r.attemptId), endpointId,
            endpointSha256: hex(r.endpointSha256, 64), eventSha256: hex(r.eventSha256, 64),
            ...(eventKind === undefined ? {} : { eventKind: eventKind }),
            ...(redeliverOf === undefined ? {} : { redeliverOf }) };
        let outcome;
        const o = object(row.outcome, ['status', 'at', 'result']);
        if (o.status === 'pending') {
            object(o, ['status']);
            outcome = { status: 'pending' };
        }
        else if (o.status === 'settled') {
            const settledAt = at(o.at), result = object(o.result, ['status', 'httpStatus', 'reason']);
            if (Date.parse(settledAt) < Date.parse(createdAt))
                fail();
            if (result.status === 'accepted' || result.status === 'rejected') {
                object(result, ['status', 'httpStatus']);
                outcome = { status: 'settled', at: settledAt, result: { status: result.status,
                        httpStatus: integer(result.httpStatus, result.status === 'accepted' ? 200 : 300, result.status === 'accepted' ? 299 : 599) } };
            }
            else if (result.status === 'uncertain') {
                object(result, ['status', 'reason']);
                if (!['transport', 'timeout', 'aborted', 'invalid-response'].includes(text(result.reason, 32)))
                    fail();
                outcome = { status: 'settled', at: settledAt, result: { status: 'uncertain', reason: result.reason } };
            }
            else
                return fail();
        }
        else
            return fail();
        if (filter && (filter.outcome !== undefined && filter.outcome !== (outcome.status === 'pending' ? 'pending' : outcome.result.status)
            || filter.eventKind !== undefined && filter.eventKind !== (eventKind ?? 'requested')
            || filter.createdFrom !== undefined && Date.parse(createdAt) < Date.parse(filter.createdFrom)
            || filter.createdBefore !== undefined && Date.parse(createdAt) >= Date.parse(filter.createdBefore)))
            fail();
        let trace;
        if (row.trace !== undefined) {
            const t = object(row.trace, ['traceId', 'spanId', 'traceFlags']), traceId = hex(t.traceId, 32), spanId = hex(t.spanId, 16);
            if (/^0+$/u.test(traceId) || /^0+$/u.test(spanId))
                fail();
            trace = { traceId, spanId, traceFlags: integer(t.traceFlags, 0, 1) };
        }
        return { request, createdAt, outcome, ...(trace ? { trace } : {}) };
    });
    const nextCursor = envelope.nextCursor === null ? null : uuid(envelope.nextCursor);
    if (nextCursor !== null && (deliveries.length !== limit || nextCursor !== previous))
        fail();
    return { schemaVersion: 1, project: pin, deliveries, nextCursor, ...(filter ? { filter } : {}), order: 'request-id-ascending', consistency: 'live-keyset; not-a-snapshot',
        semantics: 'pending-is-not-proof-of-dispatch; HTTP-acceptance-is-not-human-delivery-or-approval' };
}
