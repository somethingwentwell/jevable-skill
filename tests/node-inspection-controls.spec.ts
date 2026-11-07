import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { runInNewContext, Script } from 'node:vm'
import { createHash } from 'node:crypto'
import { liveNodeInspectionControls } from '../src/preview/node-inspection-controls.ts'
import { projectPreviewExecution } from '../src/preview/execution.ts'
import { createPreview } from '../src/preview/model.ts'
import { renderLivePage } from '../src/preview/live-page.ts'
import { renderTemplate } from '../src/templates/index.ts'

// Serialized DOM/controller doubles, not browser rendering, security or accessibility qualification.
class Element {
  value = ''; textContent = ''; disabled = false; children: Element[] = []
  listeners = new Map<string, (() => void)[]>()
  append(child: Element) { this.children.push(child) }
  replaceChildren() { this.children = [] }
  addEventListener(name: string, handler: () => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], handler]) }
  fire(name = 'click') { for (const fn of this.listeners.get(name) ?? []) fn() }
}
const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const turn = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
function fixture(yaml = source) {
  const preview = createPreview(yaml), elements = new Map<string, Element>()
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)! }
  const window = new Element(), document = { getElementById: get, createElement: () => new Element() }
  let current: any = { preview, session: 'private-session', receipt: { id: randomUUID(), revision: preview.revision,
    status: 'completed', checkpointSha256: 'a'.repeat(64), steps: [{ nodeId: 'start' }, { nodeId: 'result' }] } }
  const response = (command: any) => ({ schemaVersion: 1, format: 'jevable.preview-node-inspection/v1', privateInspection: true,
    runId: command.id, revision: preview.revision, checkpointSha256: command.expectedCheckpointSha256, selection: command.selection,
    kind: 'node-result', status: 'settled', input: { status: 'unavailable' }, output: { status: 'recorded', value: '<script>PRIVATE_VALUE</script>' } })
  const request = vi.fn(async (command: any): Promise<any> => response(command))
  const controls = runInNewContext(`(${liveNodeInspectionControls.toString()})(ctx, (${projectPreviewExecution.toString()}))`,
    { document, window, TextEncoder, ctx: { current: () => current, request } }) as ReturnType<typeof liveNodeInspectionControls>
  return { controls, get, request, response, window, current: () => current,
    update: (value: any) => { current = value; controls.observe() } }
}
describe('serialized explicit selected-node reads (controller doubles)', () => {
  it.each(['loaded', 'pending', 'failed'] as const)('resets the reading notice when a %s selection changes, without another read', async phase => {
    const f = fixture(JSON.stringify(renderTemplate('expense-check')))
    f.update({ ...f.current(), receipt: { ...f.current().receipt, steps: [
      { nodeId: 'start' }, { nodeId: 'item', scope: { loop: 'each', index: 0 }, attemptId: randomUUID() },
      { nodeId: 'each', scope: { loop: 'each', index: 0 } },
      { nodeId: 'item', scope: { loop: 'each', index: 1 }, attemptId: randomUUID() },
      { nodeId: 'each', scope: { loop: 'each', index: 1 } },
    ] } })
    f.controls.select({ nodeId: 'item', graphScope: 'workflow/each' })
    let release: ((value: unknown) => void) | undefined
    if (phase === 'pending') f.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    if (phase === 'failed') f.request.mockRejectedValueOnce(Error('PRIVATE_DIAGNOSTIC'))
    f.get('node-private-load').fire(); await turn()
    const command = f.request.mock.calls[0]![0]
    if (phase === 'loaded') expect(f.get('node-private-message').textContent).toContain('Saved values loaded')
    if (phase === 'pending') expect(f.get('node-private-message').textContent).toContain('Reading this record')
    if (phase === 'failed') expect(f.get('node-private-message').textContent).toContain('unavailable, stale or invalid')
    f.get('node-private-record').value = '1'; f.get('node-private-record').fire('change')
    expect(f.get('node-private-message').textContent).toBe('Choose Show saved values to read the selected result.')
    for (const id of ['node-private-input', 'node-private-output', 'node-private-receipt']) expect(f.get(id).textContent).toBe('')
    expect(f.request).toHaveBeenCalledTimes(1); expect(f.get('node-private-load').disabled).toBe(false)
    if (release) { release(f.response(command)); await turn(); expect(f.get('node-private-output').textContent).toBe('') }
    expect(f.get('node-private-message').textContent).toBe('Choose Show saved values to read the selected result.')
    f.get('node-private-load').fire(); await turn()
    expect(f.request).toHaveBeenCalledTimes(2)
    expect(f.request.mock.calls[1]![0].selection.record).toEqual({ kind: 'step', index: 1 })
    expect(f.request.mock.calls[1]![0].expectedCheckpointSha256).toBe('a'.repeat(64))
  })
  it('treats an absent receipt as no selection rather than throwing or reading private data', () => {
    const f = fixture(); f.update({ ...f.current(), receipt: undefined })
    expect(() => f.controls.select({ nodeId: 'start', graphScope: 'workflow' })).not.toThrow()
    expect(f.get('node-private-load').disabled).toBe(true); expect(f.request).not.toHaveBeenCalled()
  })
  it('selection/status refresh do not read private values; explicit load pins and text-renders only one record', async () => {
    const f = fixture(); expect(f.get('node-private-load').disabled).toBe(true)
    f.controls.select({ nodeId: 'result', graphScope: 'workflow' }); f.controls.observe()
    expect(f.request).not.toHaveBeenCalled(); expect(f.get('node-private-record').children[0]!.textContent).toBe('Latest saved result')
    expect((f.get('node-private-picker') as any).hidden).toBe(true)
    f.get('node-private-load').fire(); await turn()
    expect(f.request).toHaveBeenCalledExactlyOnceWith({ operation: 'node.inspect', id: f.current().receipt.id,
      expectedCheckpointSha256: 'a'.repeat(64), selection: { nodeId: 'result', graphScope: 'workflow', record: { kind: 'step', index: 1 } } })
    expect(f.get('node-private-output').textContent).toContain('<script>PRIVATE_VALUE</script>')
    expect(f.get('node-private-output').children).toHaveLength(0)
    expect(f.get('node-private-input').textContent).toContain('Nothing was reconstructed')
    f.controls.observe(); expect(f.get('node-private-output').textContent).toContain('PRIVATE_VALUE')
    f.get('node-private-clear').fire(); expect(f.get('node-private-output').textContent).toBe(''); expect(f.request).toHaveBeenCalledTimes(1)
  })
  it.each(['checkpoint', 'run', 'session', 'node', 'scope', 'disconnect', 'pagehide', 'clear'])('invalidates a held response on %s changes', async change => {
    const f = fixture(); let release!: (value: unknown) => void
    f.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    f.controls.select({ nodeId: 'result', graphScope: 'workflow' }); f.get('node-private-load').fire()
    const original = structuredClone(f.current()), command = f.request.mock.calls[0]![0]
    if (change === 'checkpoint') f.update({ ...original, receipt: { ...original.receipt, checkpointSha256: 'b'.repeat(64) } })
    if (change === 'run') f.update({ ...original, receipt: { ...original.receipt, id: randomUUID() } })
    if (change === 'session') f.update({ ...original, session: 'replacement' })
    if (change === 'node') f.controls.select({ nodeId: 'start', graphScope: 'workflow' })
    if (change === 'scope') f.controls.select(null)
    if (change === 'disconnect') f.update(undefined)
    if (change === 'pagehide') f.window.fire('pagehide')
    if (change === 'clear') f.get('node-private-clear').fire()
    // Returning to the same selection cannot resurrect a superseded response.
    f.update(original); f.controls.select({ nodeId: 'result', graphScope: 'workflow' })
    release(f.response(command)); await turn()
    expect(f.get('node-private-output').textContent).toBe(''); expect(f.request).toHaveBeenCalledTimes(1)
    expect(f.get('node-private-load').disabled).toBe(false)
  })
  it.each(['identity', 'selection', 'checkpoint', 'field', 'oversize', 'rejection'])('refuses %s response without rendering private diagnostics or retrying', async fault => {
    const f = fixture(); f.controls.select({ nodeId: 'result', graphScope: 'workflow' })
    f.request.mockImplementationOnce(async command => {
      if (fault === 'rejection') throw Error('PRIVATE_DIAGNOSTIC')
      const result: any = f.response(command)
      if (fault === 'identity') result.runId = randomUUID()
      if (fault === 'selection') result.selection = { ...command.selection, nodeId: 'start' }
      if (fault === 'checkpoint') result.checkpointSha256 = 'b'.repeat(64)
      if (fault === 'field') result.input = { status: 'unavailable', value: 'PRIVATE_DIAGNOSTIC' }
      if (fault === 'oversize') result.output.value = 'x'.repeat(16_000_001)
      return result
    })
    f.get('node-private-load').fire(); await turn()
    expect(f.get('node-private-output').textContent).toBe(''); expect(f.get('node-private-message').textContent).toContain('unavailable, stale or invalid')
    expect(f.get('node-private-message').textContent).not.toContain('PRIVATE_DIAGNOSTIC'); expect(f.request).toHaveBeenCalledTimes(1)
  })
  it('offers exact zero-based loop iterations and checkpoints without implying execution', () => {
    const f = fixture(JSON.stringify(renderTemplate('expense-check'))), receipt = { ...f.current().receipt, status: 'paused', nodeId: 'item',
      scope: { loop: 'each', index: 1 }, steps: [{ nodeId: 'start' }, { nodeId: 'item', scope: { loop: 'each', index: 0 }, attemptId: randomUUID() },
        { nodeId: 'each', scope: { loop: 'each', index: 0 } }] }
    f.update({ ...f.current(), receipt }); f.controls.select({ nodeId: 'item', graphScope: 'workflow/each' })
    expect(f.get('node-private-record').children.map(item => item.textContent)).toEqual([
      'Paused here · round 2', 'Latest saved result · round 1'])
    expect((f.get('node-private-picker') as any).hidden).toBe(false)
    expect(f.request).not.toHaveBeenCalled()
    f.controls.select({ nodeId: 'each', graphScope: 'workflow' })
    expect(f.get('node-private-record').children).toHaveLength(1) // Active loop is not the body checkpoint.
  })
  it('admits server-normalized selection key order without accepting a changed selector', async () => {
    const f = fixture(); f.controls.select({ nodeId: 'result', graphScope: 'workflow' })
    f.request.mockImplementationOnce(async command => ({ ...f.response(command), selection: {
      graphScope: command.selection.graphScope, nodeId: command.selection.nodeId, record: command.selection.record } }))
    f.get('node-private-load').fire(); await turn(); expect(f.get('node-private-output').textContent).toContain('PRIVATE_VALUE')
  })
  it('serializes the controller in the fixed live script with matching CSP hash and no private values', () => {
    const page = renderLivePage(randomUUID(), 'test-protocol'), script = page.html.match(/<script>([\s\S]*?)<\/script>/)![1]!
    expect(() => new Script(script)).not.toThrow(); expect(script).toContain('node.inspect')
    expect(page.csp).toContain(`sha256-${createHash('sha256').update(script).digest('base64')}`)
    expect(page.html).not.toContain('PRIVATE_VALUE'); expect(page.html).toContain('node-private-load')
  })
})
