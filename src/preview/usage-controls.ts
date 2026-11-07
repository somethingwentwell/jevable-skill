/// <reference lib="dom" />
import type { PreviewUsage, PreviewUsageQuery, previewUsageTools } from './usage.ts'

/** Explicit selected-run read, with drafts and private identifiers held only in memory. */
export function liveUsageControls(ctx: { request: (command: unknown) => Promise<unknown>;
  current: () => { runId: string; revision: string; session: string } | undefined }, tools: ReturnType<typeof previewUsageTools>) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  const fields = ['group', 'from', 'before']
  let identity = '', version = 0, busy = false, visible = true, snapshot: PreviewUsage | undefined
  const buttons = () => {
    el<HTMLButtonElement>('usage-load').disabled = !identity || busy || !visible
    el<HTMLButtonElement>('usage-clear').disabled = !snapshot && !busy && !fields.some(k => el<HTMLInputElement>('usage-' + k).value)
    for (const k of fields) el<HTMLInputElement>('usage-' + k).disabled = !identity || !visible
  }
  const add = (parent: HTMLElement, tag: string, text: string) => { const child = document.createElement(tag); child.textContent = text; parent.append(child); return child }
  const render = () => {
    const list = el('usage-results'); list.replaceChildren()
    if (snapshot) {
      const s = snapshot.summary, r = snapshot.run
      add(list, 'p', `Run ${r.id} · ${r.workflowStatus} · revision ${r.revision}. Observed update ${r.observedRunUpdatedAt}; source snapshot ${r.snapshotSha256}.`)
      add(list, 'p', `Applied query: ${snapshot.selection.groupBy ?? 'ungrouped'}${snapshot.selection.window ? ` · original intent from ${snapshot.selection.window.from} inclusive to ${snapshot.selection.window.before} exclusive` : ' · all retained intent times'}. Selection ${snapshot.selectionSha256}.`)
      add(list, 'p', `Observed model intents ${s.modelIntents}; completed ${s.completedCalls}; failed ${s.failedCalls}; pending ${s.pendingCalls}; unrecorded ${s.unrecordedCalls}; unavailable histories ${s.unavailableHistories}. Retained tries ${s.recordedTries}; failed/pending tries ${s.failedOrPendingTries} may have unreported consumption.`)
      if (snapshot.windowCoverage) add(list, 'p', `All observed source intents ${snapshot.windowCoverage.observedModelIntents}; outside window ${snapshot.windowCoverage.outsideWindow}; unlocated ${snapshot.windowCoverage.unlocatedModelIntents}. Unlocated calls are not allocated to the window.`)
      const scroll = document.createElement('div'); scroll.className = 'model-history-scroll'; scroll.tabIndex = 0
      scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Retained model usage'); list.append(scroll)
      const table = document.createElement('table'); scroll.append(table)
      add(table, 'caption', 'Successful-response tokens counted once; not account totals or billing')
      const head = document.createElement('thead'), tr = document.createElement('tr'); head.append(tr); table.append(head)
      for (const title of ['Observed scope', 'Input tokens / coverage', 'Output tokens / coverage', 'Completed calls / missing fields']) add(tr, 'th', title).setAttribute('scope', 'col')
      const body = document.createElement('tbody'); table.append(body)
      const row = (label: string, value: PreviewUsage['summary']) => {
        const tr = document.createElement('tr'); body.append(tr); add(tr, 'th', label).setAttribute('scope', 'row')
        for (const key of ['inputTokens', 'outputTokens'] as const) add(tr, 'td', `${value[key].reportedTokens ?? 'Unreported'} · ${value[key].coverage}; ${value[key].reportingCalls} reporting responses`)
        add(tr, 'td', `${value.completedCalls} completed; ${value.inputTokens.completedCallsWithoutField} missing input counts; ${value.outputTokens.completedCallsWithoutField} missing output counts`)
      }
      row('Selected run total', s)
      for (const group of snapshot.groups ?? []) row(`Requested provider ${group.key.provider ?? 'unknown'}${snapshot.selection.groupBy === 'provider-model' ? ` · requested model ${group.key.model ?? 'unknown'}` : ''} · unlocated ${group.unlocatedModelIntents}`, group.summary)
    }
    buttons()
  }
  const clear = () => { version++; busy = false; snapshot = undefined
    for (const k of fields) el<HTMLInputElement>('usage-' + k).value = ''
    render(); el('usage-message').textContent = 'Displayed usage cleared; retained run evidence is unchanged.' }
  const observe = () => {
    const current = ctx.current(), next = current ? `${current.session}:${current.runId}:${current.revision}` : ''
    if (identity !== next) { identity = next; clear(); el('usage-message').textContent = next ? 'Load the selected run’s retained usage explicitly.' : 'Connect and select a retained run to inspect usage.' }
    buttons(); return current
  }
  const changed = () => { version++; busy = false; snapshot = undefined; render(); el('usage-message').textContent = 'Usage draft changed. Load explicitly to apply it; no read or model call was started.' }
  for (const k of fields) { el('usage-' + k).addEventListener('input', changed); el('usage-' + k).addEventListener('change', changed) }
  el('usage-clear').addEventListener('click', clear)
  el('usage-load').addEventListener('click', () => { void (async () => {
    const current = observe(); if (!current || busy || !visible) return
    let query: PreviewUsageQuery
    try {
      const from = el<HTMLInputElement>('usage-from').value, before = el<HTMLInputElement>('usage-before').value, groupBy = el<HTMLSelectElement>('usage-group').value
      query = { runId: current.runId, revision: current.revision, ...(from || before ? { window: { from, before } } : {}), ...(groupBy ? { groupBy: groupBy as NonNullable<PreviewUsageQuery['groupBy']> } : {}) }
      tools.query(query)
    } catch { el('usage-message').textContent = 'Invalid usage draft. Choose a listed grouping and either omit both bounds or use an increasing pair of exact UTC millisecond timestamps. Nothing was read.'; return }
    const token = ++version, expected = identity; busy = true; snapshot = undefined; render()
    el('usage-message').textContent = 'Reading selected retained usage; no discovery, provider call, billing query or workflow action.'
    try {
      const value = await ctx.request({ operation: 'usage', id: query.runId, ...(query.window ? { window: query.window } : {}), ...(query.groupBy ? { groupBy: query.groupBy } : {}) })
      const checked = await tools.admit(query, value); observe(); if (token !== version || expected !== identity || !visible) return
      snapshot = checked; render(); el('usage-message').textContent = 'Read complete. Coverage describes observed retained intents only. Zero is distinct from unreported; checksums are not independent proof of provider consumption.'
    } catch { observe(); if (token !== version || expected !== identity) return
      snapshot = undefined; render(); el('usage-message').textContent = 'Usage unavailable or invalid. Inspect the same run through the owner CLI/API; no query or execution was retried.'
    } finally { if (token === version) { busy = false; buttons() } }
  })() })
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => { visible = false; clear() })
    window.addEventListener('pageshow', () => { visible = true; observe() })
  }
  observe(); return { observe, clear }
}

