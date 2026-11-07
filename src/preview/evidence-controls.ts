/// <reference lib="dom" />
import type { prepareEvidenceDownload } from './evidence-download.ts'

/** Explicit read and staged download. No storage, automatic downloads, workflow mutation or external destinations. */
export function liveEvidenceControls(ctx: {
  request: (command: unknown) => Promise<unknown>;
  current: () => { runId: string; revision: string } | undefined;
}, prepare: typeof prepareEvidenceDownload) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  let identity = '', version = 0, busy = false, url: string | undefined
  const message = (text: string) => { el('evidence-message').textContent = text }
  const clear = () => {
    const link = el<HTMLAnchorElement>('evidence-download')
    link.hidden = true; link.removeAttribute('href'); link.removeAttribute('download')
    if (url) URL.revokeObjectURL(url)
    url = undefined; el('evidence-receipt').textContent = ''
  }
  const buttons = () => {
    el<HTMLButtonElement>('evidence-prepare').disabled = !identity || busy
    el<HTMLInputElement>('evidence-private').disabled = !identity || busy
    el<HTMLButtonElement>('evidence-clear').disabled = !url && !busy
  }
  const observe = () => {
    const current = ctx.current(), next = current ? `${current.runId}:${current.revision}` : ''
    if (next !== identity) {
      identity = next; version++; busy = false; clear(); el<HTMLInputElement>('evidence-private').checked = false
      message(next ? 'Prepare a read-only snapshot of the selected run. No download starts automatically.' : 'Select a retained run to export evidence.')
    }
    buttons(); return current
  }
  el('evidence-prepare').addEventListener('click', () => { void (async () => {
    const current = observe(); if (!current || busy) return
    const expected = identity, token = ++version, includePrivate = el<HTMLInputElement>('evidence-private').checked
    // This choice authorizes only this read; never retain private opt-in for a later export.
    el<HTMLInputElement>('evidence-private').checked = false; busy = true; clear(); buttons()
    message('Reading and verifying retained evidence; no workflow action is being taken.')
    try {
      const value = await ctx.request({ operation: 'evidence', id: current.runId, ...(includePrivate ? { includePrivate: true } : {}) })
      observe(); if (version !== token || identity !== expected) return
      const artifact = await prepare(current, value, includePrivate)
      observe(); if (version !== token || identity !== expected) return
      url = URL.createObjectURL(new Blob([artifact.contents], { type: 'application/json;charset=utf-8' }))
      const link = el<HTMLAnchorElement>('evidence-download'); link.href = url; link.download = artifact.filename; link.hidden = false
      el('evidence-receipt').textContent = `Run ${artifact.runId} · workflow ${artifact.workflowStatus} · revision ${artifact.revision}\n`
        + `Privacy: ${includePrivate ? 'PRIVATE payloads and actors included' : 'payloads and actors excluded; identifiers retained'}\n`
        + `File: ${artifact.filename}\nBytes: ${artifact.bytes}\nFile SHA-256: ${artifact.sha256}\nSnapshot SHA-256: ${artifact.snapshotSha256}`
      message('Snapshot ready. Click Download snapshot to ask your browser to save it. This is not confirmation of a saved file, workflow success, authenticity or telemetry delivery.')
    } catch {
      observe(); if (version !== token || identity !== expected) return
      clear(); message('Evidence unavailable or verification failed. Inspect the same run through the owner API. No workflow action was retried.')
    } finally { if (version === token) { busy = false; buttons() } }
  })() })
  const discard = () => { version++; busy = false; clear(); el<HTMLInputElement>('evidence-private').checked = false; buttons() }
  el('evidence-clear').addEventListener('click', () => { discard(); message('Prepared evidence cleared from this page. Previously downloaded files are not removed.') })
  window.addEventListener('pagehide', discard)
  observe()
  return { observe }
}

export const evidenceControlsHtml = `<section class="panel live" id="live-evidence" hidden aria-label="Download retained run evidence"><h2>Export run evidence · read-only</h2>
<p>The default excludes source, inputs, outputs and actors. Identifiers still need review before sharing. This is an observation, not a runnable app, backup, restore format or proof of external outcomes.</p>
<label><input type="checkbox" id="evidence-private">I authorize private source, inputs, outputs, approval data and recorded actors in this one snapshot. Inline secrets may be included.</label>
<div class="live-controls"><button id="evidence-prepare" disabled>Prepare snapshot</button><a id="evidence-download" hidden rel="noopener">Download snapshot</a><button id="evidence-clear" disabled>Clear prepared snapshot</button></div>
<p id="evidence-message" role="status" aria-live="polite"></p><pre id="evidence-receipt"></pre>
<p>Your browser chooses the download location, permissions and duplicate-file handling; this page cannot enforce a private directory or confirm that saving completed. Use CLI export for controlled file permissions. Clearing or disconnecting does not delete downloaded files.</p></section>`
