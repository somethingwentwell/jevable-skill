import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { liveBreakpointControls } from '../src/preview/breakpoint-controls.ts'
import { createPreview } from '../src/preview/model.ts'
import { renderTemplate } from '../src/templates/index.ts'
import { LocalRuntime, executionCheckpointHash } from '../src/runtime/index.ts'
import { runReceipt } from '../src/runtime/receipts.ts'

// Serialized-controller doubles, not browser interaction, rendering or accessibility qualification.
class Element {
  value = ''; textContent = ''; disabled = false; children: Element[] = []
  listeners = new Map<string, (() => void)[]>()
  append(child: Element) { this.children.push(child) }
  addEventListener(name: string, listener: () => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]) }
  fire(name = 'click') { for (const listener of this.listeners.get(name) ?? []) listener() }
}
const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
function fixture(yaml = source) {
  const preview = createPreview(yaml), elements = new Map<string, Element>()
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)! }
  const document = { getElementById: get, createElement: () => new Element() }
  let run: any = { id: randomUUID(), revision: preview.revision, status: 'paused', nodeId: 'start', checkpointSha256: 'a'.repeat(64), steps: [] }
  let allowed = true
  const overlay = vi.fn(), ctx = { preview, current: () => run, canEdit: () => allowed && run?.status === 'paused', overlay }
  const controls = runInNewContext(`(${liveBreakpointControls.toString()})(ctx)`, { document, ctx }) as ReturnType<typeof liveBreakpointControls>
  return { preview, controls, get, overlay, current: () => run,
    update: (value: any) => { run = value; controls.observe() }, allow: (value: boolean) => { allowed = value; controls.observe() },
    select: (id: string) => { get('breakpoint-node').value = id; get('breakpoint-node').fire('change') } }
}
describe('serialized breakpoint drafts and receipt admission (controller doubles)', () => {
  it('starts read-only and makes a detached draft only for explicit Step/Continue', () => {
    const f = fixture()
    expect(f.controls.fields()).toEqual({})
    f.select('result'); f.get('breakpoint-toggle').fire()
    expect(f.get('breakpoint-draft').textContent).toContain('Unapplied draft: result')
    expect(f.current().breakpoints).toBeUndefined()
    const fields = f.controls.fields(); expect(fields).toEqual({ breakpoints: ['result'] })
    fields.breakpoints!.push('start'); expect(f.controls.fields()).toEqual({ breakpoints: ['result'] })
    expect(f.overlay).toHaveBeenLastCalledWith({ revision: f.preview.revision, enabled: [], draft: ['result'] })
  })
  it('supports graph selection, clearing a configured list and discarding a draft', () => {
    const f = fixture()
    f.update({ ...f.current(), breakpoints: ['start'], breakpointConfigurationRequestId: randomUUID() })
    f.controls.select('start'); expect(f.get('breakpoint-node').value).toBe('start')
    f.get('breakpoint-clear').fire(); expect(f.controls.fields()).toEqual({ breakpoints: [] })
    f.get('breakpoint-discard').fire(); expect(f.controls.fields()).toEqual({})
    expect(f.get('breakpoint-configured').textContent).toContain('start')
    f.controls.select(null); expect(f.get('breakpoint-toggle').disabled).toBe(true)
  })
  it('retains a draft on same-checkpoint refresh but refuses it after another client advances', () => {
    const f = fixture(); f.select('result'); f.get('breakpoint-toggle').fire()
    f.update({ ...f.current() }); expect(f.controls.fields()).toEqual({ breakpoints: ['result'] })
    f.update({ ...f.current(), checkpointSha256: 'b'.repeat(64) })
    expect(() => f.controls.fields()).toThrow('Checkpoint changed')
    expect(f.get('breakpoint-toggle').disabled).toBe(true)
    f.get('breakpoint-discard').fire(); expect(f.controls.fields()).toEqual({})
  })
  it('clears drafts on run changes and refuses hidden editing during pending actions', () => {
    const f = fixture(); f.select('start'); f.get('breakpoint-toggle').fire(); f.allow(false)
    f.get('breakpoint-clear').fire(); f.get('breakpoint-discard').fire()
    expect(() => f.controls.fields()).toThrow('Inspect a paused run')
    f.allow(true); expect(f.controls.fields()).toEqual({ breakpoints: ['start'] })
    f.update({ ...f.current(), id: randomUUID() }); expect(f.controls.fields()).toEqual({})
    expect(f.get('breakpoint-node').value).toBe('')
  })
  it('acknowledges only the exact admitted control and matching configured list', () => {
    const f = fixture(); f.select('result'); f.get('breakpoint-toggle').fire()
    const request = { id: f.current().id, requestId: randomUUID(), breakpoints: ['result'] }
    const result = { ...f.current(), lastControl: { requestId: request.requestId }, breakpoints: ['result'], breakpointConfigurationRequestId: request.requestId,
      checkpointSha256: 'b'.repeat(64) }
    f.controls.reconcile(result, { ...request, requestId: randomUUID() })
    expect(f.controls.fields()).toEqual({ breakpoints: ['result'] })
    f.controls.reconcile(result, request); f.update(result)
    expect(f.controls.fields()).toEqual({}); expect(f.get('breakpoint-draft').textContent).toBe('No unapplied changes.')
  })
  it.each(['waiting', 'executing', 'completed', 'failed', 'cancelled'])('never edits a %s run', status => {
    const f = fixture(); f.update({ ...f.current(), status }); f.controls.select('start'); f.get('breakpoint-toggle').fire()
    expect(f.get('breakpoint-toggle').disabled).toBe(true); expect(() => f.controls.fields()).toThrow()
  })
  it.each([['missing'], ['start', 'start'], Array.from({ length: 129 }, () => 'start')])('refuses invalid retained selection %j', (...ids) => {
    const f = fixture(); expect(() => f.controls.validate(ids)).toThrow('Invalid breakpoint selection')
  })
  it('refuses cross-revision and inconsistent hit metadata and clears its graph overlay', () => {
    const f = fixture(), run = f.current(), configuration = randomUUID()
    const valid = { ...run, breakpoints: ['start'], breakpointConfigurationRequestId: configuration,
      breakpoint: { nodeId: 'start', configurationRequestId: configuration, checkpointSha256: 'b'.repeat(64), stepCount: 0, at: new Date().toISOString() } }
    f.update(valid); expect(f.get('breakpoint-hit').textContent).toContain('Paused before start')
    for (const patch of [{ revision: 'b'.repeat(64) }, { breakpoint: { ...valid.breakpoint, stepCount: 1 } },
      { breakpoint: { ...valid.breakpoint, scope: { loop: 'missing', index: 0 } } }, { breakpointConfigurationRequestId: undefined }]) {
      f.update({ ...valid, ...patch }); expect(f.overlay).toHaveBeenLastCalledWith(null)
      expect(f.get('breakpoint-message').textContent).toContain('unavailable or mismatched')
      expect(() => f.controls.fields()).toThrow()
    }
    // An admitted clearing control can leave an earlier hit as the current pause reason if dispatch fails.
    f.update({ ...valid, breakpoints: [], breakpointConfigurationRequestId: randomUUID() })
    expect(f.get('breakpoint-hit').textContent).toContain('Paused before start')
  })
  it('maps actual loop hit receipts to the scoped graph without exposing private input', async () => {
    const yaml = JSON.stringify(renderTemplate('expense-check')), f = fixture(yaml)
    const directory = await mkdtemp(join(tmpdir(), 'jevable-breakpoint-view-'))
    const runtime = await LocalRuntime.open({ dataDirectory: directory })
    try {
      const previewNode = f.preview.graphs.find(graph => graph.scope !== 'workflow')!.nodes[0]!
      const { listTemplates } = await import('../src/templates/index.ts')
      const start = await runtime.run(yaml, listTemplates().find(t => t.id === 'expense-check')!.sample, { paused: true })
      const hit = await runtime.advance(start.id, { requestId: randomUUID(), expectedCheckpointSha256: executionCheckpointHash(start),
        mode: 'continue', breakpoints: [previewNode.id] }, 'PRIVATE_VIEW_ACTOR')
      f.update(runReceipt(hit)); expect(f.get('breakpoint-hit').textContent).toContain('loop iteration 0')
      expect(f.overlay.mock.calls.at(-1)![0]).toMatchObject({ hit: { nodeId: previewNode.id, iteration: 0 } })
      expect(JSON.stringify(f.overlay.mock.calls)).not.toContain('PRIVATE_VIEW_ACTOR')
    } finally { await runtime.close() }
  })
})
