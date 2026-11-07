import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { JSDOM } from 'jsdom'
import { LocalRuntime, type TestDefinition } from '../src/runtime/index.ts'
import { projectPreviewTestResult } from '../src/preview/test-result-view.ts'
import { liveTestControls, testControlsHtml } from '../src/preview/test-controls.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const owners: LocalRuntime[] = [], windows: JSDOM[] = []
afterEach(async () => { for (const dom of windows.splice(0)) dom.window.close(); for (const owner of owners.splice(0)) await owner.close() })
const pin = (test: { id: string; generation: number; sha256: string }) => ({ id: test.id, generation: test.generation, sha256: test.sha256 })
async function fixture(source = echo, expectations: TestDefinition['expectations'] = [
  { kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'PRIVATE_EXPECTED' }]) {
  const runtime = await LocalRuntime.open({ dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-result-view-')) }); owners.push(runtime)
  const project = runtime.editProject({ operation: 'create', title: 'PRIVATE_PROJECT', yaml: source, actor: 'fixture' })
  const draft = runtime.editTest({ operation: 'create', actor: 'fixture', definition: { title: 'PRIVATE_CASE_TITLE',
    project: { id: project.id, generation: 1, revision: project.acceptedRevision },
    input: source === approval ? { message: 'PRIVATE_REQUEST' } : 'PRIVATE_ACTUAL', expectations } })
  const accepted = runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256, actor: 'fixture' })
  const runId = randomUUID(), metadata = await runtime.runTest(pin(accepted), runId)
  const inspected = await runtime.testResult(runId, true)
  return { runtime, accepted, metadata, inspected, project, runId,
    target: { runId, revision: project.acceptedRevision, inspect: true, test: pin(accepted) } }
}

