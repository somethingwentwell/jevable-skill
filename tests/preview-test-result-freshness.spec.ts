import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { JSDOM } from 'jsdom'
import { LocalRuntime } from '../src/runtime/index.ts'
import { liveTestControls, testControlsHtml } from '../src/preview/test-controls.ts'
import { projectPreviewTestResult } from '../src/preview/test-result-view.ts'
import { renderLivePage } from '../src/preview/live-page.ts'

const source = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const owners: LocalRuntime[] = [], windows: JSDOM[] = []
afterEach(async () => { for (const dom of windows.splice(0)) dom.window.close(); for (const owner of owners.splice(0)) await owner.close() })
async function fixture() {
  const owner = await LocalRuntime.open({ dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-assessment-freshness-')) }); owners.push(owner)
  const project = owner.editProject({ operation: 'create', title: 'Synthetic checkpoint test', yaml: source, actor: 'fixture' })
  const draft = owner.editTest({ operation: 'create', actor: 'fixture', definition: { title: 'Wait before approval',
    project: { id: project.id, generation: 1, revision: project.acceptedRevision }, input: { message: 'PRIVATE_SYNTHETIC_INPUT' },
    expectations: [{ kind: 'status', value: 'waiting' }] } })
  const test = owner.editTest({ operation: 'accept', id: draft.id, expectedGeneration: 1, reviewedSha256: draft.sha256, actor: 'fixture' })
  const state = { testId: test.id, runId: randomUUID() }, metadata = await owner.runTest({ id: test.id, generation: test.generation, sha256: test.sha256 }, state.runId)
  const inspected = await owner.testResult(state.runId, true)
  let checkpoint: string | undefined = metadata.run.checkpointSha256
  const dom = new JSDOM(`<textarea id="live-input">{"message":"sample"}</textarea>${testControlsHtml}`, { runScripts: 'outside-only' }); windows.push(dom)
  const failures: unknown[] = []
  const request = vi.fn(async (command: any) => {
    if (command.operation === 'tests.list') return { tests: owner.testCases() }
    if (command.operation === 'tests.show') return owner.testCase(command.id)
    if (command.operation === 'tests.result') return owner.testResult(command.runId, command.inspect)
    throw Error('Unexpected request')
  })
  let controls: ReturnType<typeof liveTestControls>
  const run = vi.fn(async (pin: any) => {
    state.runId = randomUUID(); checkpoint = undefined; controls.observe()
    const report = await owner.runTest(pin, state.runId)
    checkpoint = report.run.checkpointSha256; controls.observe(); return report
  })
  const ctx = { request, run, state: () => state, testRun: () => state.runId ? { id: test.id, generation: test.generation, sha256: test.sha256 } : undefined,
    scope: () => 'synthetic-session', checkpoint: () => checkpoint,
    revision: () => project.acceptedRevision, canRun: () => true, retain() {}, message() {}, error: (error: unknown) => failures.push(error) }
  Object.assign(dom.window, { ctx, TextEncoder })
  controls = dom.window.eval(`(${liveTestControls.toString()})(ctx, ${projectPreviewTestResult.toString()})`) as ReturnType<typeof liveTestControls>
  const get = <T extends HTMLElement = HTMLElement>(id: string) => dom.window.document.getElementById(id) as T
  const click = async (id: string) => { get<HTMLButtonElement>(id).click(); await vi.waitFor(() => expect(get<HTMLButtonElement>('test-create').disabled).toBe(false)) }
  await controls.refresh(); request.mockClear()
  return { owner, dom, controls, state, metadata, inspected, checkpoint: () => checkpoint, request, run, get, click, failures,
    setCheckpoint(value: string | undefined) { checkpoint = value; controls.observe() },
    async complete() {
      const waiting = await owner.show(state.runId)
      if (waiting.state.status !== 'waiting') throw Error('Expected the exact synthetic approval wait')
      await owner.decide(state.runId, waiting.state.attempt.id, 'approve', 'synthetic-reviewer')
      checkpoint = (await owner.testResult(state.runId)).run.checkpointSha256; controls.observe()
    } }
}
describe('saved-test assessments follow recorded checkpoint changes without private auto-fetch', () => {
  it('clears a displayed private assessment when the same run completes and offers explicit inspection', async () => {
    const f = await fixture(); await f.click('test-result'); const id = f.state.runId
    expect(f.get('test-result-summary').textContent).toContain('Waiting')
    await f.complete(); const events = await f.owner.events(id)
    expect(f.state.runId).toBe(id)
    expect(f.get('test-result-summary').textContent).toBe('Workflow changed. Refresh this test result.')
    expect(f.get('test-result-explanation').textContent).toContain('Show expected and actual results')
    expect(f.get('test-result-checks').children).toHaveLength(0); expect(f.get('test-report').textContent).toBe('')
    expect(f.request).toHaveBeenCalledTimes(1); expect(f.run).not.toHaveBeenCalled()
    await f.click('test-result')
    expect(f.get('test-result-summary').textContent).toContain('Test expectations did not match. Finished successfully')
    expect(await f.owner.events(id)).toEqual(events); expect(f.failures).toEqual([])
  })
  it('keeps an explicitly inspected assessment when the observed checkpoint is unchanged', async () => {
    const f = await fixture(); await f.click('test-result'); const text = f.get('test-report').textContent
    f.controls.observe(); f.setCheckpoint(f.checkpoint())
    expect(f.get('test-report').textContent).toBe(text); expect(f.request).toHaveBeenCalledTimes(1)
  })
  it('fences a late private reply across a checkpoint change and return to the earlier hash', async () => {
    const f = await fixture(); let resolve!: (value: any) => void
    f.request.mockImplementationOnce(async () => new Promise(done => { resolve = done }))
    f.get<HTMLButtonElement>('test-result').click(); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    const old = f.checkpoint(); f.setCheckpoint('b'.repeat(64)); f.setCheckpoint(old)
    resolve(f.inspected); await vi.waitFor(() => expect(f.get<HTMLButtonElement>('test-create').disabled).toBe(false))
    expect(f.get('test-report').textContent).toBe(''); expect(f.get('test-result-checks').children).toHaveLength(0)
    expect(f.get('test-result-summary').textContent).toContain('Refresh this test result')
    expect(f.request).toHaveBeenCalledTimes(1); expect(f.run).not.toHaveBeenCalled(); expect(f.failures).toEqual([])
  })
  it('does not discard the first metadata-only report of an explicitly submitted test run', async () => {
    const f = await fixture(); await f.click('test-run')
    expect(f.get('test-result-summary').textContent).toContain('Test expectations matched. Waiting')
    expect(f.get('test-report').textContent).not.toContain('PRIVATE_')
    expect(f.run).toHaveBeenCalledOnce(); expect(f.request).not.toHaveBeenCalled(); expect(f.failures).toEqual([])
  })
  it('clears metadata-only matches too, without silently reassessing or executing', async () => {
    const f = await fixture(); await f.click('test-run'); await f.complete()
    expect(f.get('test-result-summary').textContent).toContain('Refresh this test result')
    expect(f.get('test-report').textContent).toBe(''); expect(f.request).not.toHaveBeenCalled(); expect(f.run).toHaveBeenCalledOnce()
  })
  it('refuses a late or inconsistent report for an already changed same-run checkpoint', async () => {
    const f = await fixture(); await f.complete(); f.request.mockResolvedValueOnce(f.inspected)
    await f.click('test-result')
    expect(f.get('test-report').textContent).toBe(''); expect(f.get('test-result-checks').children).toHaveLength(0)
    expect(f.failures).toHaveLength(1); expect(f.request).toHaveBeenCalledOnce(); expect(f.run).not.toHaveBeenCalled()
  })
  it('clears a previous assessment when the host can no longer pin this run observation', async () => {
    const f = await fixture(); await f.click('test-result'); f.setCheckpoint(undefined)
    expect(f.get('test-report').textContent).toBe(''); expect(f.get('test-result-summary').textContent).toContain('Refresh this test result')
    await f.click('test-result'); expect(f.get('test-report').textContent).toBe(''); expect(f.failures).toHaveLength(1)
  })
  it('wires the real serialized host to its current same-run checkpoint, not session persistence or a network read', () => {
    const { html } = renderLivePage(randomUUID(), 'fixture-protocol')
    expect(html).toContain('checkpoint: () => connected && session?.runId === current?.id')
  })
})
