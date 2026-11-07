'use client';

import { useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { MotionConfig, motion, useReducedMotion } from 'motion/react'
import { IconArrowRight, IconCheck, IconGitBranch as IconCircuitBranch, IconPlayerPlay, IconSettings, IconPackage, IconListCheck, IconLock, IconActivity } from '@tabler/icons-react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from './animate-tabs'
import { JevableLogo } from './jevable-logo'
import { RecordedPresentations, RecordedValue } from './recorded-values'
import { TestHistoryReading } from './test-history-reading'
import { SavedTestChecks } from './saved-test-checks'
import { inspectPreviewEvidenceArchive } from '../src/preview/evidence-archive-view.ts'

// The read-only archive inspector ships inside this CSP-hashed, offline browser bundle.
// The legacy controller owns authority and the selection; this function only parses bytes.
Object.defineProperty(window, 'jevableEvidenceArchive', { value: inspectPreviewEvidenceArchive })

// The workspace owns presentation only. Existing DOM controllers exclusively own
// authentication, retained identities, input validation and runtime commands.
// Reparent original controls, never clone, synthesize clicks, fetch, or read tokens.
const required = (id: string) => document.getElementById(id)!
function Slot({ id, className = '' }: { id: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = required(id), originalParent = element.parentNode!, next = element.nextSibling
    ref.current!.append(element)
    return () => { originalParent.insertBefore(element, next?.parentNode === originalParent ? next : null) }
  }, [id])
  return <div ref={ref} className={className} />
}
function TestComposer() {
  const draft = () => { try { return JSON.parse((required('test-editor') as HTMLTextAreaElement).value) } catch { return null } }
  const [value, setValue] = useState(draft), [disabled, setDisabled] = useState(true), [review, setReview] = useState<any>(null)
  const [hasAssessment, setHasAssessment] = useState(false)
  useLayoutEffect(() => {
    const sync = () => { setValue(draft()); setDisabled((required('test-create') as HTMLButtonElement).disabled)
      try { setReview(JSON.parse(required('test-review').textContent ?? '')) } catch { setReview(null) }
      setHasAssessment(Boolean(required('test-result-summary').textContent?.trim())) }
    const observer = new MutationObserver(sync)
    observer.observe(required('test-review'), { childList: true, characterData: true, subtree: true })
    observer.observe(required('test-create'), { attributes: true, attributeFilter: ['disabled'] })
    observer.observe(required('test-result-summary'), { childList: true, characterData: true, subtree: true })
    const changed = () => queueMicrotask(sync)
    required('test-editor').addEventListener('input', changed)
    required('test-copy-input').addEventListener('click', changed)
    required('test-use-entry').addEventListener('click', changed)
    sync()
    return () => { observer.disconnect(); required('test-editor').removeEventListener('input', changed)
      required('test-copy-input').removeEventListener('click', changed); required('test-use-entry').removeEventListener('click', changed) }
  }, [])
  const edit = (fields: Record<string, unknown>) => {
    if (!value || disabled) return
    const next = { ...value, ...fields }
    const editor = required('test-editor') as HTMLTextAreaElement
    editor.value = JSON.stringify(next, null, 2)
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    setValue(next)
  }
  const expectations: any[] = Array.isArray(value?.expectations) ? value.expectations : []
  const outputChecks = expectations.filter(item => item?.kind === 'output-equals')
  const simpleOutput = outputChecks.length === 0 || (outputChecks.length === 1
    && Object.hasOwn(outputChecks[0], 'value') && Object.keys(outputChecks[0]).every(key => key === 'kind' || key === 'value'))
  const outputCheck = simpleOutput ? outputChecks[0] : undefined
  const editOutput = (enabled: boolean, text = '') => {
    const otherChecks = expectations.filter(item => item?.kind !== 'output-equals')
    const statusIndex = otherChecks.findIndex(item => item?.kind === 'status')
    if (enabled) otherChecks.splice(statusIndex + 1, 0, { kind: 'output-equals', value: text })
    edit({ expectations: otherChecks })
  }
  const outcome = (status: string) => ({ completed: 'finish successfully', waiting: "wait for a person's approval", failed: 'report a failure', cancelled: 'stop after cancellation' } as Record<string, string>)[status] ?? 'inspect the saved definition'
  return <>{createPortal(<div className="test-composer"><label htmlFor="friendly-test-name">Test name</label><input id="friendly-test-name" value={value?.title ?? ''} disabled={disabled} onChange={event => edit({ title: event.target.value })} />
    <label htmlFor="friendly-test-outcome">What should happen?</label><select id="friendly-test-outcome" disabled={disabled} value={value?.expectations?.find((item: any) => item.kind === 'status')?.value ?? ''}
      onChange={event => edit({ expectations: [{ kind: 'status', value: event.target.value }, ...value.expectations.filter((item: any) => item.kind !== 'status')] })}>
      <option value="" disabled>Choose an outcome</option><option value="completed">Finish successfully</option><option value="waiting">Wait for a person's approval</option><option value="failed">Report a failure</option><option value="cancelled">Stop after cancellation</option></select>
    {simpleOutput ? <div className="test-output-check"><label className="test-output-toggle" htmlFor="friendly-test-check-output">
      <input id="friendly-test-check-output" type="checkbox" disabled={disabled} checked={Boolean(outputCheck)}
        onChange={event => editOutput(event.target.checked)} />Also check the final result</label>
      {outputCheck && <><label htmlFor="friendly-test-output">What exact text should it return?</label>
        {typeof outputCheck.value === 'string' ? <textarea id="friendly-test-output" disabled={disabled} value={outputCheck.value}
          onChange={event => editOutput(true, event.target.value)} /> : <>
          <div className="saved-test-input"><span className="value-label">Current structured result</span><RecordedValue value={outputCheck.value} /></div>
          <label htmlFor="friendly-test-output">Replace it with exact text (optional)</label>
          <textarea id="friendly-test-output" disabled={disabled} placeholder="Type only if you want to replace the structured result"
            onChange={event => editOutput(true, event.target.value)} /></>}
        <p className="muted">The whole result must match exactly. Empty text is also a value. For numbers or structured data, use Advanced test definition below.</p></>}
    </div> : <p className="muted">This test has output checks that need technical review. Inspect Advanced test definition below; the simple form will not change them.</p>}
    <p className="muted">Use the input you entered in Try it. Saving a draft does not run it.</p><Slot id="test-copy-input" />
    <details><summary>Input saved with this test</summary><pre>{JSON.stringify(value?.input ?? null, null, 2)}</pre></details>
  </div>, required('test-composer-host'))}
    {createPortal(<div className="saved-test-guide">{review?.definition ? <>
      <h4>{review.definition.title}</h4><p>Expected outcome: {outcome(review.definition.expectations?.find((item: any) => item.kind === 'status')?.value)}</p>
      <p>Starts from: {review.definition.triggerMode === 'api' ? 'API request' : 'Default workflow entry'}</p>
      <div className="saved-test-input"><span className="value-label">Saved input</span><RecordedValue value={review.definition.input} /></div>
      <SavedTestChecks expectations={review.definition.expectations} />
      <p className="test-next-step">{review.archived === true ? 'Archived. Review the exact definition before restoring it in More test tools.'
        : review.status === 'accepted' ? `Accepted version ${review.generation}. Run this saved version when you are ready. Saving edits makes a new draft; it does not change earlier runs.`
        : 'Review this saved input and expected outcome, then authorize and accept the test. Saving and accepting never run it.'}</p>
    </> : <p>Save a draft or choose a saved test to review it here. Nothing runs automatically.</p>}</div>, required('test-saved-review-host'))}
    {createPortal(!hasAssessment && <p className="test-empty-result">No assessment loaded. Run an accepted test, or choose a run marked “saved test” in Past runs. Only test runs have expected-versus-actual results; inspecting one does not execute the workflow.</p>, required('test-result-guidance'))}
  </>
}
function StepExplanation() {
  const describe = () => {
    const kind = required('detail-kind').textContent ?? ''
    const descriptions: [string, string][] = [
      ['Human Approval', 'This step waits for a person to review and make a decision before the workflow continues.'],
      ['Jev', 'This step uses judgment to choose a typed outcome. Later steps can route on that outcome without more prompts.'],
      ['Rule', 'This step checks predefined conditions and follows the matching route.'],
      ['LLM', 'This step asks the configured model to generate or transform content.'],
      ['Trigger', 'This step starts the workflow with the input you provide.'],
      ['Output', 'This step returns the workflow result.'],
      ['Bounded loop', 'This step repeats a group of steps within its configured limits.'],
      ['Custom', 'This custom step can be inspected, but execution is unavailable here.']]
    let description = ''
    try { description = JSON.parse(required('detail-body').textContent ?? '{}').description ?? '' } catch { /* Empty selection. */ }
    return { explanation: descriptions.find(([name]) => kind.includes(name))?.[1] ?? 'Select a step in the workflow to understand what it does.', description }
  }
  const [value, setValue] = useState(describe)
  useLayoutEffect(() => {
    const observer = new MutationObserver(() => setValue(describe()))
    for (const id of ['detail-kind', 'detail-body']) observer.observe(required(id), { childList: true, characterData: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  return <div className="step-explanation"><p>{value.explanation}</p>{typeof value.description === 'string' && value.description && <p>{value.description}</p>}</div>
}
type Snapshot = { connected: boolean; title: string; status: string; failureCode: string; readiness: string; node: string; hasApproval: boolean }
const read = (): Snapshot => ({ connected: required('live-login').hidden && !required('live-session').hidden,
  title: required('workflow-title').textContent ?? '', status: required('live-status').textContent ?? '',
  failureCode: required('live-status').dataset.failureCode ?? '',
  readiness: required('live-readiness').textContent ?? '', node: required('detail-title').textContent ?? '',
  hasApproval: !required('live-approval').hidden })
const statusCopy = (status: string, ready: boolean, readiness: string, failureCode: string) => {
  if (/· waiting/.test(status)) return ['Waiting for your decision', 'Open Approvals to read the request and choose what happens next.']
  if (/· completed/.test(status)) return ['Run finished', 'Open Results to inspect the output or try another input.']
  if (/· failed/.test(status) && failureCode === 'approval-rejected') return ['Request rejected', 'The reviewer chose Reject, so this run stopped. Earlier actions, if any, were not undone. View Results for the saved record.']
  if (/· failed/.test(status) && failureCode === 'approval-expired') return ['Review time expired', 'No decision arrived before the deadline, so this run stopped. Earlier actions, if any, were not undone. View Results for the saved record.']
  if (/· failed/.test(status)) return ['Run needs attention', 'Open Results to see what happened. Nothing is retried automatically.']
  if (/· cancelled/.test(status)) return ['Run stopped', 'Work already performed is not undone. See Results for the recorded outcome.']
  if (/· paused/.test(status)) return ['Run paused', 'Review the next step, then choose whether to continue. Nothing resumes automatically.']
  if (/· executing/.test(status)) return ['Result not confirmed', 'A final outcome is not confirmed here. Use Refresh status to inspect the saved record; refreshing never resumes work.']
  if (/· submitting/.test(status)) return ['Request not confirmed', 'This view has not confirmed the request yet. Check the saved status before trying again; this page does not start another run on its own.']
  if (/· loading/.test(status)) return ['Reading saved status', 'Waiting for a saved-run read. This does not show whether the workflow is still running.']
  if (!ready && readiness.includes('Custom execution unavailable.')) return ['Not ready to run',
    'This workflow includes a Custom step, which this runtime cannot run. You can still inspect it. Replace or remove Custom steps before trying the workflow.']
  return ready ? ['Ready to try', 'Enter a sample in Try it, then choose Run workflow.']
    : ['Not ready to run', 'This workflow is not ready to run. Check the connection and entry details in Advanced.']
}
function ResultGuidance({ status, failureCode }: { status: string; failureCode: string }) {
  const text = /· waiting/.test(status) ? 'This run is waiting for a decision. Open Approvals to inspect the request; opening it does not approve anything.'
    : /· completed/.test(status) ? 'This run has finished. Choose Show inputs and output to read its saved result. Private values load only when you ask.'
    : /· paused/.test(status) ? 'This run is paused. You can inspect its saved values before choosing Continue or Step once. Continuing can run steps and use paid services.'
    : /· failed/.test(status) && failureCode === 'approval-rejected' ? 'The request was rejected. No later workflow steps ran; earlier actions, if any, were not undone. The saved record is available below.'
    : /· failed/.test(status) && failureCode === 'approval-expired' ? 'The approval deadline passed without a decision. No later workflow steps ran; earlier actions, if any, were not undone. The saved record is available below.'
    : /· failed/.test(status) ? 'This run needs attention. Inspect its saved status and values before deciding what to do next. Nothing is retried automatically.'
    : /· cancelled/.test(status) ? 'This run has stopped. Inspect the saved outcome; cancellation does not undo work already performed.'
    : /· executing/.test(status) ? 'A final outcome is not confirmed here. This view does not show whether work is still running. Refresh status to inspect the saved record; refreshing never resumes it.'
    : /· submitting/.test(status) ? 'The request is not confirmed in this view. It may already have been accepted. Check its saved status before trying again; this page does not start another run on its own.'
    : /· loading/.test(status) ? 'A saved-run read is awaiting a reply. The run may already have an outcome; this view has not confirmed it yet. Reading status never starts or resumes work.'
    : 'No result is selected yet. Enter a sample in Try it and choose Run workflow, or select a saved run in Past runs.'
  return createPortal(text, required('run-result-guidance'))
}

function Workspace() {
  const connectionTarget = required('live-login').dataset.autoConnect === 'true' ? 'live-connect' : 'live-token'
  const [snapshot, setSnapshot] = useState(read)
  const [page, setPage] = useState('workflow'), [side, setSide] = useState('try'), [bottom, setBottom] = useState('results')
  const reduce = useReducedMotion()
  const previousNode = useRef(snapshot.node), wasConnected = useRef(snapshot.connected)
  const pendingNavigation = useRef<'graph' | 'input' | 'results' | 'controls' | 'approvals' | null>(null), [navigationRequest, setNavigationRequest] = useState(0)
  useLayoutEffect(() => {
    const destination = pendingNavigation.current
    if (!destination) return
    pendingNavigation.current = null
    const input = [...required('run-input').querySelectorAll<HTMLElement>('textarea:not(:disabled), input:not([type=checkbox]):not(:disabled), select:not(:disabled)')]
      .find(element => !element.closest('[hidden], details:not([open])'))
    const continueButton = required('live-continue') as HTMLButtonElement
    // Navigation only: reveal the original controls and focus an enabled action.
    // Never proxy a click or alter the controller's admission/disabled state.
    if (destination === 'controls') {
      const disclosure = required('run-debug').closest('details')
      if (disclosure) disclosure.open = true
    }
    const target = destination === 'approvals' ? required('approval-overview')
      : destination === 'controls' ? continueButton.disabled ? required('run-results') : continueButton
      : destination === 'input' ? input ?? required('run-input')
      : destination === 'results' ? required('run-results') : required(snapshot.connected ? 'graph' : connectionTarget)
    if (!target || target.closest('[hidden]')) return
    target.focus({ preventScroll: true })
    target.scrollIntoView?.({ block: 'nearest', behavior: reduce ? 'instant' : 'smooth' })
  }, [navigationRequest, page, side, bottom, snapshot.connected, reduce])
  useLayoutEffect(() => {
    const observer = new MutationObserver(() => {
      const next = read()
      setSnapshot(old => JSON.stringify(old) === JSON.stringify(next) ? old : next)
      if (next.connected && !wasConnected.current) { setPage('workflow'); setSide('try') }
      wasConnected.current = next.connected
      if (next.node !== previousNode.current && next.node !== 'Inspect a node' && next.node) setSide('step')
      previousNode.current = next.node
    })
    for (const id of ['live-login', 'live-session', 'workflow-title', 'live-status', 'live-readiness', 'detail-title', 'live-approval'])
      observer.observe(required(id), { attributes: true, attributeFilter: id === 'live-status' ? ['hidden', 'data-failure-code'] : ['hidden'], childList: true, characterData: true, subtree: id !== 'live-session' })
    return () => observer.disconnect()
  }, [])
  const ready = /Runtime: ready\./.test(snapshot.readiness)
  const [headline, hint] = statusCopy(snapshot.status, ready, snapshot.readiness, snapshot.failureCode)
  const navigate = (destination: 'graph' | 'input' | 'results' | 'controls' | 'approvals') => {
    setPage(destination === 'approvals' ? 'approvals' : 'workflow')
    if (destination === 'input') setSide('try')
    if (destination === 'results' || destination === 'controls') setBottom('results')
    pendingNavigation.current = destination; setNavigationRequest(value => value + 1)
  }
  return <MotionConfig reducedMotion="user"><div className="workspace-app">
    <a className="skip-link" href={snapshot.connected ? '#graph' : `#${connectionTarget}`} onClick={event => {
      event.preventDefault(); navigate('graph')
    }}>{snapshot.connected ? 'Skip to workflow' : connectionTarget === 'live-connect' ? 'Skip to connection' : 'Skip to access key'}</a>
    <header className="workspace-header">
      <div className="workspace-brand"><JevableLogo /><span>jevable<span className="brand-product">Workflow studio</span></span></div>
      <Slot id="app-heading" className="workspace-heading" />
      <span className="connection-state" title="Session access and runtime connectivity are different. Check the runtime reply status below."><IconLock size={14} aria-hidden />{snapshot.connected ? 'Session open' : 'Private workspace'}</span>
    </header>
    <div className="workspace-nav"><Tabs value={page} onValueChange={setPage}><TabsList aria-label="Workspace">
      <TabsTrigger value="workflow"><IconCircuitBranch size={17} aria-hidden />Workflow</TabsTrigger>
      <TabsTrigger value="approvals"><IconCheck size={17} aria-hidden />Approvals{snapshot.connected && /· waiting/.test(snapshot.status) && <span className="approval-badge">Needs review</span>}</TabsTrigger>
      <TabsTrigger value="tests"><IconListCheck size={17} aria-hidden />Saved tests</TabsTrigger>
      <TabsTrigger value="publish"><IconPackage size={17} aria-hidden />Publish</TabsTrigger>
      <TabsTrigger value="settings"><IconSettings size={17} aria-hidden />Advanced</TabsTrigger>
    </TabsList></Tabs><span className="workspace-safety">Opening this workspace never runs anything.</span></div>
    {!snapshot.connected && <div className="connect-intro"><span className="intro-icon"><IconCircuitBranch size={26} aria-hidden /></span><h2>Make your workflow work for you.</h2><p>See each step, try an input, and review the result in one place.</p><div className="connect-steps"><span><IconCircuitBranch size={16} aria-hidden />See the flow</span><IconArrowRight size={14} aria-hidden /><span><IconPlayerPlay size={16} aria-hidden />Try it</span><IconArrowRight size={14} aria-hidden /><span><IconCheck size={16} aria-hidden />Review the result</span></div></div>}
    <div className="connection-card" hidden={snapshot.connected}><Slot id="live-login" /></div>
    <Slot id="live-notices" className="workspace-notices" />
    <div hidden={!snapshot.connected}>
      <div className="run-guidance"><div><span className="status-label">{headline}</span><p>{hint}</p></div>
        {/· waiting/.test(snapshot.status) && <button type="button" onClick={() => navigate('approvals')}>Review request <IconArrowRight size={16} aria-hidden /></button>}
        {/· paused/.test(snapshot.status) && <button type="button" onClick={() => navigate('controls')}>Review continuation options <IconArrowRight size={16} aria-hidden /></button>}
        {/· (completed|failed|cancelled)/.test(snapshot.status) && <button type="button" onClick={() => navigate('results')}>View results <IconArrowRight size={16} aria-hidden /></button>}
        {!/· (waiting|paused)/.test(snapshot.status) && <button type="button" className="input-jump" onClick={() => navigate('input')}>Enter input <IconArrowRight size={16} aria-hidden /></button>}
      </div>
      <section id="panel-workflow" role="tabpanel" aria-labelledby="tab-workflow" hidden={page !== 'workflow'} aria-label="Workflow workspace">
        <div className="workspace-grid">
          <motion.div id="workflow-canvas" className="workflow-stage" initial={false} animate={{ opacity: 1 }}><Slot id="preview-workspace" /></motion.div>
          <aside id="workflow-sidebar" className="workspace-sidebar"><Tabs value={side} onValueChange={setSide}>
            <TabsList aria-label="Workflow sidebar"><TabsTrigger value="try">Try it</TabsTrigger><TabsTrigger value="step">Step details</TabsTrigger></TabsList>
            <TabsContent value="try"><div className="sidebar-title"><IconPlayerPlay size={18} aria-hidden /><h2>Try your workflow</h2></div><p className="sidebar-description">Change the sample below to see what happens.</p><Slot id="live-session" /></TabsContent>
            <TabsContent value="step"><StepExplanation /><Slot id="node-private" /><Slot id="step-inspector" /></TabsContent>
          </Tabs></aside>
        </div>
        <section id="workspace-results" className="workspace-results"><Tabs value={bottom} onValueChange={setBottom}><TabsList aria-label="Run information">
          <TabsTrigger value="results"><IconActivity size={16} aria-hidden />Results</TabsTrigger><TabsTrigger value="history">Past runs</TabsTrigger><TabsTrigger value="traces">Traces & usage</TabsTrigger>
        </TabsList><TabsContent value="results"><Slot id="run-results" /><details className="advanced-fold"><summary>Advanced run controls</summary><Slot id="run-debug" /></details></TabsContent>
          <TabsContent value="history"><Slot id="run-history" /><details id="past-runs-technical" className="advanced-fold"><summary>Troubleshooting history</summary>
            <p>Optional details about model attempts and approval notification delivery. Opening this section only reveals the controls; choose a read button to load saved information.</p>
            <Slot id="model-history" /><Slot id="notification-history" />
          </details></TabsContent>
          <TabsContent value="traces"><Slot id="live-traces" /><Slot id="live-usage" /><Slot id="live-evidence" /><Slot id="live-evidence-bundle" /></TabsContent></Tabs></section>
      </section>
      <section id="panel-approvals" role="tabpanel" aria-labelledby="tab-approvals" hidden={page !== 'approvals'} className="workspace-page approval-page">
        <div className="page-intro"><h2>Your decisions, in one place.</h2><p>A workflow stops here when it needs your permission to continue.</p></div>
        <section id="approval-overview" tabIndex={-1} className="approval-overview" aria-label="Approval for the selected run">
          <span className="value-label">Selected run</span>
          <h3>{/· waiting/.test(snapshot.status) ? 'A request needs your review'
            : /· failed/.test(snapshot.status) && snapshot.failureCode === 'approval-rejected' ? 'Request rejected'
            : /· failed/.test(snapshot.status) && snapshot.failureCode === 'approval-expired' ? 'Review time expired'
            : 'Nothing waiting for your decision'}</h3>
          <p>{/· waiting/.test(snapshot.status) ? 'View the request, read what you are approving, then choose an action. Viewing it does not approve it.'
            : /· completed/.test(snapshot.status) ? 'This run has finished. You can view its result or try another input.'
            : /· failed/.test(snapshot.status) && snapshot.failureCode === 'approval-rejected' ? 'The reviewer chose Reject. This run stopped without executing later steps; earlier actions are not undone.'
            : /· failed/.test(snapshot.status) && snapshot.failureCode === 'approval-expired' ? 'The decision window ended. This run stopped without executing later steps; earlier actions are not undone.'
            : /· (failed|cancelled)/.test(snapshot.status) ? 'This run has stopped. View its results to see what happened.'
            : 'Run a workflow with an approval step, or choose a waiting run from Past runs.'}</p>
          <Slot id="live-review" />
          <button type="button" className="approval-past-runs" onClick={() => { setPage('workflow'); setBottom('history') }}>Choose a past run</button>
        </section>
        <Slot id="live-approval" />
      </section>
      <section id="panel-tests" role="tabpanel" aria-labelledby="tab-tests" hidden={page !== 'tests'} className="workspace-page"><div className="page-intro"><h2>Check that it keeps working.</h2><p>Save a sample, review the expected outcome, then run your test.</p></div><TestComposer /><TestHistoryReading /><Slot id="live-tests" /><details className="test-coverage-fold"><summary>Which steps did the tests reach?</summary><Slot id="live-test-coverage" /></details></section>
      <section id="panel-publish" role="tabpanel" aria-labelledby="tab-publish" hidden={page !== 'publish'} className="workspace-page"><div className="page-intro"><h2>Turn this workflow into an app.</h2><p>Save a version, then download an app you can run independently. Nothing runs or deploys here.</p></div><Slot id="live-release" /><details className="publish-project-transfer"><summary>Want someone to edit it instead? Transfer the project</summary><p>A project ZIP is for editing in Jevable, not a runnable app.</p><Slot id="live-project-export" /></details></section>
      <section id="panel-settings" role="tabpanel" aria-labelledby="tab-settings" hidden={page !== 'settings'} className="workspace-page"><div className="page-intro"><h2>Workspace details</h2><p>Connection, workflow identity, input contract and source. Nothing here runs your workflow.</p></div><Slot id="session-details" /><Slot id="workflow-source" /></section>
    </div>
    <RecordedPresentations />
    <ResultGuidance status={snapshot.connected ? snapshot.status : ''} failureCode={snapshot.connected ? snapshot.failureCode : ''} />
    <footer className="workspace-footer"><span>Jevable workflow runtime</span><span>Preview build</span></footer>
  </div></MotionConfig>
}
createRoot(required('workspace-root')).render(<Workspace />)
