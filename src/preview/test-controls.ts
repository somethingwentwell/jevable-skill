/// <reference lib="dom" />
import type { projectPreviewTestResult } from './test-result-view.ts'

interface TestTabState { testId?: string; batchId?: string; pendingBatch?: boolean; batchTriggerMode?: 'api'; runId?: string }
interface TestControlContext {
  request(command: unknown): Promise<any>
  run(test: { id: string; generation: number; sha256: string }): Promise<any>
  state(): TestTabState | undefined
  /** Validated identity on the currently inspected run, not the selected test draft. */
  testRun(): { id: string; generation: number; sha256: string } | undefined
  scope(): string | undefined
  retain(): void
  canRun(): boolean
  message(text: string): void
  error(error: unknown): void
  readInput?(): unknown
  triggerMode?(): 'api' | undefined
  revision?(): string | undefined
  /** Latest already-observed same-run checkpoint. No additional read authority. */
  checkpoint?(): string | undefined
}

/** Serialized with the fixed live shell. Reads never accept, generate, run or decide an approval. */
export function liveTestControls(ctx: TestControlContext, projectResult?: typeof projectPreviewTestResult) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  let selected: any, busy = false, pageHidden = false, resultRun: string | undefined
  let identity = ctx.scope(), scopeVersion = 0, actionVersion = 0, resultVersion = 0, observedRun = ctx.state()?.runId
  let testVersion = 0, observedTest = ctx.state()?.testId, observedCheckpoint = ctx.checkpoint?.()
  let pendingResultTicket: number | undefined
  let historyVersion = 0, history: any
  const stale = Object.freeze({})
  const clearHistory = () => {
    historyVersion++; history = undefined
    el<HTMLSelectElement>('test-history-list').replaceChildren(); el<HTMLSelectElement>('test-history-list').value = ''
    el('test-history-detail').textContent = ''
    el('test-history-status').textContent = ''
  }
  const clearResult = () => {
    resultVersion++; resultRun = undefined; pendingResultTicket = undefined; el('test-report').textContent = ''
    el('test-result-summary').textContent = ''; el('test-result-explanation').textContent = ''; el('test-result-checks').replaceChildren()
  }
  const displayResult = (report: any, inspect: boolean, test?: { id: string; generation: number; sha256: string }) => {
    if (ctx.checkpoint && ctx.checkpoint() !== report?.run?.checkpointSha256)
      throw Error('This assessment is not for the current workflow checkpoint. Choose Show expected and actual results to inspect again; nothing was retried.')
    const view = projectResult?.(report, { runId: state().runId!, revision: ctx.revision?.()!, inspect, ...(test ? { test } : {}) })
    if (view) {
      el('test-result-summary').textContent = `${view.heading}. ${view.workflow}.`
      el('test-result-explanation').textContent = view.explanation + (view.inspected
        ? ' Expected and actual values below are private.' : ' Choose “Show expected and actual results” to inspect private values.')
      el('test-result-checks').replaceChildren()
      for (const check of view.checks) {
        const item = document.createElement('li'), title = document.createElement('p')
        title.textContent = `${check.label}: ${check.outcome}`; item.append(title)
        if (view.inspected) {
          const expected = document.createElement('pre'), actual = document.createElement('pre')
          expected.textContent = `Expected\n${check.expected}`; actual.textContent = `Actual\n${check.actual}`
          item.append(expected); item.append(actual)
        }
        el('test-result-checks').append(item)
      }
    }
    const technical = view && !view.inspected ? { schemaVersion: 1, projection: 'jevable.ai/preview-test-result',
      test: { id: report.test.id, generation: report.test.generation, sha256: report.test.sha256 }, runId: report.run.id,
      revision: report.run.revision, assessment: report.assessment, workflowStatus: report.workflowStatus,
      terminal: report.terminal, privateInspection: false, checks: view.checks.map(check => ({ label: check.label, outcome: check.outcome })) } : report
    resultRun = report.run.id; el('test-report').textContent = JSON.stringify(technical, null, 2)
  }
  const clearPrivate = () => {
    selected = undefined; clearResult(); clearHistory()
    for (const id of ['test-review', 'test-batch']) el(id).textContent = ''
    el<HTMLSelectElement>('test-list').replaceChildren()
    el<HTMLInputElement>('test-authorize').checked = false
    // Never reconstruct a previous private draft when another connection becomes active.
    el<HTMLTextAreaElement>('test-editor').value = JSON.stringify({ title: 'Workflow case', input: null,
      expectations: [{ kind: 'status', value: 'completed' }] }, null, 2)
  }
  const observeIdentity = () => {
    const next = pageHidden ? undefined : ctx.scope()
    if (identity !== next) { identity = next; scopeVersion++; actionVersion++; busy = false; clearPrivate() }
    const run = ctx.state()?.runId
    const checkpoint = ctx.checkpoint?.()
    if (run !== observedRun) { observedRun = run; observedCheckpoint = checkpoint; clearResult() }
    else if (checkpoint !== observedCheckpoint) {
      observedCheckpoint = checkpoint
      if (resultRun || pendingResultTicket !== undefined) {
        clearResult()
        el('test-result-summary').textContent = 'Workflow changed. Refresh this test result.'
        el('test-result-explanation').textContent = 'The previous assessment was cleared. Choose Show expected and actual results to inspect the current checkpoint. No test was rerun and no private values were loaded automatically.'
      }
    }
    const test = ctx.state()?.testId
    if (test !== observedTest) {
      observedTest = test; testVersion++; selected = undefined; clearHistory(); el('test-review').textContent = ''
      el<HTMLInputElement>('test-authorize').checked = false
    }
  }
  const state = () => { observeIdentity(); const value = ctx.state(); if (!identity || !value) throw stale; return value }
  const request = async (command: unknown) => {
    state(); const version = scopeVersion
    try {
      const value = await ctx.request(command)
      observeIdentity(); if (version !== scopeVersion || !identity) throw stale
      return value
    } catch (error) { observeIdentity(); if (version !== scopeVersion || !identity) throw stale; throw error }
  }
  const modeFields = (mode: unknown): { triggerMode?: 'api' } => {
    if (mode !== undefined && mode !== 'api') throw Error('Unsupported entry mode. Inspect the case through the owning runtime.')
    return mode === 'api' ? { triggerMode: 'api' } : {}
  }
  const fields = (item: any) => ({ title: item.definition.title, input: item.definition.input, expectations: item.definition.expectations,
    ...modeFields(item.definition.triggerMode) })
  const editor = () => el<HTMLTextAreaElement>('test-editor')
  const buttons = () => {
    observeIdentity()
    const unavailable = busy || !identity || !ctx.state()
    for (const id of ['test-create', 'test-generate', 'test-refresh', 'test-copy-input', 'test-use-entry']) el<HTMLButtonElement>(id).disabled = unavailable
    el<HTMLButtonElement>('test-edit').disabled = unavailable || !selected || selected.archived === true
    el<HTMLButtonElement>('test-accept').disabled = unavailable || selected?.status !== 'draft' || selected.archived === true
    el<HTMLButtonElement>('test-archive').disabled = unavailable || !selected || selected.archived === true
    el<HTMLButtonElement>('test-unarchive').disabled = unavailable || !selected || selected.archived !== true
    el<HTMLButtonElement>('test-run').disabled = unavailable || selected?.status !== 'accepted' || selected.archived === true || !ctx.canRun()
    el<HTMLButtonElement>('test-result').disabled = unavailable || !ctx.state()?.runId || !ctx.testRun()
    el<HTMLButtonElement>('test-history-load').disabled = unavailable || !selected
    el<HTMLSelectElement>('test-history-list').disabled = unavailable || !history
    el<HTMLButtonElement>('test-history-inspect').disabled = unavailable || !history
      || !history.versions.some((version: any) => String(version.generation) === el<HTMLSelectElement>('test-history-list').value)
    el<HTMLSelectElement>('test-list').disabled = unavailable
  }
  const display = (item: any) => {
    if (!identity || ctx.state()?.testId !== item.id) return
    selected = item; clearHistory(); editor().value = JSON.stringify(fields(item), null, 2)
    el('test-review').textContent = JSON.stringify(item, null, 2)
    el<HTMLInputElement>('test-authorize').checked = false; buttons()
  }
  const list = async () => {
    const result = await request({ operation: 'tests.list' }), select = el<HTMLSelectElement>('test-list')
    select.replaceChildren(); const blank = document.createElement('option'); blank.value = ''; blank.textContent = 'Choose saved case'; select.append(blank)
    for (const item of result.tests) { const option = document.createElement('option'); option.value = item.id
      option.textContent = `${item.title} · ${item.archived === true ? 'archived · ' : ''}${item.status} · v${item.generation}`; select.append(option) }
    select.value = state().testId ?? ''
  }
  const load = async () => {
    const id = state().testId, version = testVersion
    if (id) { const value = await request({ operation: 'tests.show', id }); observeIdentity(); if (version === testVersion) display(value) }
  }
  const refresh = async () => {
    await list(); await load()
    const current = state()
    if (current.batchId) {
      const batch = await request({ operation: 'tests.generation', id: current.batchId })
      el('test-batch').textContent = JSON.stringify(batch, null, 2); current.pendingBatch = false; ctx.retain()
    }
    buttons()
  }
  const action = (id: string, fn: () => Promise<void>, onError = ctx.error) => el(id).addEventListener('click', () => {
    buttons(); if (busy || !identity || el<HTMLButtonElement>(id).disabled) return
    const version = ++actionVersion, scope = scopeVersion
    busy = true; buttons()
    void fn().catch(error => { observeIdentity(); if (error !== stale && scope === scopeVersion) onError(error) })
      .finally(() => { if (version === actionVersion) { busy = false; buttons() } })
  })
  const readDraft = () => {
    const value = JSON.parse(editor().value)
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['title', 'input', 'expectations', 'triggerMode'].includes(key)))
      throw Error('Edit only title, input, expectations and optional triggerMode: api. The runtime supplies the pinned project.')
    modeFields(value.triggerMode)
    return value
  }
  action('test-create', async () => {
    const draft = readDraft(), current = state(); current.testId = crypto.randomUUID(); ctx.retain()
    selected = undefined; el('test-review').textContent = `Draft request ${current.testId}. Inspect this ID after any lost response.`
    display(await request({ ...draft, operation: 'tests.create', id: current.testId })); await list()
    ctx.message('Draft saved. Review its exact definition before acceptance; nothing executed.')
  })
  action('test-copy-input', async () => {
    const draft = readDraft(), input = ctx.readInput ? ctx.readInput() : JSON.parse(el<HTMLTextAreaElement>('live-input').value)
    editor().value = JSON.stringify({ ...draft, input }, null, 2)
    el<HTMLInputElement>('test-authorize').checked = false
    ctx.message('Input copied into the case editor only. Save and review the draft before acceptance or execution.')
  })
  action('test-use-entry', async () => {
    const draft = readDraft(); delete draft.triggerMode
    editor().value = JSON.stringify({ ...draft, ...modeFields(ctx.triggerMode?.()) }, null, 2)
    el<HTMLInputElement>('test-authorize').checked = false
    ctx.message('Selected entry copied into the unsaved case only. Save and review its exact definition before acceptance or execution.')
  })
  action('test-edit', async () => {
    if (!selected || selected.archived === true) return
    display(await request({ ...readDraft(), operation: 'tests.edit', id: selected.id, expectedGeneration: selected.generation }))
    await list(); ctx.message('New draft version saved. Review and accept it before running.')
  })
  action('test-accept', async () => {
    if (!selected || selected.archived === true || selected.status !== 'draft' || !el<HTMLInputElement>('test-authorize').checked)
      throw Error('Review the saved definition and explicitly authorize its acceptance.')
    if (JSON.stringify(readDraft()) !== JSON.stringify(fields(selected))) throw Error('Save or reload edited fields before accepting the reviewed definition.')
    const command = { operation: 'tests.accept', id: selected.id, expectedGeneration: selected.generation, reviewedSha256: selected.sha256 }
    el<HTMLInputElement>('test-authorize').checked = false
    display(await request(command)); await list(); ctx.message('Exact case version accepted. Execution still requires Run accepted case.')
  })
  const lifecycle = async (archived: boolean) => {
    if (!selected || (selected.archived === true) === archived) return
    if (!el<HTMLInputElement>('test-authorize').checked) throw Error('Review the saved definition and explicitly authorize its archive or restore.')
    if (JSON.stringify(readDraft()) !== JSON.stringify(fields(selected))) throw Error('Save or reload edited fields before changing the reviewed case lifecycle.')
    const command = { operation: 'tests.archive', id: selected.id, expectedGeneration: selected.generation,
      reviewedSha256: selected.sha256, archived }
    el<HTMLInputElement>('test-authorize').checked = false
    display(await request(command)); await list()
    ctx.message(archived ? 'Case archived. Retained runs and results are unchanged; inspect the original case ID after an uncertain reply.'
      : 'Case restored with a new generation. Its draft/accepted state is unchanged; execution remains explicit.')
  }
  action('test-archive', () => lifecycle(true))
  action('test-unarchive', () => lifecycle(false))
  action('test-generate', async () => {
    const current = state()
    if (!current.pendingBatch) {
      current.batchId = crypto.randomUUID(); delete current.batchTriggerMode
      if (modeFields(ctx.triggerMode?.()).triggerMode === 'api') current.batchTriggerMode = 'api'
    }
    current.pendingBatch = true; ctx.retain()
    const batch = await request({ operation: 'tests.generate', id: current.batchId, limit: 12, ...modeFields(current.batchTriggerMode) })
    el('test-batch').textContent = JSON.stringify(batch, null, 2); current.pendingBatch = false; ctx.retain()
    await list(); ctx.message('Schema-derived drafts saved; completion expectations are suggestions, not tested outcomes or coverage proof.')
  })
  action('test-refresh', async () => {
    await refresh()
    const current = state()
    ctx.message(current.batchId && current.pendingBatch === false
      ? 'Saved tests refreshed. Your requested draft batch is saved; Suggest test drafts now creates a new batch. No test was accepted or run.'
      : 'Saved tests refreshed. No test was created, accepted or run.')
  })
  const historyRequest = async (command: unknown, ticket: number) => {
    try { const value = await request(command); if (ticket !== historyVersion) throw stale; return value }
    catch (error) { if (ticket !== historyVersion) throw stale; throw error }
  }
  action('test-history-load', async () => {
    if (!selected) return
    const id = selected.id; clearHistory(); const ticket = historyVersion
    el('test-history-status').textContent = 'Reading saved versions… Nothing is being changed or run.'
    const value = await historyRequest({ operation: 'tests.history', id }, ticket)
    if (state().testId !== id || value?.test?.id !== id || !Array.isArray(value.versions) || value.versions.length > 100)
      throw Error('History identity unavailable. Inspect the case through the owning runtime.')
    history = value
    const select = el<HTMLSelectElement>('test-history-list'), blank = document.createElement('option')
    blank.value = ''; blank.textContent = 'Choose a retained version'; select.append(blank)
    for (const version of value.versions) {
      const option = document.createElement('option'); option.value = String(version.generation)
      option.textContent = `v${version.generation} · ${version.operation} · ${version.status}${version.archived ? ' · archived' : ''}`
      select.append(option)
    }
    select.value = ''; el('test-history-status').textContent = 'Saved versions loaded. Choose a version, then inspect its saved input and expected outcome. Your latest test is unchanged.'
  }, () => {
    el('test-history-status').textContent = 'We could not read the saved versions. Choose Load selected case history to try reading again. No test was changed, accepted or run.'
  })
  action('test-history-inspect', async () => {
    const version = history?.versions.find((item: any) => String(item.generation) === el<HTMLSelectElement>('test-history-list').value)
    if (!version || !history) return
    const id = history.test.id, ticket = ++historyVersion
    el('test-history-detail').textContent = ''
    el('test-history-status').textContent = 'Reading this saved version… Nothing is being changed or run.'
    const item = await historyRequest({ operation: 'tests.show', id, generation: version.generation }, ticket)
    if (state().testId !== id || item?.id !== id || item.generation !== version.generation || item.sha256 !== version.sha256)
      throw Error('Historical definition did not match its reviewed identity. Refresh history explicitly.')
    el('test-history-detail').textContent = JSON.stringify(item, null, 2)
    el('test-history-status').textContent = `Saved version ${item.generation} loaded for viewing. Your latest test is unchanged. No test was accepted or run.`
  }, () => {
    el('test-history-status').textContent = 'We could not read this saved version. Choose Inspect selected version’s private definition to try reading it again. Your latest test is unchanged. No test was accepted or run.'
  })
  action('test-run', async () => {
    if (!selected || selected.archived === true || selected.status !== 'accepted' || !ctx.canRun()) return
    if (JSON.stringify(readDraft()) !== JSON.stringify(fields(selected))) throw Error('Save and accept edits or reload the accepted definition before running.')
    const version = scopeVersion, ticket = actionVersion
    const test = { id: selected.id, generation: selected.generation, sha256: selected.sha256 }
    const execution = ctx.run(test)
    // The host retains the new run identity synchronously before dispatch. Fence its report,
    // without cancelling admitted work, if the display is cleared or its selection changes.
    observeIdentity(); const resultTicket = resultVersion
    const report = await execution
    observeIdentity()
    if (version !== scopeVersion || ticket !== actionVersion || resultTicket !== resultVersion || !identity || report.run.id !== ctx.state()?.runId) return
    displayResult(report, false, test)
    ctx.message(`Test ${report.assessment}; workflow ${report.workflowStatus}; terminal: ${report.terminal}. Approval decisions remain separate.`)
  })
  action('test-result', async () => {
    const runId = state().runId, test = ctx.testRun()
    if (!runId || !test) return
    clearResult(); const version = resultVersion; pendingResultTicket = version
    try {
      const report = await request({ operation: 'tests.result', runId, inspect: true })
      observeIdentity(); const latest = ctx.testRun()
      if (version !== resultVersion || runId !== ctx.state()?.runId || report?.run?.id !== runId
        || !latest || latest.id !== test.id || latest.generation !== test.generation || latest.sha256 !== test.sha256) return
      displayResult(report, true, test)
    } finally { if (pendingResultTicket === version) pendingResultTicket = undefined }
  })
  el('test-list').addEventListener('change', () => {
    const id = el<HTMLSelectElement>('test-list').value
    buttons(); if (!identity || busy) return
    if (id) state().testId = id; else delete state().testId
    ctx.retain(); selected = undefined; el('test-review').textContent = ''; el<HTMLInputElement>('test-authorize').checked = false; buttons()
    void load().catch(error => { if (error !== stale) ctx.error(error) })
  })
  editor().addEventListener('input', () => { el<HTMLInputElement>('test-authorize').checked = false })
  editor().value = JSON.stringify({ title: 'Workflow case', input: JSON.parse(el<HTMLTextAreaElement>('live-input').value),
    expectations: [{ kind: 'status', value: 'completed' }], ...modeFields(ctx.triggerMode?.()) }, null, 2)
  buttons()
  el('test-result-clear').addEventListener('click', () => { clearResult(); buttons() })
  el('test-history-clear').addEventListener('click', () => { clearHistory(); buttons() })
  el('test-history-list').addEventListener('change', () => { historyVersion++; el('test-history-detail').textContent = ''; el('test-history-status').textContent = ''; buttons() })
  window.addEventListener('pagehide', () => { pageHidden = true; scopeVersion++; actionVersion++; busy = false; clearPrivate(); buttons() })
  window.addEventListener('pageshow', () => { pageHidden = false; buttons() })
  return { refresh: async () => { try { await refresh() } catch (error) { if (error !== stale) throw error } }, buttons, observe() {
    observeIdentity()
    if (resultRun && resultRun !== ctx.state()?.runId) clearResult()
    buttons()
  } }
}

