import type { UsageReport, UsageSelection } from '../evidence/usage.ts'

export type PreviewUsageQuery = { runId: string; revision: string; window?: { from: string; before: string }; groupBy?: 'provider' | 'provider-model' }
export type PreviewUsage = { schemaVersion: 1; format: 'jevable.ai/preview-usage'; selection: UsageSelection; selectionSha256: string;
  run: Omit<UsageReport['runs'][number], 'calls' | 'summary' | 'groups' | 'windowCoverage'>;
  summary: UsageReport['summary']; windowCoverage?: UsageReport['windowCoverage']; groups?: UsageReport['groups'] }

/** Import-free browser admission. Checks scope/accounting shape, not provider bills or independent journal authenticity. */
export function previewUsageTools() {
  const fail = (): never => { throw Error('Usage cannot be safely matched to this selected run.') }
  const object = (v: unknown, keys: string[]) => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) fail()
    return v as Record<string, any>
  }
  const count = (v: unknown, max = 100000) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max ? v : fail()
  const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v) ? v : fail()
  const instant = (v: unknown, exact = false) => {
    if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(v) || !Number.isFinite(Date.parse(v))
      || new Date(v).toISOString().slice(0, 19) !== v.slice(0, 19) || exact && new Date(v).toISOString() !== v) fail()
    return v as string
  }
  const query = (v: PreviewUsageQuery) => {
    object(v, ['runId', 'revision', 'window', 'groupBy'])
    if (typeof v.runId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(v.runId)) fail()
    hash(v.revision)
    if (v.groupBy !== undefined && !['provider', 'provider-model'].includes(v.groupBy)) fail()
    let window
    if (v.window !== undefined) {
      const w = object(v.window, ['from', 'before']), from = instant(w.from, true), before = instant(w.before, true)
      if (Date.parse(from) >= Date.parse(before)) fail()
      window = { from, before }
    }
    return { schemaVersion: 1 as const, runs: [{ id: v.runId.toLowerCase(), revision: v.revision }],
      ...(window ? { window } : {}), ...(v.groupBy ? { groupBy: v.groupBy } : {}) }
  }
  const summary = (v: unknown, unlocated: number) => {
    const keys = ['modelIntents', 'unavailableHistories', 'unrecordedCalls', 'completedCalls', 'failedCalls', 'pendingCalls', 'recordedTries', 'failedOrPendingTries'] as const
    const s = object(v, [...keys, 'inputTokens', 'outputTokens']), values = {} as Pick<UsageReport['summary'], typeof keys[number]>
    for (const key of keys) values[key] = count(s[key], key === 'unavailableHistories' ? 1 : key.includes('Tries') ? 100000 : 10000)
    const recordedCalls = values.completedCalls + values.failedCalls + values.pendingCalls
    if (values.modelIntents !== values.unrecordedCalls! + values.completedCalls! + values.failedCalls! + values.pendingCalls!
      || values.recordedTries < recordedCalls || values.recordedTries > recordedCalls * 10
      // Each completed call has exactly one successful final try; all other retained tries are failed/pending.
      || values.failedOrPendingTries !== values.recordedTries - values.completedCalls
      || values.unavailableHistories !== 0 && (values.modelIntents !== 0 || unlocated !== 0)) fail()
    const token = (v: unknown) => {
      const t = object(v, ['reportedTokens', 'reportingCalls', 'completedCallsWithoutField', 'coverage'])
      const reportingCalls = count(t.reportingCalls, values.completedCalls), missing = count(t.completedCallsWithoutField, values.completedCalls)
      if (reportingCalls + missing !== values.completedCalls) fail()
      const complete = unlocated === 0 && values.unavailableHistories === 0 && values.unrecordedCalls === 0 && values.failedOrPendingTries === 0
        && values.pendingCalls === 0 && values.failedCalls === 0 && missing === 0
      const coverage: UsageReport['summary']['inputTokens']['coverage'] = complete ? 'complete-for-observed-intents' : reportingCalls ? 'partial' : 'unavailable'
      if (t.coverage !== coverage || t.reportedTokens !== null && (typeof t.reportedTokens !== 'string' || !/^(?:0|[1-9]\d{0,19})$/u.test(t.reportedTokens))) fail()
      if ((reportingCalls > 0 || complete) !== (t.reportedTokens !== null) || reportingCalls === 0 && complete && t.reportedTokens !== '0') fail()
      if (t.reportedTokens !== null && BigInt(t.reportedTokens) > BigInt(reportingCalls) * BigInt(Number.MAX_SAFE_INTEGER)) fail()
      return { reportedTokens: t.reportedTokens as string | null, reportingCalls, completedCallsWithoutField: missing, coverage }
    }
    return { ...values, inputTokens: token(s.inputTokens), outputTokens: token(s.outputTokens) }
  }
  const admit = async (expected: PreviewUsageQuery, value: unknown): Promise<PreviewUsage> => {
    const selection = query(expected), encoded = JSON.stringify(value)
    if (!encoded || new TextEncoder().encode(encoded).byteLength > 8_000_000) fail()
    const v = object(JSON.parse(encoded), ['schemaVersion', 'format', 'selection', 'selectionSha256', 'run', 'summary', 'windowCoverage', 'groups'])
    if (v.schemaVersion !== 1 || v.format !== 'jevable.ai/preview-usage' || JSON.stringify(v.selection) !== JSON.stringify(selection)) fail()
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(selection))))]
      .map(b => b.toString(16).padStart(2, '0')).join('')
    if (hash(v.selectionSha256) !== digest) fail()
    const r = object(v.run, ['id', 'revision', 'workflowStatus', 'observedRunUpdatedAt', 'snapshotSha256', 'modelHistory'])
    if (r.id !== selection.runs[0]!.id || r.revision !== selection.runs[0]!.revision || !['paused', 'executing', 'waiting', 'completed', 'failed', 'cancelled'].includes(r.workflowStatus)
      || !['recorded', 'unavailable'].includes(r.modelHistory)) fail()
    instant(r.observedRunUpdatedAt); hash(r.snapshotSha256)
    let windowCoverage: PreviewUsage['windowCoverage']
    if (selection.window) {
      const w = object(v.windowCoverage, ['observedModelIntents', 'outsideWindow', 'unlocatedModelIntents'])
      windowCoverage = { observedModelIntents: count(w.observedModelIntents, 10000), outsideWindow: count(w.outsideWindow, 10000), unlocatedModelIntents: count(w.unlocatedModelIntents, 10000) }
    } else if (v.windowCoverage !== undefined) fail()
    const total = summary(v.summary, windowCoverage?.unlocatedModelIntents ?? 0)
    if (windowCoverage && total.modelIntents! + windowCoverage.outsideWindow + windowCoverage.unlocatedModelIntents !== windowCoverage.observedModelIntents) fail()
    if (total.unavailableHistories !== (r.modelHistory === 'unavailable' ? 1 : 0)
      || r.modelHistory === 'unavailable' && (total.modelIntents !== 0 || windowCoverage && windowCoverage.observedModelIntents !== 0)) fail()
    let groups: PreviewUsage['groups']
    if (selection.groupBy) {
      if (!Array.isArray(v.groups) || v.groups.length > 1000) fail()
      let previous = ''
      groups = v.groups.map((raw: unknown) => {
        const g = object(raw, ['key', 'summary', 'unlocatedModelIntents']), key = object(g.key, selection.groupBy === 'provider' ? ['provider'] : ['provider', 'model'])
        const identity = (v: unknown) => v === null || typeof v === 'string' && v.length > 0 && v.length <= 256 && v.trim() === v ? v as string | null : fail()
        const cleanKey = { provider: identity(key.provider), ...(selection.groupBy === 'provider-model' ? { model: identity(key.model) } : {}) }
        if (selection.groupBy === 'provider-model' && (cleanKey.provider === null) !== (cleanKey.model === null)) fail()
        const encoded = JSON.stringify(cleanKey); if (encoded <= previous) fail(); previous = encoded
        const unlocatedModelIntents = count(g.unlocatedModelIntents, 10000)
        const counts = summary(g.summary, unlocatedModelIntents)
        if (counts.modelIntents + counts.unavailableHistories + unlocatedModelIntents === 0
          || cleanKey.provider === null && counts.completedCalls + counts.failedCalls + counts.pendingCalls !== 0
          || cleanKey.provider !== null && (counts.unrecordedCalls !== 0 || counts.unavailableHistories !== 0)) fail()
        return { key: cleanKey, summary: counts, unlocatedModelIntents }
      }) as PreviewUsage['groups']
      for (const key of ['modelIntents', 'unavailableHistories', 'unrecordedCalls', 'completedCalls', 'failedCalls', 'pendingCalls', 'recordedTries', 'failedOrPendingTries'] as const)
        if (groups!.reduce((sum, g) => sum + g.summary[key], 0) !== total[key]) fail()
      if (groups!.reduce((sum, g) => sum + g.unlocatedModelIntents, 0) !== (windowCoverage?.unlocatedModelIntents ?? 0)) fail()
      for (const key of ['inputTokens', 'outputTokens'] as const) {
        if (groups!.reduce((sum, g) => sum + g.summary[key].reportingCalls, 0) !== total[key].reportingCalls) fail()
        if (total[key].reportedTokens !== null && groups!.reduce((sum, g) => sum + BigInt(g.summary[key].reportedTokens ?? '0'), 0n).toString() !== total[key].reportedTokens) fail()
      }
    } else if (v.groups !== undefined) fail()
    return { schemaVersion: 1, format: 'jevable.ai/preview-usage', selection, selectionSha256: digest,
      run: { id: r.id, revision: r.revision, workflowStatus: r.workflowStatus, observedRunUpdatedAt: r.observedRunUpdatedAt, snapshotSha256: r.snapshotSha256, modelHistory: r.modelHistory },
      summary: total as UsageReport['summary'], ...(windowCoverage ? { windowCoverage } : {}), ...(groups ? { groups } : {}) }
  }
  return { query, admit }
}

