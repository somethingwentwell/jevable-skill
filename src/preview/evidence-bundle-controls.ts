/// <reference lib="dom" />
import type { prepareEvidenceBundleDownload } from './evidence-bundle-download.ts'
import type { inspectPreviewEvidenceArchive } from './evidence-archive-view.ts'

/** Local explicit selection; never persisted, automatically populated or automatically downloaded. */
export function liveEvidenceBundleControls(ctx: {
  request: (command: unknown) => Promise<unknown>;
  scope: () => string | undefined;
  current: () => { runId: string; revision: string } | undefined;
  changed?: () => void;
}, prepare: typeof prepareEvidenceBundleDownload) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  let scope = '', version = 0, busy = false, savingVersion: number | undefined, url: string | undefined
  let preparedBytes: Uint8Array | undefined, preparedFilename = ''
  const selected = new Map<string, string>()
  let prepared: { selection: { schemaVersion: 1; runs: { id: string; revision: string }[] }; sha256: string; selectionSha256: string;
    privacy: 'metadata-only' | 'private-execution-data' } | undefined
  const message = (text: string) => { el('bundle-message').textContent = text }
  const clearDownload = () => {
    const link = el<HTMLAnchorElement>('bundle-download'); link.hidden = true; link.removeAttribute('href'); link.removeAttribute('download')
    if (url) URL.revokeObjectURL(url)
    url = undefined; prepared = undefined; preparedBytes = undefined; preparedFilename = ''
    el<HTMLButtonElement>('bundle-save-file').hidden = true; el('bundle-receipt').textContent = ''
    el('bundle-review').hidden = true; el('bundle-review-list').replaceChildren(); ctx.changed?.()
    el('bundle-full-review').hidden = true; el('bundle-full-list').replaceChildren()
  }
  const buttons = () => {
    const current = ctx.current()
    const saving = savingVersion !== undefined
    el<HTMLButtonElement>('bundle-add').disabled = !scope || !current || selected.has(current.runId) || selected.size >= 100 || busy || saving
    el<HTMLButtonElement>('bundle-remove').disabled = !scope || !current || !selected.has(current.runId) || busy || saving
    el<HTMLButtonElement>('bundle-clear').disabled = !selected.size && !busy && !url
    el<HTMLButtonElement>('bundle-prepare').disabled = !scope || !selected.size || busy || saving
    el<HTMLInputElement>('bundle-private').disabled = !scope || !selected.size || busy || saving
    const picker = (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker
    const save = el<HTMLButtonElement>('bundle-save-file')
    save.hidden = typeof picker !== 'function' || !preparedBytes
    save.disabled = !scope || !preparedBytes || busy || saving
    el<HTMLTextAreaElement>('bundle-selection').value = [...selected].map(([id, revision]) => `${id} · ${revision}`).join('\n')
    el('bundle-count').textContent = `${selected.size} selected run(s), maximum 100. Selection is kept only in this page.`
  }
  const invalidate = () => { version++; busy = false; savingVersion = undefined; clearDownload(); el<HTMLInputElement>('bundle-private').checked = false }
  const observe = () => {
    const next = ctx.scope() ?? ''
    if (next !== scope) { scope = next; invalidate(); selected.clear(); message(next ? 'Choose retained runs and add each one explicitly.' : 'Connect this preview before selecting evidence.') }
    buttons()
  }
  el('bundle-add').addEventListener('click', () => {
    observe(); const current = ctx.current(); if (!scope || !current || busy || savingVersion !== undefined || selected.has(current.runId) || selected.size >= 100) return
    invalidate(); selected.set(current.runId, current.revision); buttons(); message('Run added. Selection changes clear prepared downloads and private-data consent.')
  })
  el('bundle-remove').addEventListener('click', () => {
    observe(); const current = ctx.current(); if (!scope || !current || busy || savingVersion !== undefined || !selected.has(current.runId)) return
    invalidate(); selected.delete(current.runId); buttons(); message('Run removed; no retained runtime data was deleted.')
  })
  el('bundle-clear').addEventListener('click', () => { invalidate(); selected.clear(); buttons(); message('Selection and prepared ZIP cleared. Downloaded files and runtime records are unchanged.') })
  el('bundle-prepare').addEventListener('click', () => { void (async () => {
    observe(); if (!scope || !selected.size || busy) return
    const expectedScope = scope, selection = { schemaVersion: 1 as const, runs: [...selected].map(([id, revision]) => ({ id, revision })) }
    const includePrivate = el<HTMLInputElement>('bundle-private').checked
    invalidate(); const token = version; busy = true; buttons(); message('Reading only the selected runs and their historical test assessments. No workflow action is being taken.')
    try {
      const response = await ctx.request({ operation: 'evidence.bundle', selection, ...(includePrivate ? { includePrivate: true } : {}) })
      observe(); if (token !== version || scope !== expectedScope) return
      const artifact = await prepare(selection, response, includePrivate)
      observe(); if (token !== version || scope !== expectedScope) return
      const inspect = (window as Window & { jevableEvidenceArchive?: typeof inspectPreviewEvidenceArchive }).jevableEvidenceArchive
      if (!inspect) throw Error('In-page archive inspector unavailable')
      const archive = await inspect(artifact.bytes, selection, artifact.sha256, artifact.privacy)
      observe(); if (token !== version || scope !== expectedScope) return
      if (JSON.stringify(archive.runs.map(run => ({ id: run.id, workflowStatus: run.workflowStatus, assessment: run.assessment })))
        !== JSON.stringify(artifact.summary)) throw Error('Archive and receipt differ')
      url = URL.createObjectURL(new Blob([artifact.bytes], { type: 'application/zip' }))
      preparedBytes = artifact.bytes; preparedFilename = artifact.filename
      prepared = { selection, sha256: artifact.sha256, selectionSha256: artifact.selectionSha256, privacy: artifact.privacy }; ctx.changed?.()
      const link = el<HTMLAnchorElement>('bundle-download'); link.href = url; link.download = artifact.filename; link.hidden = false
      buttons()
      const labels: Record<string, string> = { completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
        executing: 'Still running', waiting: 'Waiting for approval or input', paused: 'Paused' }
      const assessments: Record<string, string> = { passed: 'Passed', failed: 'Failed', pending: 'Pending', uncertain: 'Uncertain' }
      const list = el<HTMLOListElement>('bundle-review-list'); list.replaceChildren()
      for (const run of artifact.summary) {
        const row = document.createElement('li')
        const test = run.assessment === undefined ? 'No saved test result' : `Saved test: ${assessments[run.assessment]}`
        row.textContent = `Run ${run.id.slice(0, 8)}… · Workflow: ${labels[run.workflowStatus]} · ${test}`
        list.append(row)
      }
      el('bundle-review').hidden = false
      const full = el<HTMLDivElement>('bundle-full-list'); full.replaceChildren()
      for (const file of archive.files) {
        const item = document.createElement('details'), heading = document.createElement('summary'), body = document.createElement('div')
        const run = archive.runs.find(run => file.path === run.evidencePath || file.path === run.testPath)
        heading.textContent = file.path === 'README.txt' ? 'About this evidence package'
          : file.path === 'manifest.json' ? 'Archive inventory and checksums'
            : file.path === 'selection.json' ? 'Exactly selected run IDs'
              : file.path.startsWith('tests/') ? `Run ${run?.id.slice(0, 8) ?? 'unknown'}… · saved test checks`
                : `Run ${run?.id.slice(0, 8) ?? 'unknown'}… · full workflow record`
        item.append(heading); item.append(body)
        item.addEventListener('toggle', () => {
          body.replaceChildren()
          if (!item.open) return
          if (file.path === 'README.txt') {
            const text = document.createElement('pre'); text.textContent = file.content; body.append(text); return
          }
          let parsed: any
          try { parsed = JSON.parse(file.content) } catch { return }
          if (file.path.startsWith('runs/')) {
            const snapshot = parsed.snapshot, steps = Array.isArray(snapshot?.steps) ? snapshot.steps : []
            const events = Array.isArray(snapshot?.journal) ? snapshot.journal : []
            const overview = document.createElement('p')
            overview.textContent = `Workflow: ${labels[run?.workflowStatus ?? ''] ?? 'Recorded'} · ${steps.length} saved step(s) · ${events.length} journal event(s). The list is saved activity, not proof of an external effect.`
            body.append(overview)
            const list = document.createElement('ol')
            for (const step of steps.slice(0, 50)) {
              const row = document.createElement('li')
              row.textContent = `Step ${Number.isSafeInteger(step.index) ? step.index + 1 : '?'}: ${String(step.nodeId ?? 'unknown')}${typeof step.port === 'string' ? ` → ${step.port}` : ''}`
              list.append(row)
            }
            body.append(list)
            if (steps.length > 50) {
              const more = document.createElement('p'); more.textContent = 'More steps are recorded in Exact saved JSON below.'; body.append(more)
            }
          } else if (file.path.startsWith('tests/')) {
            const checks = Array.isArray(parsed.checks) ? parsed.checks : []
            const overview = document.createElement('p')
            overview.textContent = `Saved test: ${assessments[run?.assessment ?? ''] ?? 'Recorded'} · ${checks.filter((check: any) => check.matched).length} of ${checks.length} check(s) matched. Workflow status is separate.`
            body.append(overview)
            const list = document.createElement('ol')
            for (const check of checks) {
              const row = document.createElement('li')
              row.textContent = `${check.matched ? 'Matched' : 'Did not match'} · ${String(check.kind ?? 'check')}${typeof check.nodeId === 'string' ? ` · ${check.nodeId}` : ''}`
              list.append(row)
            }
            body.append(list)
          }
          const exact = document.createElement('details'), exactHeading = document.createElement('summary'), text = document.createElement('pre')
          exactHeading.textContent = 'Exact saved JSON'; exact.append(exactHeading); exact.append(text)
          exact.addEventListener('toggle', () => { text.textContent = exact.open ? JSON.stringify(parsed, null, 2) : '' })
          body.append(exact)
        })
        full.append(item)
      }
      el('bundle-full-review').hidden = false
      el('bundle-receipt').textContent = `${artifact.runs} selected run(s) · ${artifact.privacy}\nFile: ${artifact.filename}\nBytes: ${artifact.bytes.length}\nZIP SHA-256: ${artifact.sha256}\nSelection SHA-256: ${artifact.selectionSha256}`
      message('The complete evidence is readable below without saving. If available, choose Save ZIP to a file for an explicit browser save; otherwise the ZIP link asks your browser to download a copy. This page cannot verify the saved file independently.')
    } catch {
      observe(); if (token !== version || scope !== expectedScope) return
      clearDownload(); message('Bundle unavailable, too large or verification failed. Use the standalone CLI for larger archives. No workflow action was retried.')
    } finally { if (token === version) { busy = false; buttons() } }
  })() })
  el('bundle-save-file').addEventListener('click', () => { void (async () => {
    observe()
    const picker = (window as Window & { showSaveFilePicker?: (options: unknown) => Promise<{
      createWritable: () => Promise<{ write: (bytes: Uint8Array) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> }>
    }> }).showSaveFilePicker
    if (!scope || !preparedBytes || !preparedFilename || busy || savingVersion !== undefined || !picker) return
    const token = version, expectedScope = scope, bytes = preparedBytes, filename = preparedFilename
    savingVersion = token; buttons(); message('Choose where to save this checked ZIP. No workflow action is being taken.')
    let writable: { write: (bytes: Uint8Array) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> } | undefined
    try {
      // Keep the picker call in this click's user-activation task.
      const handle = await picker.call(window, { suggestedName: filename,
        types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }] })
      observe(); if (token !== version || scope !== expectedScope || preparedBytes !== bytes) return
      writable = await handle.createWritable()
      observe(); if (token !== version || scope !== expectedScope || preparedBytes !== bytes) { await writable.abort(); return }
      await writable.write(bytes)
      observe(); if (token !== version || scope !== expectedScope || preparedBytes !== bytes) { await writable.abort(); return }
      await writable.close(); writable = undefined
      observe(); if (token === version && scope === expectedScope && preparedBytes === bytes) {
        message('The browser reported that it finished saving the checked ZIP. Confirm the file at your chosen location before sharing it.')
      }
    } catch (error) {
      if (writable) { try { await writable.abort() } catch { /* The browser may already have closed the file. */ } }
      observe(); if (token !== version || scope !== expectedScope) return
      message(error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
        ? 'Saving was cancelled. The checked ZIP remains available in this page.'
        : 'The browser could not confirm saving the ZIP. Check the destination for a partial file or use the standalone CLI.')
    } finally { if (savingVersion === token) { savingVersion = undefined; buttons() } }
  })() })
  window.addEventListener('pagehide', () => { invalidate(); selected.clear(); buttons() })
  observe(); return { observe, prepared: () => prepared ? JSON.parse(JSON.stringify(prepared)) as NonNullable<typeof prepared> : undefined }
}

