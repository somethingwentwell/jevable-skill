/// <reference lib="dom" />
import type { WorkflowPreview } from './model.ts'
import type { projectPreviewModelHistory, PreviewModelHistory } from './model-history.ts'

/** Serialized controller; only explicit metadata reads. No storage, dynamic HTML, external links or execution operations. */
export function liveModelHistoryControls(ctx: {
  request: (command: unknown) => Promise<unknown>;
  current: () => { runId: string; preview: WorkflowPreview } | undefined;
}, project: typeof projectPreviewModelHistory) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  let identity: string | undefined, version = 0, busy = false, page = 0, snapshot: PreviewModelHistory | undefined
  const pageSize = 25
  const add = (parent: HTMLElement, tag: string, text: string) => {
    const element = document.createElement(tag); element.textContent = text; parent.append(element); return element
  }
  const buttons = () => {
    el<HTMLButtonElement>('model-history-load').disabled = !identity || busy
    el<HTMLButtonElement>('model-history-prev').disabled = !snapshot || busy || page === 0
    el<HTMLButtonElement>('model-history-next').disabled = !snapshot || busy || (page + 1) * pageSize >= snapshot.calls.length
  }
  const render = () => {
    const list = el('model-history-calls'); list.replaceChildren()
    if (!snapshot) { el('model-history-summary').textContent = ''; buttons(); return }
    el('model-history-summary').textContent = `Snapshot of run ${snapshot.runId} · workflow ${snapshot.workflowStatus} · revision ${snapshot.revision}. Snapshot SHA-256 verified: ${snapshot.checksum}. Integrity is not authenticity or external-outcome proof.`
    const count = snapshot.calls.length, start = page * pageSize
    el('model-history-range').textContent = !snapshot.available ? 'This older export has no model history; request count is unknown.'
      : !count ? 'No model-node intents in this retained snapshot.' : `Model intents ${start + 1}–${Math.min(start + pageSize, count)} of ${count}.`
    for (const call of snapshot.calls.slice(start, start + pageSize)) {
      const details = document.createElement('details'); list.append(details)
      const location = `${call.nodeId}${call.scope ? ` · loop ${call.scope.loop}, iteration ${call.scope.index}` : ''}`
      add(details, 'summary', `${location} · ${call.evidence === 'not-recorded' ? 'record unavailable' : call.status}`)
      add(details, 'p', `Node attempt ${call.attemptId}`)
      if (call.evidence === 'not-recorded') { add(details, 'p', 'No configured-model record. This is not proof that no provider request occurred; custom adapters may keep separate evidence.'); continue }
      add(details, 'p', `Model intent ${call.intentAt}${call.settledAt ? ` · settlement ${call.settledAt}` : ' · unsettled'}${call.code ? ` · ${call.code}` : ''}`)
      add(details, 'p', call.trace ? `Model-call trace ${call.trace.traceId} · span ${call.trace.spanId} · flags ${call.trace.traceFlags}; dispatch and telemetry delivery unproven.`
        : 'Model-call trace unrecorded; no context is inferred from a provider header or node parent.')
      if (call.usage) add(details, 'p', `Reported usage: ${call.usage.tries} tries; input tokens ${call.usage.inputTokens ?? 'unreported'}; output tokens ${call.usage.outputTokens ?? 'unreported'}. Failed-request charges may be unknown.`)
      if (!call.tries) { add(details, 'p', 'Single-try evidence: no per-try list or child try trace was retained.'); continue }
      add(details, 'p', `Reviewed policy: up to ${call.policy!.maxAttempts} tries; ${call.policy!.timeoutSeconds}s overall execution timeout.`)
      const scroll = document.createElement('div'); scroll.className = 'model-history-scroll'; scroll.tabIndex = 0
      scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', `Retained model tries for ${call.nodeId}`); details.append(scroll)
      const table = document.createElement('table'); scroll.append(table)
      add(table, 'caption', 'Recorded model tries; pending intent does not prove dispatch')
      const head = document.createElement('thead'), headers = document.createElement('tr'); head.append(headers); table.append(head)
      for (const title of ['Try / identity', 'Recorded result', 'Intent / settlement', 'Response / scheduled delay', 'Trace / span']) {
        add(headers, 'th', title).setAttribute('scope', 'col')
      }
      const body = document.createElement('tbody'); table.append(body)
      for (const attempt of call.tries) {
        const row = document.createElement('tr'); body.append(row)
        add(row, 'td', `${attempt.number} · ${attempt.id}`)
        add(row, 'td', `${attempt.status}${attempt.code ? ` · ${attempt.code}` : ''}`)
        add(row, 'td', `${attempt.intentAt}\n${attempt.settledAt ?? 'No settlement recorded'}`)
        add(row, 'td', `${attempt.httpStatus === undefined ? 'HTTP status unrecorded' : `HTTP ${attempt.httpStatus}`}\n${attempt.scheduledDelayMs === undefined ? 'No retry schedule recorded' : `${attempt.scheduledDelayMs}ms scheduled; not proof of another try`}`)
        add(row, 'td', attempt.trace ? `${attempt.trace.traceId}\n${attempt.trace.spanId}\nflags ${attempt.trace.traceFlags}; delivery unproven` : 'Child trace unrecorded')
      }
    }
    buttons()
  }
  const observe = () => {
    const current = ctx.current(), next = current ? `${current.runId}:${current.preview.revision}` : ''
    if (next !== identity) {
      identity = next; version++; busy = false; page = 0; snapshot = undefined
      el('model-history-message').textContent = next ? 'Load a read-only model-history snapshot for the selected run.' : 'Select a retained run to inspect model history.'
      el('model-history-range').textContent = ''; render()
    }
    buttons(); return current
  }
  el('model-history-load').addEventListener('click', () => { void (async () => {
    const current = observe(); if (!current || busy) return
    const expected = identity, token = ++version
    busy = true; snapshot = undefined; page = 0; el('model-history-range').textContent = ''; render()
    el('model-history-message').textContent = 'Reading retained evidence; no workflow action is being taken.'
    try {
      const value = await ctx.request({ operation: 'evidence', id: current.runId })
      const projected = project(current.preview, current.runId, value)
      const bytes = new TextEncoder().encode(JSON.stringify((value as { snapshot: unknown }).snapshot))
      if (bytes.byteLength > 16_000_000) throw Error('Snapshot limit')
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('')
      if (digest !== projected.checksum) throw Error('Snapshot checksum mismatch')
      observe(); if (version !== token || identity !== expected) return
      snapshot = projected; el('model-history-message').textContent = 'Retained snapshot loaded. Use Load / refresh history for newer evidence; this panel does not poll or execute.'; render()
    } catch {
      observe(); if (version !== token || identity !== expected) return
      snapshot = undefined; render(); el('model-history-message').textContent = 'Model history unavailable or invalid. Inspect the same run through the owner API; no execution was retried.'
    } finally { if (version === token) { busy = false; buttons() } }
  })() })
  for (const [id, direction] of [['model-history-prev', -1], ['model-history-next', 1]] as const) {
    el(id).addEventListener('click', () => {
      observe(); if (!snapshot || busy || page + direction < 0 || (page + direction) * pageSize >= snapshot.calls.length) return
      page += direction; render()
    })
  }
  observe()
  return { observe }
}

export const modelHistoryHtml = `<section class="panel live" id="model-history" hidden aria-label="Retained model and retry history"><h2>Model attempts and retries · read-only</h2>
<p>Request intent is not proof of dispatch. Model settlement is not workflow completion. Scheduled delay does not prove a later try occurred. Trace IDs do not prove collector delivery. Private provider payloads are not shown; identifiers still need review before sharing.</p>
<div class="live-controls"><button id="model-history-load" disabled>Load / refresh history</button><button id="model-history-prev" disabled>Previous intents</button><button id="model-history-next" disabled>Next intents</button></div>
<p id="model-history-message" role="status" aria-live="polite"></p><p id="model-history-summary"></p><p id="model-history-range" aria-live="polite"></p><div id="model-history-calls"></div></section>`