export const testControlsHtml = `<section class="panel live" id="live-tests" hidden>
<header class="test-toolbar"><div class="test-picker"><label for="test-list">Choose a saved test</label><select id="test-list"></select></div><button id="test-refresh">Refresh saved tests</button></header>
<div class="tests-layout"><section class="test-path-panel" id="test-compose-panel" aria-labelledby="test-compose-title"><p class="test-step">1 · Save</p><h3 id="test-compose-title">Set up your test</h3><p>Give this sample a name and choose what should happen.</p><div id="test-composer-host"></div>
<div class="live-controls test-save-actions"><button id="test-create">Save new test draft</button><button id="test-edit" disabled>Save changes</button></div>
<details class="test-details"><summary>Advanced test definition (JSON)</summary><label for="test-editor">Case JSON: title, input, expectations and optional triggerMode: api</label><textarea id="test-editor" spellcheck="false"></textarea><button id="test-copy-input" type="button">Use input from Try it</button><button id="test-use-entry" type="button">Use selected entry</button>
<p>Accepted cases use their saved entry contract, not the current workflow selector. Generation retains that selector with its batch identity; retry never changes it. Omit triggerMode for the default manual/chat contract.</p>
<p>Exactly one status expectation is required: completed, waiting, failed or cancelled. Optional assertions: output-equals, failure-code, node-visited, node-output-equals, node-port-equals. Port assertions require an exact recorded outgoing selection; they do not prove target completion. Missing legacy ports are unavailable, never inferred. Generation suggests completed; review it for your workflow.</p>
</details></section>
<section class="test-path-panel" id="test-review-panel" aria-labelledby="test-review-title"><p class="test-step">2 · Review &amp; run</p><h3 id="test-review-title">Review the saved version</h3><div id="test-saved-review-host"></div><details class="test-details"><summary>Exact saved definition and identity</summary><pre id="test-review">No case selected.</pre></details><label class="test-consent"><input type="checkbox" id="test-authorize">I reviewed and authorize this exact case definition.</label>
<div class="live-controls"><button id="test-accept" disabled>Accept reviewed case</button><button id="test-run" disabled>Run accepted case</button></div>
<p class="test-execution-warning">Running a test may call paid services or make outside changes. Test acceptance never approves a workflow decision.</p></section></div>
<section class="test-outcome-panel" id="test-outcome-panel" aria-labelledby="test-outcome-title"><p class="test-step">3 · Results</p><h3 id="test-outcome-title">Test results</h3><div id="test-result-guidance"></div>
<p id="test-result-summary" role="status" aria-live="polite"></p><p id="test-result-explanation"></p><ul id="test-result-checks"></ul>
<div class="live-controls"><button id="test-result" disabled>Show expected and actual results</button><button id="test-result-clear" type="button">Clear inspected test result</button></div>
<details class="test-details"><summary>Privacy and exact result details</summary><p>Private displays are cleared on disconnect or session change; results also clear when the selected run or checkpoint changes. Clear and closing the page discard displayed data, not retained runtime evidence. Late replies never restore cleared results or trigger another run.</p><details><summary>Advanced test details (JSON)</summary><pre id="test-report">No test result inspected.</pre></details></details></section>
<details class="test-tools"><summary>More test tools</summary><h3>Suggested drafts</h3><p>Suggestions are untested drafts. Review and accept each one before running it.</p><button id="test-generate">Suggest test drafts</button><details><summary>Private generation receipt</summary><pre id="test-batch"></pre></details>
<details><summary>Earlier versions of this test</summary><h3>Retained case versions · read-only</h3><button id="test-history-load" disabled>Load selected case history</button>
<label for="test-history-list">Versions in this exact preview revision</label><select id="test-history-list" disabled></select>
<button id="test-history-inspect" disabled>Inspect selected version’s private definition</button><button id="test-history-clear" type="button">Clear inspected case history</button>
<p id="test-history-status" role="status" aria-live="polite"></p>
<p>History lists retained version metadata only. Explicit inspection shows private input, expectations and review identity separately; it never replaces the latest editor or edit/accept/run guards. Clear, disconnect, case changes and closing the page discard displays, not retained history.</p><div id="test-history-reading"></div><details><summary>Technical historical definition (JSON)</summary><pre id="test-history-detail"></pre></details>
</details><h3>Archive or restore this saved test</h3><div class="live-controls"><button id="test-archive" disabled>Archive reviewed case</button><button id="test-unarchive" disabled>Restore reviewed case</button></div>
<p>Archive/restore require the review authorization above and the exact saved definition. They append a lifecycle version, never erase data or change admitted runs. After a lost reply, refresh this case before another mutation; no automatic retry or newer guard is submitted.</p></details></section>`