describe('standalone pure retained test-result presentation', () => {
  it('labels the original case version after later expectations are edited and accepted, without reassessment or execution', async () => {
    const f = await fixture(echo, [{ kind: 'status', value: 'completed' }])
    const before = await f.runtime.show(f.runId), events = await f.runtime.events(f.runId)
    const draft = f.runtime.editTest({ operation: 'edit', id: f.accepted.id, expectedGeneration: f.accepted.generation,
      actor: 'fixture', definition: { ...f.accepted.definition, expectations: [{ kind: 'status', value: 'failed' }] } })
    const newer = f.runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: draft.generation,
      reviewedSha256: draft.sha256, actor: 'fixture' })
    expect(newer.generation).toBeGreaterThan(f.accepted.generation)
    const report = await f.runtime.testResult(f.runId), view = projectPreviewTestResult(report, { ...f.target, inspect: false })
    expect(view.heading).toBe('Test expectations matched')
    expect(view.explanation).toContain(`saved test version ${f.accepted.generation}`)
    expect(view.explanation).not.toContain(`saved test version ${newer.generation}`)
    expect(view.explanation).toContain(f.runId.slice(0, 8))
    expect(JSON.stringify(view)).not.toContain('PRIVATE_CASE_TITLE')
    expect(report.test.generation).toBe(f.accepted.generation)
    expect(await f.runtime.show(f.runId)).toEqual(before); expect(await f.runtime.events(f.runId)).toEqual(events)
  })
  it('separates mismatched tests from a successfully completed workflow, with no journal changes', async () => {
    const f = await fixture(), before = await f.runtime.events(f.runId)
    const view = projectPreviewTestResult(f.inspected, f.target)
    expect(view.heading).toBe('Test expectations did not match'); expect(view.workflow).toBe('Finished successfully')
    expect(view.checks).toEqual([
      { label: 'Workflow outcome', outcome: 'Matches', expected: 'Finished successfully', actual: 'Finished successfully', excerpt: false },
      { label: 'Final result', outcome: 'Does not match', expected: 'PRIVATE_EXPECTED', actual: 'PRIVATE_ACTUAL', excerpt: false }])
    expect(await f.runtime.events(f.runId)).toEqual(before)
  })
  it('does not reveal unexpected private fields in a metadata-only receipt', async () => {
    const f = await fixture(), value: any = structuredClone(f.metadata)
    value.checks[1].expected = 'UNAUTHORIZED_EXPECTED'; value.checks[1].actual = 'UNAUTHORIZED_ACTUAL'
    value.answer = 'UNAUTHORIZED_EXTRA'
    const view = projectPreviewTestResult(value, { ...f.target, inspect: false })
    expect(JSON.stringify(view)).not.toMatch(/PRIVATE_|UNAUTHORIZED_/)
    expect(view.checks[1]!.expected).toBe('Private value not inspected')
  })
  it('reports a matching approval wait without equating it with completion or authorization', async () => {
    const f = await fixture(approval, [{ kind: 'status', value: 'waiting' }])
    const view = projectPreviewTestResult(f.inspected, f.target)
    expect(view.heading).toBe('Test expectations matched'); expect(view.workflow).toContain('Waiting')
    expect(view.explanation).toContain('does not approve the request or mean the workflow finished')
    expect((await f.runtime.show(f.runId)).state.status).toBe('waiting')
  })
  it('shows unavailable final results while the workflow still needs approval', async () => {
    const f = await fixture(approval), view = projectPreviewTestResult(f.inspected, f.target)
    expect(view.heading).toBe('Test not finished')
    expect(view.checks[1]).toMatchObject({ outcome: 'Not recorded', actual: 'Not recorded' })
  })
  it('can match an intentionally expected failure without calling the workflow successful', async () => {
    const f = await fixture(approval, [{ kind: 'status', value: 'failed' }, { kind: 'failure-code', value: 'approval-rejected' }])
    const waiting = await f.runtime.show(f.runId)
    if (waiting.state.status !== 'waiting') throw Error('Expected synthetic approval wait')
    await f.runtime.decide(f.runId, waiting.state.attempt.id, 'reject', 'synthetic-fixture-reviewer')
    const view = projectPreviewTestResult(await f.runtime.testResult(f.runId, true), f.target)
    expect(view.heading).toBe('Test expectations matched'); expect(view.workflow).toBe('Reported a failure')
    expect(view.explanation).toContain('intentionally expect failure or cancellation')
    expect(view.checks[1]).toMatchObject({ outcome: 'Matches', actual: 'approval-rejected' })
  })
  it.each([null, false, 0, '', { answer: ['one', 2] }])('keeps the private display value %j distinct from missing evidence', async actual => {
    const f = await fixture(), value: any = structuredClone(f.inspected); value.checks[1].actual = actual
    const view = projectPreviewTestResult(value, f.target)
    expect(view.checks[1]!.actual).toBe(typeof actual === 'string' ? '(empty text)' : JSON.stringify(actual, null, 2))
  })
  it('labels excerpts without changing the underlying retained comparison or claiming a complete value', async () => {
    const f = await fixture(), value: any = structuredClone(f.inspected); value.checks[1].actual = 'x'.repeat(5000)
    const view = projectPreviewTestResult(value, f.target)
    expect(view.checks[1]!.excerpt).toBe(true); expect(view.checks[1]!.outcome).toBe('Does not match')
    expect(view.checks[1]!.actual).toContain('Excerpt: value continues'); expect(value.checks[1].actual).toHaveLength(5000)
  })
  it('labels loop iteration and unknown branch values without inferring a selection', async () => {
    const f = await fixture(), value: any = structuredClone(f.inspected)
    value.checks.push({ index: 2, kind: 'node-port-equals', nodeId: 'review', scope: { loop: 'repeat', index: 0 },
      matched: false, available: false, expected: 'approved' })
    const view = projectPreviewTestResult(value, f.target)
    expect(view.checks[2]).toEqual({ label: 'Branch chosen: review (loop repeat, iteration 1)', outcome: 'Not recorded',
      expected: 'approved', actual: 'Not recorded', excerpt: false })
  })
  it.each(['paused', 'executing'])('keeps recorded %s outcomes pending or uncertain, never a completed pass', async status => {
    const f = await fixture(), value: any = structuredClone(f.inspected)
    value.run.status = status; value.workflowStatus = status; value.terminal = false
    value.assessment = status === 'paused' ? 'pending' : 'uncertain'
    value.checks[0].actual = status; value.checks[0].matched = false
    const view = projectPreviewTestResult(value, f.target)
    expect(view.heading).toBe(status === 'paused' ? 'Test not finished' : 'Test outcome needs inspection')
    expect(view.explanation).toContain('Inspection does not')
  })
  it.each(['run', 'revision', 'test', 'mode', 'status', 'terminal', 'assessment', 'updated', 'check-index', 'check-kind',
    'matched-unavailable', 'node-id', 'scope-index', 'status-count', 'expected', 'status-actual'])('refuses inconsistent %s evidence', async kind => {
    const f = await fixture(), value: any = structuredClone(f.inspected)
    if (kind === 'run') value.run.id = randomUUID()
    if (kind === 'revision') value.run.revision = '0'.repeat(64)
    if (kind === 'test') value.test.generation++
    if (kind === 'mode') value.privateInspection = false
    if (kind === 'status') value.run.status = 'waiting'
    if (kind === 'terminal') value.terminal = false
    if (kind === 'assessment') value.assessment = 'passed'
    if (kind === 'updated') value.observedRunUpdatedAt = 'yesterday'
    if (kind === 'check-index') value.checks[0].index = 1
    if (kind === 'check-kind') value.checks[0].kind = 'anything'
    if (kind === 'matched-unavailable') value.checks[0].available = false
    if (kind === 'node-id') value.checks[1] = { ...value.checks[1], kind: 'node-output-equals', nodeId: '<img>' }
    if (kind === 'scope-index') value.checks[1] = { ...value.checks[1], kind: 'node-output-equals', nodeId: 'review', scope: { loop: 'repeat', index: -1 } }
    if (kind === 'status-count') value.checks[1] = { ...value.checks[0], index: 1 }
    if (kind === 'expected') delete value.checks[1].expected
    if (kind === 'status-actual') value.checks[0].actual = 'waiting'
    expect(() => projectPreviewTestResult(value, f.target)).toThrow('does not match')
  })
})

