export interface TracePathViewerConfig {
  schemaVersion: 1; origin: string; pathTemplate: string; spanParameter?: 'spanID' | 'spanId' | 'span';
}
export interface GrafanaTempoViewerConfig {
  schemaVersion: 2; kind: 'grafana-tempo-explore'; origin: string; datasourceUid: string; orgId: number;
  range: { from: string; to: string }; pathPrefix?: string;
}
export type TraceViewerConfig = TracePathViewerConfig | GrafanaTempoViewerConfig
export interface TraceReference {
  source: string; traceId: string; spanId: string; traceFlags: 0 | 1; url: string | null;
  nodeId?: string; attemptId?: string; tryId?: string; requestId?: string; loop?: string; iteration?: number; sequence?: string; index?: number;
}

/** Serializable, network-free trace destination and metadata projection. No exporter settings or credentials are read. */
export function traceNavigationTools() {
  const fail = (): never => { throw Error('Invalid trace viewer configuration or retained trace metadata.') }
  const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : fail()
  const text = (value: unknown, max = 4096): string => typeof value === 'string' && value.length > 0 && value.length <= max ? value : fail()
  const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fail()
  const list = (value: unknown): unknown[] => Array.isArray(value) && value.length <= 50000 ? value : fail()
  const uuid = (value: unknown) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(text(value, 36)) ? value as string : fail()
  const trace = (value: unknown) => {
    const t = object(value)
    if (!/^(?!0{32}$)[a-f0-9]{32}$/.test(text(t.traceId, 32)) || !/^(?!0{16}$)[a-f0-9]{16}$/.test(text(t.spanId, 16))
      || t.traceFlags !== 0 && t.traceFlags !== 1) fail()
    return { traceId: t.traceId as string, spanId: t.spanId as string, traceFlags: t.traceFlags as 0 | 1 }
  }
  const config = (value: unknown): TraceViewerConfig => {
    const v = object(value)
    const allowed = v.schemaVersion === 1 ? ['schemaVersion', 'origin', 'pathTemplate', 'spanParameter']
      : v.schemaVersion === 2 ? ['schemaVersion', 'kind', 'origin', 'datasourceUid', 'orgId', 'range', 'pathPrefix'] : fail()
    if (Object.keys(v).some(key => !allowed.includes(key))) fail()
    const origin = text(v.origin, 512)
    if (!/^https?:\/\/[^/]+\/?$/.test(origin) || /[^\x21-\x7e]|[\\%@?#]/.test(origin)) fail()
    let parsed: URL; try { parsed = new URL(origin) } catch { return fail() }
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/'
      || parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/.test(origin))) fail()
    if (v.schemaVersion === 2) {
      if (v.kind !== 'grafana-tempo-explore' || !/^[A-Za-z0-9_-]{1,40}$/.test(text(v.datasourceUid, 40))
        || integer(v.orgId) < 1) fail()
      const range = object(v.range), from = text(range.from, 24), to = text(range.to, 24)
      if (Object.keys(range).some(key => !['from', 'to'].includes(key))) fail()
      const epoch = (value: string) => /^(?:0|[1-9][0-9]{0,15})$/.test(value) && Number(value) <= 8640000000000000
      const absolute = epoch(from) && epoch(to) && Number(from) < Number(to)
      const relative = /^now-[1-9][0-9]{0,5}[smhdw]$/.test(from) && to === 'now'
      if (!absolute && !relative) fail()
      const pathPrefix = v.pathPrefix === undefined ? undefined : text(v.pathPrefix, 256)
      if (pathPrefix !== undefined && (!/^\/[A-Za-z0-9_./-]+$/.test(pathPrefix)
        || pathPrefix.slice(1).split('/').some(part => !part || part === '.' || part === '..'))) fail()
      return { schemaVersion: 2, kind: 'grafana-tempo-explore', origin: parsed.origin,
        datasourceUid: v.datasourceUid as string, orgId: v.orgId as number, range: { from, to },
        ...(pathPrefix === undefined ? {} : { pathPrefix }) }
    }
    const pathTemplate = text(v.pathTemplate, 1024)
    if (!pathTemplate.startsWith('/') || pathTemplate.startsWith('//') || pathTemplate.split('{traceId}').length !== 2
      || !/^\/[A-Za-z0-9_./{}-]+$/.test(pathTemplate) || /[{}]/.test(pathTemplate.replace('{traceId}', 'trace'))
      || pathTemplate.slice(1).split('/').some(part => !part || part === '.' || part === '..')) fail()
    if (v.spanParameter !== undefined && !['spanID', 'spanId', 'span'].includes(v.spanParameter as string)) fail()
    return { schemaVersion: 1, origin: parsed.origin, pathTemplate,
      ...(v.spanParameter === undefined ? {} : { spanParameter: v.spanParameter as TracePathViewerConfig['spanParameter'] & string }) }
  }
  const project = (value: unknown, destination?: TraceViewerConfig) => {
    const viewer = destination === undefined ? undefined : config(destination), snapshot = object(value), run = object(snapshot.run)
    if (![1, 2].includes(snapshot.schemaVersion as number) || snapshot.format !== 'jevable.ai/run-evidence' || 'private' in snapshot) fail()
    const privacy = object(snapshot.privacy)
    if (privacy.payloads !== 'excluded' || privacy.actors !== 'excluded' || privacy.credentialStore !== 'excluded') fail()
    const runId = uuid(run.id), revision = text(run.revision, 64)
    if (!/^[a-f0-9]{64}$/.test(revision) || !['paused', 'waiting', 'executing', 'completed', 'failed', 'cancelled'].includes(run.status as string)) fail()
    const references: TraceReference[] = []
    const context = (value: Record<string, unknown>): Pick<TraceReference, 'nodeId' | 'attemptId' | 'loop' | 'iteration'> => {
      const scope = value.scope == null ? undefined : object(value.scope)
      return { ...(value.nodeId === undefined ? {} : { nodeId: text(value.nodeId) }),
        ...(value.attemptId == null ? {} : { attemptId: uuid(value.attemptId) }),
        ...(scope ? { loop: text(scope.loop), iteration: integer(scope.index) } : {}) }
    }
    const add = (source: string, value: unknown, ctx: Omit<TraceReference, 'source' | 'traceId' | 'spanId' | 'traceFlags' | 'url'> = {}) => {
      if (value === undefined) return
      if (references.length >= 50000) fail()
      const t = trace(value)
      let url: string | null = null
      if (viewer) {
        const target = new URL(viewer.schemaVersion === 1 ? viewer.pathTemplate.replace('{traceId}', t.traceId)
          : (viewer.pathPrefix ?? '') + '/explore', viewer.origin)
        if (target.origin !== viewer.origin) fail()
        if (viewer.schemaVersion === 1) {
          if (viewer.spanParameter) target.searchParams.set(viewer.spanParameter, t.spanId)
        } else {
          const pane = { datasource: viewer.datasourceUid,
            queries: [{ refId: 'A', datasource: { uid: viewer.datasourceUid, type: 'tempo' }, queryType: 'traceql', query: t.traceId }],
            range: viewer.range, panelsState: { trace: { spanId: t.spanId } } }
          target.searchParams.set('schemaVersion', '1')
          target.searchParams.set('panes', JSON.stringify({ a: pane }))
          target.searchParams.set('orgId', String(viewer.orgId))
        }
        url = target.href
      }
      references.push({ source, ...ctx, ...t, url })
    }
    const cancellation = run.cancellation === undefined ? undefined : object(run.cancellation)
    const cancellationParent = cancellation?.traceParent === undefined ? undefined : trace(cancellation.traceParent)
    const cancellationId = cancellation === undefined ? undefined : uuid(cancellation.id)
    if (cancellationParent) add('cancellation-admission', cancellationParent, { requestId: cancellationId! })
    const cause = (value: unknown, operation: unknown) => {
      const c = object(value)
      if (operation !== 'cancel' || c.kind !== 'cancellation' || Object.keys(c).some(key => !['kind', 'requestId', 'parent'].includes(key))
        || uuid(c.requestId) !== cancellationId || !cancellationParent) fail()
      const parent = trace(c.parent)
      if (parent.traceId !== cancellationParent!.traceId || parent.spanId !== cancellationParent!.spanId
        || parent.traceFlags !== cancellationParent!.traceFlags) fail()
      return { parent, requestId: cancellationId! }
    }
    for (const [index, value] of (run.traceSegments === undefined ? [] : list(run.traceSegments)).entries()) {
      const segment = object(value)
      for (const role of ['trace', 'previous', 'parent']) add(`segment-${role}`, segment[role], { index })
      if (segment.cause !== undefined) { const c = cause(segment.cause, segment.operation); add('segment-cause', c.parent, { requestId: c.requestId, index }) }
    }
    if (run.attempt !== undefined) { const attempt = object(run.attempt); add('pending-attempt', attempt.trace, context({ ...attempt, attemptId: attempt.id, scope: run.scope })) }
    if (run.failedAttempt !== undefined) { const attempt = object(run.failedAttempt); add('failed-attempt', attempt.trace, context({ ...attempt, nodeId: run.nodeId, scope: run.scope })) }
    for (const [index, value] of list(snapshot.steps).entries()) { const step = object(value); add('settled-step', step.trace, { ...context(step), index }) }
    for (const value of list(snapshot.journal)) {
      const event = object(value)
      const sequence = typeof event.sequence === 'string' && /^[1-9][0-9]{0,18}$/.test(event.sequence) ? event.sequence
        : typeof event.sequence === 'number' && integer(event.sequence) > 0 ? String(event.sequence) : fail()
      for (const role of ['trace', 'previous', 'parent']) add(`journal-${role}`, event[role], { ...context(event), sequence })
      if (event.cause !== undefined) { const c = cause(event.cause, event.operation); add('journal-cause', c.parent, { requestId: c.requestId, sequence }) }
      if (event.traceParent !== undefined) {
        if (event.kind !== 'cancellation-requested' || uuid(event.requestId) !== cancellationId || !cancellationParent) fail()
        const c = cause({ kind: 'cancellation', requestId: event.requestId, parent: event.traceParent }, 'cancel')
        add('journal-cancellation-admission', c.parent, { requestId: c.requestId, sequence })
      }
    }
    if (snapshot.models !== undefined) {
      const models = object(snapshot.models)
      if (models.format !== 'jevable.model-history/v1' || models.source !== 'configured-model-store') fail()
      for (const value of list(models.calls)) {
        const call = object(value)
        const modelTrace = call.trace === undefined ? undefined : trace(call.trace)
        if (modelTrace && (call.evidence !== 'recorded' || ![1, 2].includes(call.evidenceSchemaVersion as number))) fail()
        add('model-call', modelTrace, context(call))
        for (const value of call.tries === undefined ? [] : list(call.tries)) { const attempt = object(value)
          if (modelTrace && attempt.trace !== undefined) {
            const child = trace(attempt.trace)
            if (child.traceId !== modelTrace.traceId || child.traceFlags !== modelTrace.traceFlags || child.spanId === modelTrace.spanId) fail()
          }
          add('model-try', attempt.trace, { ...context(call), tryId: uuid(attempt.id), index: integer(attempt.number) })
        }
      }
    }
    return { schemaVersion: 1 as const, format: 'jevable.ai/trace-navigation' as const, runId, revision, workflowStatus: run.status as string,
      destination: viewer ?? null, availability: references.length ? 'delivery-unverified' as const : 'trace-context-not-recorded' as const,
      execution: 'not-started-or-resumed' as const, references }
  }
  return { config, project }
}