/** Only the selected run's checked report summary leaves the preview owner; detailed calls stay in existing evidence views. */
export async function projectPreviewUsage(expected: PreviewUsageQuery, raw: unknown) {
  const report = raw as UsageReport, tools = previewUsageTools()
  if (!report || report.format !== 'jevable.ai/usage-report' || report.execution !== 'not-started-or-resumed'
    || report.billing !== 'not-estimated; not-provider-account-totals' || !Array.isArray(report.runs) || report.runs.length !== 1
    || JSON.stringify(report.summary) !== JSON.stringify(report.runs[0]!.summary)
    || JSON.stringify(report.groups) !== JSON.stringify(report.runs[0]!.groups)
    || JSON.stringify(report.windowCoverage) !== JSON.stringify(report.runs[0]!.windowCoverage)
    || report.groupBy !== expected.groupBy || expected.window && (report.window?.from !== expected.window.from || report.window?.before !== expected.window.before)
    || !expected.window && report.window !== undefined) throw Error('Invalid usage report')
  const { calls: _calls, summary: _summary, groups: _groups, windowCoverage: _window, ...run } = report.runs[0]!
  return tools.admit(expected, { schemaVersion: 1, format: 'jevable.ai/preview-usage', selection: tools.query(expected), selectionSha256: report.selectionSha256,
    run, summary: report.summary, ...(report.windowCoverage ? { windowCoverage: report.windowCoverage } : {}), ...(report.groups ? { groups: report.groups } : {}) })
}