/** Executes serialized functions in a DOM fixture, not a real browser/CSP/layout acceptance. */
async function controller() {
  const f = await fixture(), dom = new JSDOM(`<textarea id="live-input">"USER_INPUT"</textarea>${testControlsHtml}`, { runScripts: 'outside-only' }); windows.push(dom)
  let scope: string | undefined = 'fixture-session'
  const state: { testId?: string; runId?: string } = { testId: f.accepted.id, runId: f.runId }
  const failures: unknown[] = [], calls: any[] = []
  const request = vi.fn(async (command: any) => {
    calls.push(command)
    if (command.operation === 'tests.list') return { tests: f.runtime.testCases() }
    if (command.operation === 'tests.show') return f.runtime.testCase(command.id)
    if (command.operation === 'tests.result') return f.runtime.testResult(command.runId, command.inspect)
    throw Error('Unexpected request')
  })
  const run = vi.fn(async (test: any) => { state.runId = randomUUID(); return f.runtime.runTest(test, state.runId) })
  const ctx = { request, run, state: () => scope ? state : undefined, testRun: () => state.runId ? pin(f.accepted) : undefined,
    scope: () => scope,
    revision: () => f.project.acceptedRevision, canRun: () => true, retain() {}, message() {}, error: (error: unknown) => failures.push(error) }
  ;(dom.window as any).ctx = ctx; (dom.window as any).TextEncoder = TextEncoder
  const controls = dom.window.eval(`(${liveTestControls.toString()})(ctx, ${projectPreviewTestResult.toString()})`) as ReturnType<typeof liveTestControls>
  const get = <T extends HTMLElement = HTMLElement>(id: string) => dom.window.document.getElementById(id) as T
  const click = async (id: string) => { get<HTMLButtonElement>(id).click(); await vi.waitFor(() => expect(get<HTMLButtonElement>('test-create').disabled).toBe(false)) }
  await controls.refresh(); calls.splice(0); request.mockClear()
  return { ...f, dom, controls, state, get, click, calls, failures, request, run, setScope: (next?: string) => { scope = next; controls.observe() } }
}
describe('friendly saved-test controls keep explicit private inspection and stale fences', () => {
  it('shows check outcomes after an explicit run; values stay hidden until explicit inspection', async () => {
    const f = await controller(); expect(f.get('test-result-summary').textContent).toBe('')
    await f.click('test-run')
    expect(f.run).toHaveBeenCalledOnce(); expect(f.request).not.toHaveBeenCalled()
    expect(f.get('test-result-summary').textContent).toContain('Test expectations did not match. Finished successfully')
    expect(f.get('test-result-checks').textContent).not.toContain('PRIVATE_')
    expect(f.get('test-report').textContent).not.toContain('PRIVATE_')
    const before = await f.runtime.events(f.state.runId!)
    await f.click('test-result')
    expect(f.request).toHaveBeenCalledExactlyOnceWith({ operation: 'tests.result', runId: f.state.runId, inspect: true })
    expect(f.get('test-result-checks').textContent).toContain('PRIVATE_EXPECTED')
    expect(f.get('test-result-checks').textContent).toContain('PRIVATE_ACTUAL')
    expect(f.get('test-report').closest('details')!.open).toBe(false)
    expect(await f.runtime.events(f.state.runId!)).toEqual(before); expect(f.failures).toEqual([])
  })
  it('clears an earlier friendly report on a refused receipt without displaying private mismatched data', async () => {
    const f = await controller(); await f.click('test-result')
    f.request.mockResolvedValueOnce({ ...f.inspected, run: { ...f.inspected.run, revision: '0'.repeat(64) } })
    await f.click('test-result')
    expect(f.get('test-result-summary').textContent).toBe(''); expect(f.get('test-result-checks').children).toHaveLength(0)
    expect(f.get('test-report').textContent).toBe(''); expect(f.failures).toHaveLength(1); expect(f.run).not.toHaveBeenCalled()
  })
  it('does not copy unexpected private values into either metadata-only presentation or advanced details', async () => {
    const f = await controller(), value: any = structuredClone(f.metadata)
    value.checks[1].expected = 'UNAUTHORIZED_EXPECTED'; value.checks[1].actual = 'UNAUTHORIZED_ACTUAL'
    value.privatePayload = 'UNAUTHORIZED_EXTRA'
    f.run.mockResolvedValueOnce(value); await f.click('test-run')
    expect(f.get('test-result-checks').textContent).not.toContain('UNAUTHORIZED_')
    expect(f.get('test-report').textContent).not.toMatch(/UNAUTHORIZED_|PRIVATE_/)
    expect(JSON.parse(f.get('test-report').textContent!)).toMatchObject({ projection: 'jevable.ai/preview-test-result', privateInspection: false })
    expect(f.request).not.toHaveBeenCalled(); expect(f.failures).toEqual([])
  })
  it.each(['clear', 'disconnect', 'scope', 'run', 'pagehide'])('fences late private friendly results after %s without retry or execution', async change => {
    const f = await controller(); let resolve!: (value: any) => void
    f.request.mockImplementationOnce(async () => new Promise(done => { resolve = done }))
    f.get<HTMLButtonElement>('test-result').click(); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    if (change === 'clear') f.get<HTMLButtonElement>('test-result-clear').click()
    if (change === 'disconnect') { f.setScope(undefined); f.setScope('fixture-session') }
    if (change === 'scope') { f.setScope('other'); f.setScope('fixture-session') }
    if (change === 'run') { f.state.runId = randomUUID(); f.controls.observe(); f.state.runId = f.runId; f.controls.observe() }
    if (change === 'pagehide') f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide'))
    resolve(f.inspected); await new Promise(done => setTimeout(done, 0))
    expect(f.get('test-result-summary').textContent).toBe(''); expect(f.get('test-result-checks').children).toHaveLength(0)
    expect(f.get('test-report').textContent).toBe(''); expect(f.request).toHaveBeenCalledTimes(1)
    expect(f.run).not.toHaveBeenCalled(); expect(f.failures).toEqual([])
  })
  it('renders provider-like HTML as inert text, never markup or code', async () => {
    const f = await controller(), value: any = structuredClone(f.inspected)
    value.checks[1].actual = '<img src=x onerror="alert(1)"><script>alert(2)</script>'
    f.request.mockResolvedValueOnce(value); await f.click('test-result')
    expect(f.get('test-result-checks').querySelector('img,script')).toBeNull()
    expect(f.get('test-result-checks').textContent).toContain('<script>alert(2)</script>')
  })
})