export const evidenceBundleControlsHtml = `<section class="panel live" id="live-evidence-bundle" hidden aria-label="Download selected evidence ZIP"><h2>Selected run/test evidence ZIP · read-only</h2>
<p>Choose a run in Past runs, or use the current result, then add it here. No run is selected automatically. Historical test assessments are included when available; passing a test does not mean a waiting workflow is complete.</p>
<div class="live-controls"><button id="bundle-add" disabled>Add selected run</button><button id="bundle-remove" disabled>Remove selected run</button><button id="bundle-clear" disabled>Clear selection and ZIP</button></div>
<p id="bundle-count"></p><label for="bundle-selection">Exact selected run IDs and workflow revisions</label><textarea id="bundle-selection" readonly rows="4"></textarea>
<label><input type="checkbox" id="bundle-private" disabled>I authorize private source, inputs, outputs, recorded actors, approval data and historical expected/actual test values in this one ZIP. Inline secrets may be included.</label>
<div class="live-controls"><button id="bundle-prepare" disabled>Prepare selected evidence ZIP</button><button id="bundle-save-file" hidden disabled>Save ZIP to a file…</button><a id="bundle-download" hidden rel="noopener">Download selected evidence ZIP</a></div>
<p id="bundle-message" role="status" aria-live="polite"></p>
<section id="bundle-review" hidden aria-label="Selected evidence summary"><h3>Review the selected runs</h3><p>This read-only overview shows each run and any saved test assessment. A passing test does not prove that a waiting workflow finished.</p><ol id="bundle-review-list"></ol></section>
<section id="bundle-full-review" hidden aria-label="Complete selected evidence"><h3>Read every file here</h3><p>The files below come from the prepared ZIP after its checksum, entry limits, file hashes and run identities were checked in this page. Open a file to read its full saved contents. Private exports can show source, inputs, outputs, actors, approval details and expected/actual test values; review before sharing. Closing a file hides its text, not the prepared bytes. Clearing or disconnecting removes this view without deleting runtime records or a copy already saved by your browser.</p><div id="bundle-full-list"></div></section>
<details id="bundle-technical"><summary>Technical ZIP details</summary><pre id="bundle-receipt"></pre></details>
<p>This is review material, not a runnable app, backup, restore format or approval grant. Runs are separate observations, not an atomic batch snapshot. Preview ZIPs are limited to 12 MB; use CLI export for larger archives and controlled file permissions. A completed browser save operation is not independent verification of the file on disk; this page cannot delete saved files.</p></section>`
