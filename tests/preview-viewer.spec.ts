import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { createPreview, projectPreviewExecution } from '../src/preview/index.ts'
import { previewViewer } from '../src/preview/viewer.ts'
import { renderTemplate } from '../src/templates/index.ts'

// DOM doubles test state/application only, never layout, accessibility or browser security.
class Element {
  textContent = ''; value = ''; hidden = false; dataset = {}; children: Element[] = []
  attributes = new Map<string, string>(); listeners = new Map<string, ((event: any) => void)[]>()
  constructor(readonly tag = 'div') {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  append(...children: Element[]) { this.children.push(...children) }
  replaceChildren() { this.children = [] }
  addEventListener(name: string, listener: (event: any) => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]) }
  fire(name = 'click', event: Record<string, unknown> = {}) { for (const fn of this.listeners.get(name) ?? []) fn({ target: this, ...event }) }
  focus() { this.fire('focus') }
  closest(selector: string) { return selector === '[data-node]' && this.attributes.has('data-node') ? this : null }
  setPointerCapture(_id: number) {}
  getBoundingClientRect() { return { width: 1000, height: 600 } }
  querySelectorAll(selector: string): Element[] {
    const matches = (element: Element) => selector.startsWith('[') ? element.attributes.has(selector.slice(1, -1)) : element.tag === selector
    return this.children.flatMap(child => [...matches(child) ? [child] : [], ...child.querySelectorAll(selector)])
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null }
}
afterEach(() => vi.unstubAllGlobals())
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
function fixture(source = echo, onSelect?: (id: string | null) => void,
  onNodeSelect?: (node: { nodeId: string; graphScope: string } | null) => void, globals: Record<string, unknown> = {}) {
  const elements = new Map<string, Element>(), get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!
  }
  const document = { getElementById: get, createElement: (tag: string) => new Element(tag),
    createElementNS: (_ns: string, tag: string) => new Element(tag), documentElement: new Element() }
  const preview = createPreview(source)
  // Execute exactly the serialized function used by both page generators, with no import closure.
  const controller = runInNewContext(`(${previewViewer.toString()})(data, options)`, { document, data: preview, options: { onSelect, onNodeSelect }, ...globals }) as ReturnType<typeof previewViewer>
  const graph = get('graph'), node = (id: string) => graph.querySelectorAll('[data-node]').find(item => item.getAttribute('data-node') === id)!
  return { get, graph, node, preview, controller, document }
}
describe('execution graph view state (DOM doubles only)', () => {
  it.each([
    ['approval-rejected', 'request was rejected', 'Request rejected'],
    ['approval-expired', 'review time expired', 'Review time expired'],
  ])('labels the recorded %s checkpoint without claiming a later step ran', (code, message, label) => {
    const f = fixture(approval), evidence = projectPreviewExecution(f.preview, {
      id: randomUUID(), revision: f.preview.revision, status: 'failed', code, nodeId: 'review', steps: [],
    })
    f.controller.setExecution(evidence)
    expect(f.get('execution-status').textContent).toContain(message)
    expect(f.node('review').getAttribute('aria-label')).toContain(label)
    expect(f.node('result').getAttribute('aria-label')).toContain('No recorded result')
    expect(f.node('result').getAttribute('aria-label')).not.toContain(label)
  })
  it.each([
    ['completed', 'Run finished.'], ['waiting', 'approve or reject'], ['paused', 'has not run yet'],
    ['executing', 'outcome is not yet recorded'], ['failed', 'stopped with an error'], ['cancelled', 'not undone'],
  ])('gives %s a plain-language status without losing the exact saved receipt or running anything', (status, message) => {
    const selected = vi.fn(), f = fixture(echo, selected)
    const evidence = projectPreviewExecution(f.preview, { id: randomUUID(), revision: f.preview.revision, status,
      ...(status === 'completed' ? {} : { nodeId: 'start' }), steps: [] })
    const before = JSON.stringify(evidence), preview = JSON.stringify(f.preview)
    selected.mockClear()
    f.controller.setExecution(evidence)
    expect(f.get('execution-status').textContent).toContain(message)
    expect(f.get('execution-status').textContent).not.toContain(evidence.runId)
    expect(f.get('execution-summary').textContent).toBe(evidence.summary)
    expect(f.get('execution-guidance').textContent).toContain('not proof')
    expect(JSON.stringify(evidence)).toBe(before)
    expect(JSON.stringify(f.preview)).toBe(preview)
    expect(selected).not.toHaveBeenCalled()
    f.controller.setExecution(null)
    expect(f.get('execution-status').textContent).toBe('')
    expect(f.get('execution-guidance').textContent).toBe('')
    expect(f.get('execution-summary').textContent).toBe('')
  })

  it('surfaces uncertain connections without manufacturing a successful route or exposing arbitrary status markup', () => {
    const f = fixture(), evidence = projectPreviewExecution(f.preview, { id: randomUUID(), revision: f.preview.revision,
      status: 'paused', nodeId: 'start', steps: [] })
    evidence.ambiguousConnections = 1
    evidence.status = '<img src=x onerror=alert(1)>'
    f.controller.setExecution(evidence)
    expect(f.get('execution-status').textContent).toBe('Saved run activity is available for inspection.')
    expect(f.get('execution-guidance').textContent).toContain('Some connections are uncertain')
    expect(f.get('execution-status').children).toHaveLength(0)
    expect(f.node('start').getAttribute('data-execution')).toBe('next')
    expect(() => f.controller.setExecution({ ...evidence, revision: 'other' })).toThrow('revision mismatch')
    expect(f.get('execution-status').textContent).toBe('')
    expect(f.get('execution-guidance').textContent).toBe('')
  })

  it.each(['🤖', 'e\u0301', '👨‍👩‍👧‍👦', '🇸🇬', '👍🏽', '❤️'])('clips a long label without splitting the %s grapheme', glyph => {
    const workflow: any = renderTemplate('expense-check')
    const title = 'A'.repeat(22) + glyph + 'XYZ'
    workflow.spec.nodes.start.title = title
    const f = fixture(JSON.stringify(workflow)), before = JSON.stringify(f.preview)
    expect(f.node('start').querySelectorAll('text')[1]!.textContent).toBe('A'.repeat(22) + glyph + '…')
    expect(f.node('start').querySelector('title')!.textContent).toContain(title)
    expect(f.node('start').getAttribute('aria-label')).toContain(title)
    f.node('start').fire()
    expect(f.get('detail-title').textContent).toBe(title)
    f.get('search').value = glyph + 'XYZ'; f.get('search').fire('input')
    expect(f.get('node-list').children).toHaveLength(1)
    expect(JSON.stringify(f.preview)).toBe(before)
    expect(f.preview.execution).toBe('not-run')
  })

  it.each(['🤖', 'e\u0301'])('keeps exactly 24 %s graphemes intact without an ellipsis', glyph => {
    const workflow: any = renderTemplate('expense-check'), title = glyph.repeat(24)
    workflow.spec.nodes.start.title = title
    const f = fixture(JSON.stringify(workflow))
    expect(f.node('start').querySelectorAll('text')[1]!.textContent).toBe(title)
  })

  it.each([
    ['A'.repeat(25), 'A'.repeat(23) + '…'],
    ['A'.repeat(22) + '👨‍👩‍👧‍👦XYZ', 'A'.repeat(22) + '👨‍👩‍👧‍👦XYZ'],
    ['e\u0301'.repeat(25), 'e\u0301'.repeat(25)],
  ])('keeps the graph inspectable without Intl.Segmenter for %s', (title, shown) => {
    const workflow: any = renderTemplate('expense-check')
    workflow.spec.nodes.start.title = title
    const f = fixture(JSON.stringify(workflow), undefined, undefined, { Intl: {} })
    expect(f.node('start').querySelectorAll('text')[1]!.textContent).toBe(shown)
    f.node('start').fire()
    expect(f.get('detail-title').textContent).toBe(title)
    expect(f.preview.execution).toBe('not-run')
  })

  it.each([
    ['trigger', 'Trigger'], ['llm', 'LLM · writing'], ['decision', 'Jev · judgment'], ['rule', 'Rule · routing'],
    ['humanApproval', 'Human Approval'], ['loop', 'Bounded loop'], ['custom', 'Custom · execution unavailable'], ['output', 'Output'],
  ])('keeps a readable %s draft inspectable without claiming it is executable', (type, label) => {
    const workflow: any = renderTemplate('expense-check')
    workflow.spec.nodes.inspectionOnly = { type, title: 'Inspect this draft', config: {} }
    const f = fixture(JSON.stringify(workflow))
    expect(f.preview.validation.status).toBe('invalid')
    expect(f.preview.execution).toBe('not-run')
    f.node('inspectionOnly').fire()
    expect(f.get('detail-kind').textContent).toBe(`workflow/inspectionOnly · ${label}`)
    expect(f.get('detail-title').textContent).toBe('Inspect this draft')
    expect(f.get('execution-overlay').hidden).toBe(true)
  })

  it('bounds zoom around the same center and restores the original graph fit without selecting or executing', () => {
    const selected = vi.fn(), f = fixture(echo, selected)
    const box = () => f.graph.getAttribute('viewBox')!.split(' ').map(Number)
    const original = box(), center = [original[0]! + original[2]! / 2, original[1]! + original[3]! / 2]
    selected.mockClear()
    f.get('zoom-in').fire()
    const zoomed = box()
    expect(zoomed[2]).toBeCloseTo(original[2]! * 0.8)
    expect(zoomed[0]! + zoomed[2]! / 2).toBeCloseTo(center[0]!)
    expect(zoomed[1]! + zoomed[3]! / 2).toBeCloseTo(center[1]!)
    for (let index = 0; index < 100; index++) f.get('zoom-in').fire()
    expect(box()[2]).toBe(160)
    for (let index = 0; index < 100; index++) f.get('zoom-out').fire()
    const maximum = box()[2]
    f.get('zoom-out').fire(); expect(box()[2]).toBe(maximum)
    expect(box().every(Number.isFinite)).toBe(true)
    f.get('fit').fire(); expect(box()).toEqual(original)
    expect(selected).not.toHaveBeenCalled()
    expect(f.get('execution-overlay').hidden).toBe(true)
  })

  it('searches full authored labels and inspects a result without losing text or changing workflow data', () => {
    const workflow: any = renderTemplate('expense-check')
    const title = 'Long authored label with <b>markup</b> and a unique ending'
    workflow.spec.nodes.start.title = title
    const selected = vi.fn(), f = fixture(JSON.stringify(workflow), selected)
    const before = JSON.stringify(f.preview)
    selected.mockClear()
    f.get('search').value = 'UNIQUE ENDING'; f.get('search').fire('input')
    expect(f.get('node-list').children).toHaveLength(1)
    expect(f.get('search-count').textContent).toBe(`1 of ${f.preview.graphs[0]!.nodes.length} nodes`)
    expect(selected).not.toHaveBeenCalled()
    f.get('node-list').children[0]!.children[0]!.fire()
    expect(f.get('detail-title').textContent).toBe(title)
    expect(selected).toHaveBeenLastCalledWith('start')
    expect(f.graph.querySelectorAll('b')).toHaveLength(0)
    f.get('search').value = 'no such node'; f.get('search').fire('input')
    expect(f.get('node-list').children).toHaveLength(0)
    f.get('theme').fire(); expect(f.document.documentElement.dataset).toEqual({ theme: 'dark' })
    f.get('theme').fire(); expect(f.document.documentElement.dataset).toEqual({ theme: 'light' })
    expect(JSON.stringify(f.preview)).toBe(before)
    expect(f.get('execution-overlay').hidden).toBe(true)
  })

  it('handles graph keyboard navigation separately from node keyboard selection', () => {
    const selected = vi.fn(), f = fixture(echo, selected), preventDefault = vi.fn()
    const original = f.graph.getAttribute('viewBox')!
    selected.mockClear()
    f.graph.fire('keydown', { key: 'ArrowRight', preventDefault })
    expect(f.graph.getAttribute('viewBox')).not.toBe(original)
    expect(preventDefault).toHaveBeenCalledOnce()
    f.graph.fire('keydown', { key: '+' }); f.graph.fire('keydown', { key: '0' })
    expect(f.graph.getAttribute('viewBox')).toBe(original)
    f.graph.fire('keydown', { target: f.node('start'), key: 'ArrowRight', preventDefault })
    expect(f.graph.getAttribute('viewBox')).toBe(original)
    expect(selected).not.toHaveBeenCalled()
    f.node('start').fire('keydown', { key: 'Enter', preventDefault })
    expect(selected).toHaveBeenLastCalledWith('start')
    expect(f.get('execution-overlay').hidden).toBe(true)
  })

  it('pans only the background and stops moving after pointer cancellation', () => {
    const selected = vi.fn(), f = fixture(echo, selected)
    const original = f.graph.getAttribute('viewBox')!
    selected.mockClear()
    f.graph.fire('pointerdown', { target: f.node('start'), clientX: 100, clientY: 100, pointerId: 1 })
    f.graph.fire('pointermove', { clientX: 200, clientY: 200 })
    expect(f.graph.getAttribute('viewBox')).toBe(original)
    f.graph.fire('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 })
    f.graph.fire('pointermove', { clientX: 200, clientY: 200 })
    const moved = f.graph.getAttribute('viewBox')!
    expect(moved).not.toBe(original)
    expect(moved.split(' ').map(Number).every(Number.isFinite)).toBe(true)
    f.graph.fire('pointercancel'); f.graph.fire('pointermove', { clientX: 300, clientY: 300 })
    expect(f.graph.getAttribute('viewBox')).toBe(moved)
    expect(selected).not.toHaveBeenCalled()
    expect(f.get('execution-overlay').hidden).toBe(true)
  })

  it('reports graph-qualified selections separately from the backward-compatible node callback', () => {
    const selected = vi.fn(), qualified = vi.fn(), f = fixture(JSON.stringify(renderTemplate('expense-check')), selected, qualified)
    expect(qualified).toHaveBeenLastCalledWith(null)
    f.node('each').fire(); expect(selected).toHaveBeenLastCalledWith('each')
    expect(qualified).toHaveBeenLastCalledWith({ nodeId: 'each', graphScope: 'workflow' })
    f.get('detail-actions').children[0]!.fire(); expect(qualified).toHaveBeenLastCalledWith(null)
    f.node('item').fire(); expect(qualified).toHaveBeenLastCalledWith({ nodeId: 'item', graphScope: 'workflow/each' })
  })
  it('notifies graph selection without mutation and preserves breakpoint metadata when exploring a loop body', () => {
    const selected = vi.fn(), f = fixture(JSON.stringify(renderTemplate('expense-check')), selected)
    expect(selected).toHaveBeenLastCalledWith(null)
    f.controller.setBreakpoints!({ revision: f.preview.revision!, enabled: ['item'], hit: { nodeId: 'item', iteration: 2 } })
    f.node('each').fire(); expect(selected).toHaveBeenLastCalledWith('each')
    f.get('detail-actions').children[0]!.fire(); expect(selected).toHaveBeenLastCalledWith(null)
    expect(f.node('item').getAttribute('data-breakpoint')).toBe('hit')
    expect(f.node('item').getAttribute('aria-label')).toContain('iteration 2')
    f.node('item').fire(); expect(selected).toHaveBeenLastCalledWith('item')
  })
  it('labels configured, draft and hit breakpoints independently from execution state and clears stale overlays', () => {
    const f = fixture(), value = { revision: f.preview.revision!, enabled: ['start'], draft: ['result'] }
    f.node('start').fire(); f.get('zoom-in').fire(); const view = f.graph.getAttribute('viewBox')
    f.controller.setBreakpoints!(value)
    expect(f.node('start').getAttribute('aria-label')).toContain('draft remove')
    expect(f.node('result').querySelector('[data-breakpoint-label]')!.textContent).toContain('draft add')
    expect(f.node('result').getAttribute('data-execution')).toBe('none')
    expect(f.node('start').getAttribute('aria-pressed')).toBe('true'); expect(f.graph.getAttribute('viewBox')).toBe(view)
    value.draft.length = 0 // Caller changes never mutate retained overlay state.
    f.controller.setExecution(null)
    expect(f.node('result').getAttribute('aria-label')).toContain('draft add')
    f.controller.setBreakpoints!({ revision: f.preview.revision!, enabled: ['start'], hit: { nodeId: 'start' } })
    expect(f.node('start').getAttribute('data-breakpoint')).toBe('hit')
    expect(() => f.controller.setBreakpoints!({ revision: 'other', enabled: ['start'] })).toThrow('mismatch')
    expect(f.node('start').getAttribute('data-breakpoint')).toBe('none')
    expect(f.node('start').querySelector('[data-breakpoint-label]')!.textContent).toBe('')
  })
  it('keeps portable graphs evidence-free and applies status with text plus attributes without resetting view/selection', () => {
    const f = fixture(), run = { id: randomUUID(), revision: f.preview.revision, status: 'paused', nodeId: 'start', steps: [] }
    expect(f.get('execution-overlay').hidden).toBe(true)
    expect(f.node('start').getAttribute('data-execution')).toBe('none')
    f.node('start').fire(); f.get('zoom-in').fire()
    const viewBox = f.graph.getAttribute('viewBox')
    f.controller.setExecution(projectPreviewExecution(f.preview, run))
    expect(f.get('execution-overlay').hidden).toBe(false)
    expect(f.node('start').getAttribute('data-execution')).toBe('next')
    expect(f.node('start').getAttribute('aria-pressed')).toBe('true')
    expect(f.node('start').getAttribute('aria-label')).toContain('not executed')
    expect(f.node('start').querySelector('[data-execution-label]')!.textContent).toContain('not executed')
    expect(JSON.parse(f.get('detail-execution-body').textContent)).toMatchObject({ recordedResults: 0, latestRecords: [] })
    expect(f.graph.getAttribute('viewBox')).toBe(viewBox)
    f.controller.setExecution(null)
    expect(f.get('execution-overlay').hidden).toBe(true); expect(f.get('detail-execution').hidden).toBe(true)
    expect(f.node('start').querySelector('[data-execution-label]')!.textContent).toBe('')
  })

  it('restores scoped loop metadata on scope changes, never carrying a parent-node selection into a body', () => {
    const f = fixture(JSON.stringify(renderTemplate('expense-check')))
    const receipt = { id: randomUUID(), revision: f.preview.revision, status: 'paused', nodeId: 'item', scope: { loop: 'each', index: 1 },
      steps: [{ nodeId: 'start' }, { nodeId: 'item', scope: { loop: 'each', index: 0 }, attemptId: randomUUID(), durationMs: 12 },
        { nodeId: 'each', scope: { loop: 'each', index: 0 } }] }
    f.controller.setExecution(projectPreviewExecution(f.preview, receipt))
    expect(f.node('each').getAttribute('data-execution')).toBe('active-loop')
    f.node('each').fire(); f.get('detail-actions').children[0]!.fire()
    expect(f.get('scope').value).toBe('workflow/each')
    expect(f.get('detail-execution').hidden).toBe(true)
    expect(f.node('item').getAttribute('data-execution')).toBe('next')
    f.node('item').fire()
    expect(JSON.parse(f.get('detail-execution-body').textContent)).toMatchObject({ currentIteration: 1, iterations: [0],
      timing: { recordedDurationMs: 12, timedResults: 1 }, latestRecords: [{ iteration: 0 }] })
    f.get('scope').value = 'workflow'; f.get('scope').fire('change')
    expect(f.node('each').getAttribute('data-execution')).toBe('active-loop')
  })

  it('clears highlights before rejecting another revision', () => {
    const f = fixture(), run = { id: randomUUID(), revision: f.preview.revision, status: 'paused', nodeId: 'start', steps: [] }
    const evidence = projectPreviewExecution(f.preview, run); f.controller.setExecution(evidence)
    expect(() => f.controller.setExecution({ ...evidence, revision: 'other' })).toThrow('revision mismatch')
    expect(f.get('execution-overlay').hidden).toBe(true)
    expect(f.node('start').getAttribute('data-execution')).toBe('none')
    expect(f.get('detail-execution-body').textContent).toBe('')
  })

  it('assigns authored markup-looking labels only as text', () => {
    const workflow: any = renderTemplate('expense-check'), hostile = '<img src=x onerror=alert(1)>'
    workflow.spec.nodes.start.title = hostile
    const f = fixture(JSON.stringify(workflow)); f.node('start').fire()
    expect(f.get('detail-title').textContent).toBe(hostile)
    expect(f.node('start').getAttribute('aria-label')).toContain(hostile)
    expect(f.graph.querySelectorAll('img')).toHaveLength(0)
  })

  it('assigns hostile recorded summary and failure text without creating markup', () => {
    const f = fixture(), hostile = '</pre><img src=x onerror=alert(1)>'
    const evidence = projectPreviewExecution(f.preview, { id: randomUUID(), revision: f.preview.revision,
      status: 'failed', nodeId: 'start', steps: [] })
    evidence.summary = hostile
    evidence.graphs[0]!.nodes.find(node => node.id === 'start')!.code = hostile
    f.controller.setExecution(evidence); f.node('start').fire()
    expect(f.get('execution-summary').textContent).toBe(hostile)
    expect(JSON.parse(f.get('detail-execution-body').textContent).code).toBe(hostile)
    expect(f.get('execution-summary').children).toHaveLength(0)
    expect(f.get('detail-execution-body').children).toHaveLength(0)
    expect(f.graph.querySelectorAll('img')).toHaveLength(0)
  })
})
