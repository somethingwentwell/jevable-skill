import type { WorkflowPreview } from './model.ts'
import type { ModelCallEvidence } from '../runtime/model-evidence.ts'

export interface PreviewModelHistory {
  format: 'jevable.preview-model-history/v1'; runId: string; revision: string; workflowStatus: string;
  available: boolean; checksum: string; calls: ModelCallEvidence[]
}

/** Serialized, import-free metadata admission. Does not execute, infer dispatch, or authenticate the reported digest. */
export function projectPreviewModelHistory(preview: WorkflowPreview, runId: string, value: unknown): PreviewModelHistory {
  const fail = (): never => { throw Error('Model history cannot be safely matched to this run and admitted workflow.') }
  const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail()
  const text = (v: unknown, max = 256): string => typeof v === 'string' && v.length > 0 && v.length <= max ? v : fail()
  const integer = (v: unknown, min: number, max: number): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail()
  const uuid = (v: unknown) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(text(v, 36)) ? v as string : fail()
  const hex = (v: unknown, length: number) => new RegExp(`^[a-f0-9]{${length}}$`).test(text(v, length)) ? v as string : fail()
  const traceContext = (v: unknown) => {
    const r = object(v), traceId = hex(r.traceId, 32), spanId = hex(r.spanId, 16), traceFlags = integer(r.traceFlags, 0, 1)
    if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) fail()
    return { traceId, spanId, traceFlags }
  }
  const at = (v: unknown) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(text(v, 40)) && Number.isFinite(Date.parse(v as string))
    && new Date(v as string).toISOString().slice(0, 19) === (v as string).slice(0, 19) ? v as string : fail()
  const status = (v: unknown) => ['pending', 'failed', 'completed'].includes(text(v)) ? v as 'pending' | 'failed' | 'completed' : fail()
  const code = (v: unknown) => ['request-too-large', 'response-too-large', 'invalid-response', 'http-error', 'transport-error', 'timeout', 'cancelled'].includes(text(v))
    ? v as 'request-too-large' | 'response-too-large' | 'invalid-response' | 'http-error' | 'transport-error' | 'timeout' | 'cancelled' : fail()
  const envelope = object(value), snapshot = object(envelope.snapshot), run = object(snapshot.run), checksum = object(envelope.checksum)
  if (![1, 2].includes(envelope.schemaVersion as number) || snapshot.schemaVersion !== envelope.schemaVersion || snapshot.format !== 'jevable.ai/run-evidence'
    || 'private' in snapshot || !preview.revision || preview.validation.status !== 'valid' || uuid(run.id) !== uuid(runId) || run.revision !== preview.revision
    || !['paused', 'waiting', 'executing', 'completed', 'failed', 'cancelled'].includes(text(run.status))
    || checksum.algorithm !== 'sha256' || checksum.encoding !== 'JSON.stringify(snapshot)') fail()
  const base = { format: 'jevable.preview-model-history/v1' as const, runId, revision: preview.revision!, workflowStatus: run.status as string,
    checksum: hex(checksum.value, 64) }
  if (snapshot.models === undefined) return { ...base, available: false, calls: [] }
  const models = object(snapshot.models)
  if (models.format !== 'jevable.model-history/v1' || models.source !== 'configured-model-store'
    || !Array.isArray(models.calls) || models.calls.length > 50000) fail()
  const ids = new Set<string>(), tryIds = new Set<string>()
  const nodes = new Map(preview.graphs.map(graph => [graph.scope, new Set(graph.nodes.filter(item => ['llm', 'decision'].includes(item.node.type)).map(item => item.id))]))
  const calls = (models.calls as unknown[]).map(value => {
    const call = object(value), attemptId = uuid(call.attemptId), nodeId = text(call.nodeId, 4096)
    if (ids.has(attemptId)) fail(); ids.add(attemptId)
    const scope = call.scope === undefined ? undefined : object(call.scope)
    const loop = scope ? text(scope.loop, 4096) : undefined, iteration = scope ? integer(scope.index, 0, Number.MAX_SAFE_INTEGER) : undefined
    if (!nodes.get(loop === undefined ? 'workflow' : `workflow/${loop}`)?.has(nodeId)) fail()
    const identity = { nodeId, attemptId, ...(loop === undefined ? {} : { scope: { loop, index: iteration! } }) }
    if (call.evidence === 'not-recorded') {
      if (call.trace !== undefined) fail()
      return { ...identity, evidence: 'not-recorded' as const }
    }
    if (call.evidence !== 'recorded' || ![1, 2].includes(call.evidenceSchemaVersion as number)) fail()
    const state = status(call.status), intentAt = at(call.intentAt)
    if (state === 'pending' && call.settledAt !== undefined || state !== 'failed' && call.code !== undefined || state !== 'completed' && call.usage !== undefined) fail()
    const outcome: { settledAt?: string; code?: ReturnType<typeof code> } = state === 'pending' ? {} : { settledAt: at(call.settledAt), ...(state === 'failed' ? { code: code(call.code) } : {}) }
    let usage
    if (state === 'completed') {
      const u = object(call.usage)
      usage = { tries: integer(u.tries, 1, 10), ...(u.inputTokens === undefined ? {} : { inputTokens: integer(u.inputTokens, 0, Number.MAX_SAFE_INTEGER) }),
        ...(u.outputTokens === undefined ? {} : { outputTokens: integer(u.outputTokens, 0, Number.MAX_SAFE_INTEGER) }) }
    }
    const common = { ...identity, evidence: 'recorded' as const, evidenceSchemaVersion: call.evidenceSchemaVersion as 1 | 2,
      intentAt, status: state, ...outcome, ...(usage ? { usage } : {}), ...(call.trace === undefined ? {} : { trace: traceContext(call.trace) }) }
    if (call.evidenceSchemaVersion === 1) {
      if (call.tries !== undefined || call.policy !== undefined || usage && usage.tries !== 1) fail()
      return common
    }
    const p = object(call.policy)
    if (p.kind !== 'transient-http-v1') fail()
    const policy = { kind: 'transient-http-v1' as const, maxAttempts: integer(p.maxAttempts, 2, 10), timeoutSeconds: integer(p.timeoutSeconds, 1, 3600) }
    if (!Array.isArray(call.tries) || !call.tries.length || call.tries.length > policy.maxAttempts) fail()
    const spans = new Set<string>(common.trace ? [common.trace.spanId] : [])
    let traceId: string | undefined = common.trace?.traceId, traceFlags: number | undefined = common.trace?.traceFlags
    const tries = (call.tries as unknown[]).map((value, index) => {
      const t = object(value), id = uuid(t.id), number = integer(t.number, 1, 10), state = status(t.status)
      if (state === 'pending' && t.settledAt !== undefined || state !== 'failed' && (t.code !== undefined || t.httpStatus !== undefined || t.scheduledDelayMs !== undefined)) fail()
      if (number !== index + 1 || tryIds.has(id)) fail(); tryIds.add(id)
      let trace
      if (t.trace !== undefined) {
        const r = object(t.trace), tid = hex(r.traceId, 32), spanId = hex(r.spanId, 16), flags = integer(r.traceFlags, 0, 1)
        if (/^0+$/.test(tid) || /^0+$/.test(spanId) || spans.has(spanId) || traceId !== undefined && (traceId !== tid || traceFlags !== flags)) fail()
        spans.add(spanId); traceId = tid; traceFlags = flags; trace = { traceId: tid, spanId, traceFlags: flags }
      }
      const failure = state === 'failed' ? { code: code(t.code), ...(t.httpStatus === undefined ? {} : { httpStatus: integer(t.httpStatus, 100, 599) }),
        ...(t.scheduledDelayMs === undefined ? {} : { scheduledDelayMs: integer(t.scheduledDelayMs, Math.min(2000, 100 * 2 ** index), 3600000) }) } : undefined
      if (failure && (failure.httpStatus !== undefined && failure.code !== 'http-error'
        || failure.scheduledDelayMs !== undefined && (failure.code !== 'http-error' || ![408, 429, 500, 502, 503, 504].includes(failure.httpStatus ?? 0) || number >= policy.maxAttempts))) fail()
      return { id, number, intentAt: at(t.intentAt), status: state, ...(state === 'pending' ? {} : { settledAt: at(t.settledAt) }),
        ...failure, ...(trace ? { trace } : {}) }
    })
    const last = tries.at(-1)!
    if (tries[0]!.intentAt !== intentAt || tries.slice(0, -1).some(t => t.status !== 'failed' || t.scheduledDelayMs === undefined)
      || state === 'pending' && !(last.status === 'pending' || last.status === 'failed' && last.scheduledDelayMs !== undefined)
      || state === 'completed' && !(last.status === 'completed' && last.settledAt === outcome.settledAt && usage?.tries === tries.length)
      || state === 'failed' && !(last.status === 'failed' && (last.scheduledDelayMs === undefined && last.code === outcome.code && last.settledAt === outcome.settledAt
        || last.scheduledDelayMs !== undefined && ['cancelled', 'timeout'].includes(outcome.code ?? '')))) fail()
    return { ...common, policy, tries }
  })
  // The browser projection intentionally strips unknown/private fields instead of rendering arbitrary server JSON.
  return { ...base, available: true, calls: calls as ModelCallEvidence[] }
}