export const usageControlsHtml = `<section class="panel live" id="live-usage" hidden aria-label="Selected run retained model usage"><h2>Model usage · read-only selected run</h2>
<p>Successful-response usage is counted once across retries, not multiplied by try count. Failed/pending calls may have unreported consumption. This is neither account-wide usage, pricing, billing nor proof of provider dispatch. No run discovery or model calls. Identifiers may be private.</p>
<fieldset><legend>Usage draft · applied only on Load</legend><div class="live-grid">
<label for="usage-group">Requested identity grouping <select id="usage-group"><option value="">None · identifiers excluded</option><option value="provider">Provider · opt into its identifier</option><option value="provider-model">Provider and model · opt into their identifiers</option></select></label>
<label for="usage-from">Original intent from · inclusive <input id="usage-from" type="text" maxlength="24" autocomplete="off" spellcheck="false" placeholder="2026-10-01T00:00:00.000Z" aria-describedby="usage-help"></label>
<label for="usage-before">Original intent before · exclusive <input id="usage-before" type="text" maxlength="24" autocomplete="off" spellcheck="false" placeholder="2026-10-02T00:00:00.000Z" aria-describedby="usage-help"></label>
</div><p id="usage-help">Omit both time bounds or provide both UTC timestamps with milliseconds. Whole calls follow original intent time, not each retry or settlement. Requested identity is not the provider response version or a billing identity. Drafts and results are not saved in browser storage.</p></fieldset>
<div class="live-controls"><button id="usage-load" disabled>Load / refresh selected usage</button><button id="usage-clear" disabled>Clear displayed usage</button></div><p id="usage-message" role="status" aria-live="polite"></p><div id="usage-results"></div></section>`
