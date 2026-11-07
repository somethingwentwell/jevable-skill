/** Serialized, import-free metadata admission. Does not execute, infer dispatch, or authenticate the reported digest. */
export function projectPreviewModelHistory(preview, runId, value) {
    const fail = () => { throw Error('Model history cannot be safely matched to this run and admitted workflow.'); };
    const object = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : fail();
    const text = (v, max = 256) => typeof v === 'string' && v.length > 0 && v.length <= max ? v : fail();
    const integer = (v, min, max) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail();
    const uuid = (v) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(text(v, 36)) ? v : fail();
    const hex = (v, length) => new RegExp(`^[a-f0-9]{${length}}$`).test(text(v, length)) ? v : fail();
    const traceContext = (v) => {
        const r = object(v), traceId = hex(r.traceId, 32), spanId = hex(r.spanId, 16), traceFlags = integer(r.traceFlags, 0, 1);
        if (/^0+$/.test(traceId) || /^0+$/.test(spanId))
            fail();
        return { traceId, spanId, traceFlags };
    };
    const at = (v) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(text(v, 40)) && Number.isFinite(Date.parse(v))
        && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19) ? v : fail();
    const status = (v) => ['pending', 'failed', 'completed'].includes(text(v)) ? v : fail();
    const code = (v) => ['request-too-large', 'response-too-large', 'invalid-response', 'http-error', 'transport-error', 'timeout', 'cancelled'].includes(text(v))
        ? v : fail();
    const envelope = object(value), snapshot = object(envelope.snapshot), run = object(snapshot.run), checksum = object(envelope.checksum);
    if (![1, 2].includes(envelope.schemaVersion) || snapshot.schemaVersion !== envelope.schemaVersion || snapshot.format !== 'jevable.ai/run-evidence'
        || 'private' in snapshot || !preview.revision || preview.validation.status !== 'valid' || uuid(run.id) !== uuid(runId) || run.revision !== preview.revision
        || !['paused', 'waiting', 'executing', 'completed', 'failed', 'cancelled'].includes(text(run.status))
        || checksum.algorithm !== 'sha256' || checksum.encoding !== 'JSON.stringify(snapshot)')
        fail();
    const base = { format: 'jevable.preview-model-history/v1', runId, revision: preview.revision, workflowStatus: run.status,
        checksum: hex(checksum.value, 64) };
    if (snapshot.models === undefined)
        return { ...base, available: false, calls: [] };
    const models = object(snapshot.models);
    if (models.format !== 'jevable.model-history/v1' || models.source !== 'configured-model-store'
        || !Array.isArray(models.calls) || models.calls.length > 50000)
        fail();
    const ids = new Set(), tryIds = new Set();
    const nodes = new Map(preview.graphs.map(graph => [graph.scope, new Set(graph.nodes.filter(item => ['llm', 'decision'].includes(item.node.type)).map(item => item.id))]));
    const calls = models.calls.map(value => {
        const call = object(value), attemptId = uuid(call.attemptId), nodeId = text(call.nodeId, 4096);
        if (ids.has(attemptId))
            fail();
        ids.add(attemptId);
        const scope = call.scope === undefined ? undefined : object(call.scope);
        const loop = scope ? text(scope.loop, 4096) : undefined, iteration = scope ? integer(scope.index, 0, Number.MAX_SAFE_INTEGER) : undefined;
        if (!nodes.get(loop === undefined ? 'workflow' : `workflow/${loop}`)?.has(nodeId))
            fail();
        const identity = { nodeId, attemptId, ...(loop === undefined ? {} : { scope: { loop, index: iteration } }) };
        if (call.evidence === 'not-recorded') {
            if (call.trace !== undefined)
                fail();
            return { ...identity, evidence: 'not-recorded' };
        }
        if (call.evidence !== 'recorded' || ![1, 2].includes(call.evidenceSchemaVersion))
            fail();
        const state = status(call.status), intentAt = at(call.intentAt);
        if (state === 'pending' && call.settledAt !== undefined || state !== 'failed' && call.code !== undefined || state !== 'completed' && call.usage !== undefined)
            fail();
        const outcome = state === 'pending' ? {} : { settledAt: at(call.settledAt), ...(state === 'failed' ? { code: code(call.code) } : {}) };
        let usage;
        if (state === 'completed') {
            const u = object(call.usage);
            usage = { tries: integer(u.tries, 1, 10), ...(u.inputTokens === undefined ? {} : { inputTokens: integer(u.inputTokens, 0, Number.MAX_SAFE_INTEGER) }),
                ...(u.outputTokens === undefined ? {} : { outputTokens: integer(u.outputTokens, 0, Number.MAX_SAFE_INTEGER) }) };
        }
        const common = { ...identity, evidence: 'recorded', evidenceSchemaVersion: call.evidenceSchemaVersion,
            intentAt, status: state, ...outcome, ...(usage ? { usage } : {}), ...(call.trace === undefined ? {} : { trace: traceContext(call.trace) }) };
        if (call.evidenceSchemaVersion === 1) {
            if (call.tries !== undefined || call.policy !== undefined || usage && usage.tries !== 1)
                fail();
            return common;
        }
        const p = object(call.policy);
        if (p.kind !== 'transient-http-v1')
            fail();
        const policy = { kind: 'transient-http-v1', maxAttempts: integer(p.maxAttempts, 2, 10), timeoutSeconds: integer(p.timeoutSeconds, 1, 3600) };
        if (!Array.isArray(call.tries) || !call.tries.length || call.tries.length > policy.maxAttempts)
            fail();
        const spans = new Set(common.trace ? [common.trace.spanId] : []);
        let traceId = common.trace?.traceId, traceFlags = common.trace?.traceFlags;
        const tries = call.tries.map((value, index) => {
            const t = object(value), id = uuid(t.id), number = integer(t.number, 1, 10), state = status(t.status);
            if (state === 'pending' && t.settledAt !== undefined || state !== 'failed' && (t.code !== undefined || t.httpStatus !== undefined || t.scheduledDelayMs !== undefined))
                fail();
            if (number !== index + 1 || tryIds.has(id))
                fail();
            tryIds.add(id);
            let trace;
            if (t.trace !== undefined) {
                const r = object(t.trace), tid = hex(r.traceId, 32), spanId = hex(r.spanId, 16), flags = integer(r.traceFlags, 0, 1);
                if (/^0+$/.test(tid) || /^0+$/.test(spanId) || spans.has(spanId) || traceId !== undefined && (traceId !== tid || traceFlags !== flags))
                    fail();
                spans.add(spanId);
                traceId = tid;
                traceFlags = flags;
                trace = { traceId: tid, spanId, traceFlags: flags };
            }
            const failure = state === 'failed' ? { code: code(t.code), ...(t.httpStatus === undefined ? {} : { httpStatus: integer(t.httpStatus, 100, 599) }),
                ...(t.scheduledDelayMs === undefined ? {} : { scheduledDelayMs: integer(t.scheduledDelayMs, Math.min(2000, 100 * 2 ** index), 3600000) }) } : undefined;
            if (failure && (failure.httpStatus !== undefined && failure.code !== 'http-error'
                || failure.scheduledDelayMs !== undefined && (failure.code !== 'http-error' || ![408, 429, 500, 502, 503, 504].includes(failure.httpStatus ?? 0) || number >= policy.maxAttempts)))
                fail();
            return { id, number, intentAt: at(t.intentAt), status: state, ...(state === 'pending' ? {} : { settledAt: at(t.settledAt) }),
                ...failure, ...(trace ? { trace } : {}) };
        });
        const last = tries.at(-1);
        if (tries[0].intentAt !== intentAt || tries.slice(0, -1).some(t => t.status !== 'failed' || t.scheduledDelayMs === undefined)
            || state === 'pending' && !(last.status === 'pending' || last.status === 'failed' && last.scheduledDelayMs !== undefined)
            || state === 'completed' && !(last.status === 'completed' && last.settledAt === outcome.settledAt && usage?.tries === tries.length)
            || state === 'failed' && !(last.status === 'failed' && (last.scheduledDelayMs === undefined && last.code === outcome.code && last.settledAt === outcome.settledAt
                || last.scheduledDelayMs !== undefined && ['cancelled', 'timeout'].includes(outcome.code ?? ''))))
            fail();
        return { ...common, policy, tries };
    });
    // The browser projection intentionally strips unknown/private fields instead of rendering arbitrary server JSON.
    return { ...base, available: true, calls: calls };
}
