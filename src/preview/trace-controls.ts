/// <reference lib="dom" />
import type { traceNavigationTools, TraceViewerConfig } from '../telemetry/navigation.ts'
import type { prepareEvidenceDownload } from './evidence-download.ts'

/** Explicit metadata read; links are inert until clicked. No backend probing, token forwarding or stored navigation state. */
export function liveTraceControls(ctx: {
  request: (command: unknown) => Promise<unknown>;
  current: () => { runId: string; revision: string } | undefined;
  viewer?: TraceViewerConfig;
}, tools: ReturnType<typeof traceNavigationTools>, verify: typeof prepareEvidenceDownload) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  let identity: string | undefined, version = 0, busy = false, page = 0
  let snapshot: ReturnType<typeof tools.project> | undefined
  const viewer = ctx.viewer === undefined ? undefined : tools.config(ctx.viewer), pageSize = 25
  const message = (text: string) => { el('trace-message').textContent = text }
  const buttons = () => {
    el<HTMLButtonElement>('trace-load').disabled = !identity || busy
    el<HTMLButtonElement>('trace-prev').disabled = !snapshot || busy || page === 0
    el<HTMLButtonElement>('trace-next').disabled = !snapshot || busy || (page + 1) * pageSize >= snapshot.references.length
  }
  const add = (parent: HTMLElement, tag: string, text: string) => { const child = document.createElement(tag); child.textContent = text; parent.append(child); return child }
  const render = () => {
    const list = el('trace-references'); list.replaceChildren()
    if (!snapshot) { el('trace-summary').textContent = ''; buttons(); return }
    const count = snapshot.references.length
    el('trace-summary').textContent = `Run ${snapshot.runId} · workflow ${snapshot.workflowStatus} · revision ${snapshot.revision}. `
      + (count ? `References ${page * pageSize + 1}–${Math.min((page + 1) * pageSize, count)} of ${count}; repeated span references are retained.` : 'No trace context was recorded in this snapshot; this does not prove that no external call occurred.')
    for (const item of snapshot.references.slice(page * pageSize, (page + 1) * pageSize)) {
      const row = document.createElement('li'); list.append(row)
      add(row, 'p', `${item.source}${item.index === undefined ? '' : ` · index/try ${item.index}`}${item.sequence ? ` · event ${item.sequence}` : ''}`
        + `${item.nodeId ? ` · node ${item.nodeId}` : ''}${item.loop ? ` · loop ${item.loop}, iteration ${item.iteration}` : ''}`)
      if (item.attemptId) add(row, 'p', `Node attempt ${item.attemptId}${item.tryId ? ` · model try ${item.tryId}` : ''}`)
      add(row, 'p', `Trace ${item.traceId} · span ${item.spanId} · ${item.traceFlags === 1 ? 'sampled flag' : 'unsampled flag'}; delivery and retention unverified.`)
      if (item.url) {
        const link = document.createElement('a'); link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer'
        link.textContent = `Open configured viewer (${viewer!.origin})`; row.append(link)
      } else add(row, 'p', 'No trace viewer configured; use these retained identifiers with your authorized backend.')
    }
    buttons()
  }
  const observe = () => {
    const current = ctx.current(), next = current ? `${current.runId}:${current.revision}` : ''
    if (identity !== next) {
      identity = next; version++; busy = false; page = 0; snapshot = undefined; render()
      message(next ? 'Load retained trace references explicitly. No trace backend is contacted.' : 'Select a retained run to inspect trace references.')
    }
    buttons(); return current
  }
  el('trace-load').addEventListener('click', () => { void (async () => {
    const current = observe(); if (!current || busy) return
    const expected = identity, token = ++version
    busy = true; snapshot = undefined; page = 0; render(); message('Reading and verifying retained metadata; not contacting the trace backend.')
    try {
      const evidence = await ctx.request({ operation: 'evidence', id: current.runId })
      observe(); if (token !== version || identity !== expected) return
      const artifact = await verify(current, evidence)
      observe(); if (token !== version || identity !== expected) return
      snapshot = tools.project(JSON.parse(artifact.contents).snapshot, viewer); render()
      message(`Snapshot SHA-256 verified: ${artifact.snapshotSha256}. Backend availability, delivery and expiry are unknown. Links do not authorize access or replay execution.`)
    } catch {
      observe(); if (token !== version || identity !== expected) return
      snapshot = undefined; render(); message('Trace references unavailable or invalid. Inspect the same run through the owner API; no execution or telemetry export was retried.')
    } finally { if (token === version) { busy = false; buttons() } }
  })() })
  for (const [id, direction] of [['trace-prev', -1], ['trace-next', 1]] as const) el(id).addEventListener('click', () => {
    observe(); if (!snapshot || busy || page + direction < 0 || (page + direction) * pageSize >= snapshot.references.length) return
    page += direction; render()
  })
  observe()
  return { observe }
}

export const traceControlsHtml = `<section class="panel live" id="live-traces" hidden aria-label="Retained trace navigation"><h2>Trace references · read-only</h2>
<p>Only recorded trace/span IDs are linked. A sampled flag or a valid link does not prove delivery, availability or retention. Opening a link sends those IDs to the configured viewer; authenticate there separately. No runtime credentials are added to links.</p>
<div class="live-controls"><button id="trace-load" disabled>Load / refresh trace references</button><button id="trace-prev" disabled>Previous references</button><button id="trace-next" disabled>Next references</button></div>
<p id="trace-message" role="status" aria-live="polite"></p><p id="trace-summary"></p><ol id="trace-references"></ol></section>`
