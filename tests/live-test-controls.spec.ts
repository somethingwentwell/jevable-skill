import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { liveTestControls } from '../src/preview/test-controls.ts'
import { runInNewContext } from 'node:vm'

/** Controller doubles only: no browser, layout or CSP enforcement claim. */
class Element {
  value = ''; textContent = ''; disabled = false; checked = false
  children: Element[] = []; handlers = new Map<string, (() => void)[]>()
  addEventListener(event: string, fn: () => void) { this.handlers.set(event, [...this.handlers.get(event) ?? [], fn]) }
  append(child: Element) { this.children.push(child) }
  replaceChildren() { this.children = [] }
  fire(event = 'click') { for (const fn of this.handlers.get(event) ?? []) fn() }
}
afterEach(() => vi.unstubAllGlobals())
function fixture(initialMode?: 'api') {
  const elements = new Map<string, Element>(), get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!
  }
  get('live-input').value = JSON.stringify('private input')
  vi.stubGlobal('document', { getElementById: get, createElement: () => new Element() })
  const state: { testId?: string; batchId?: string; pendingBatch?: boolean; batchTriggerMode?: 'api'; runId?: string } = {}
  const stored: any[] = [], records = new Map<string, any>(), calls: any[] = [], failures: unknown[] = [], messages: string[] = []
  let failGeneration = false, mode = initialMode, connected = true, scope = 'fixture-preview-1', attachedTest = true
  const testPin = { id: randomUUID(), generation: 1, sha256: 'a'.repeat(64) }
  const windowHandlers = new Map<string, () => void>()
  const request = vi.fn(async (command: any) => {
    calls.push(command)
    if (command.operation === 'tests.list') return { tests: [...records.values()].map(item => ({ ...item, title: item.definition.title })) }
    if (command.operation === 'tests.show') return records.get(command.id)
    if (command.operation === 'tests.create' || command.operation === 'tests.edit') {
      expect(stored.at(-1).testId).toBe(command.id)
      const record = { id: command.id, generation: (records.get(command.id)?.generation ?? 0) + 1, sha256: 'a'.repeat(64), status: 'draft',
        definition: { title: command.title, input: command.input, expectations: command.expectations,
          ...(command.triggerMode === undefined ? {} : { triggerMode: command.triggerMode }) } }
      records.set(record.id, record); return record
    }
    if (command.operation === 'tests.accept') {
      const record = { ...records.get(command.id), status: 'accepted', generation: command.expectedGeneration + 1 }
      records.set(record.id, record); return record
    }
    if (command.operation === 'tests.archive') {
      const before = records.get(command.id)
      expect(command.expectedGeneration).toBe(before.generation); expect(command.reviewedSha256).toBe(before.sha256)
      const record = { ...before, generation: before.generation + 1, archived: command.archived }
      records.set(record.id, record); return record
    }
    if (command.operation === 'tests.generate') {
      expect(stored.at(-1)).toMatchObject({ batchId: command.id, pendingBatch: true })
      if (failGeneration) { failGeneration = false; throw Error('Lost response') }
      return { snapshot: { id: command.id, execution: 'not-run', cases: [] } }
    }
    if (command.operation === 'tests.generation') return { snapshot: { id: command.id, execution: 'not-run', cases: [] } }
    if (command.operation === 'tests.result') return { run: { id: command.runId }, assessment: 'passed', workflowStatus: 'waiting', terminal: false }
    throw Error('Unexpected operation')
  })
  const run = vi.fn(async (test: any) => {
    state.runId = randomUUID()
    return { test, run: { id: state.runId }, assessment: 'passed', workflowStatus: 'waiting', terminal: false }
  })
  const ctx = { request, run, state: () => connected ? state : undefined, testRun: () => state.runId && attachedTest ? testPin : undefined,
    scope: () => connected ? scope : undefined,
    retain: () => stored.push(structuredClone(state)), triggerMode: () => mode,
    canRun: () => true, message: (text: string) => messages.push(text), error: (error: unknown) => failures.push(error) }
  const controls = runInNewContext(`(${liveTestControls.toString()})(ctx)`, { ctx,
    document: { getElementById: get, createElement: () => new Element() }, crypto: { randomUUID },
    window: { addEventListener: (event: string, fn: () => void) => windowHandlers.set(event, fn) } }) as ReturnType<typeof liveTestControls>
  const click = async (id: string) => { get(id).fire(); await vi.waitFor(() => expect(get('test-create').disabled).toBe(false)) }
  return { get, state, stored, records, calls, failures, messages, run, request, controls, click, setMode: (value?: 'api') => { mode = value },
    connect: (value: boolean, nextScope = scope) => { connected = value; scope = nextScope; controls.observe() },
    pagehide: () => windowHandlers.get('pagehide')?.(), pageshow: () => windowHandlers.get('pageshow')?.(),
    failNextGeneration: () => { failGeneration = true }, setAttachedTest: (value: boolean) => { attachedTest = value; controls.observe() } }
}

describe('saved-test controls: explicit intent and immutable review', () => {
  it('does not offer an assessment for an ordinary workflow run without a saved-test identity', async () => {
    const f = fixture(); f.state.runId = randomUUID(); f.setAttachedTest(false)
    expect(f.get('test-result').disabled).toBe(true)
    await f.click('test-result')
    expect(f.request).not.toHaveBeenCalledWith(expect.objectContaining({ operation: 'tests.result' }))
    expect(f.failures).toEqual([])
    f.setAttachedTest(true)
    expect(f.get('test-result').disabled).toBe(false)
  })
  it('replaces a failed older-version read with scoped success without changing the newer draft or a workflow warning', async () => {
    const f = fixture('api')
    f.get('test-editor').value = JSON.stringify({ title: 'Earlier draft', input: 'EARLIER_INPUT', expectations: [{ kind: 'status', value: 'completed' }], triggerMode: 'api' })
    await f.click('test-create'); const older = structuredClone(f.records.get(f.state.testId!))
    f.get('test-editor').value = JSON.stringify({ title: 'Latest draft', input: 'NEWER_INPUT', expectations: [{ kind: 'status', value: 'completed' }], triggerMode: 'api' })
    await f.click('test-edit'); const latest = structuredClone(f.records.get(f.state.testId!))
    expect(latest.generation).toBe(2); expect(older.generation).toBe(1)
    const editor = f.get('test-editor').value, review = f.get('test-review').textContent
    f.messages.push('Workflow request is unresolved. Inspect the original run before retrying.')
    const messages = [...f.messages], count = f.request.mock.calls.length
    f.request.mockImplementationOnce(async () => ({ test: { id: latest.id }, versions: [
      { generation: 1, status: 'draft', operation: 'create', sha256: older.sha256 },
      { generation: 2, status: 'draft', operation: 'edit', sha256: latest.sha256 }] }))
    await f.click('test-history-load')
    expect(f.get('test-history-status').textContent).toContain('Saved versions loaded')
    f.get('test-history-list').value = '1'; f.get('test-history-list').fire('change')
    expect(f.get('test-history-status').textContent).toBe('')
    f.request.mockImplementationOnce(async () => { throw Error('RAW_PRIVATE_UPSTREAM_ERROR') })
    await f.click('test-history-inspect')
    expect(f.get('test-history-detail').textContent).toBe('')
    expect(f.get('test-history-status').textContent).toContain('We could not read this saved version')
    expect(f.get('test-history-status').textContent).not.toContain('RAW_PRIVATE_UPSTREAM_ERROR')
    expect(f.messages).toEqual(messages); expect(f.failures).toEqual([])
    f.request.mockImplementationOnce(async () => older)
    await f.click('test-history-inspect')
    expect(JSON.parse(f.get('test-history-detail').textContent)).toEqual(older)
    expect(f.get('test-history-status').textContent).toContain('Saved version 1 loaded for viewing')
    expect(f.get('test-history-status').textContent).not.toContain('could not')
    expect(f.get('test-editor').value).toBe(editor); expect(f.get('test-review').textContent).toBe(review)
    expect(f.records.get(latest.id)).toEqual(latest); expect(f.messages).toEqual(messages)
    expect(f.get('test-authorize').checked).toBe(false); expect(f.get('test-run').disabled).toBe(true)
    expect(f.get('test-edit').disabled).toBe(false); expect(f.get('test-accept').disabled).toBe(false)
    expect(f.request.mock.calls.slice(count).map(([command]) => command)).toEqual([
      { operation: 'tests.history', id: latest.id },
      { operation: 'tests.show', id: latest.id, generation: 1 },
      { operation: 'tests.show', id: latest.id, generation: 1 }])
    expect(f.run).not.toHaveBeenCalled()
    f.get('test-history-clear').fire(); expect(f.get('test-history-status').textContent).toBe('')
  })
  it('keeps failed history metadata feedback local and explicitly recovers without accepting or running', async () => {
    const f = fixture(); await f.click('test-create'); const current = structuredClone(f.records.get(f.state.testId!))
    const messages = [...f.messages], count = f.request.mock.calls.length
    f.request.mockImplementationOnce(async () => { throw Error('SECRET_HOST_DIAGNOSTIC') })
    await f.click('test-history-load')
    expect(f.get('test-history-status').textContent).toContain('We could not read the saved versions')
    expect(f.get('test-history-status').textContent).not.toContain('SECRET_HOST_DIAGNOSTIC')
    expect(f.get('test-history-list').children).toEqual([]); expect(f.get('test-history-inspect').disabled).toBe(true)
    f.request.mockImplementationOnce(async () => ({ test: { id: current.id }, versions: [
      { generation: 1, status: 'draft', operation: 'create', sha256: current.sha256 }] }))
    await f.click('test-history-load')
    expect(f.get('test-history-status').textContent).toContain('Saved versions loaded')
    expect(f.request.mock.calls.slice(count).map(([command]) => command.operation)).toEqual(['tests.history', 'tests.history'])
    expect(f.messages).toEqual(messages); expect(f.failures).toEqual([]); expect(f.records.get(current.id)).toEqual(current)
    expect(f.get('test-authorize').checked).toBe(false); expect(f.run).not.toHaveBeenCalled()
  })
  it.each(['id', 'generation', 'sha256'])('does not announce a successful private history read with mismatched %s', async field => {
    const f = fixture(); await f.click('test-create'); const current = structuredClone(f.records.get(f.state.testId!))
    f.request.mockImplementationOnce(async () => ({ test: { id: current.id }, versions: [
      { generation: 1, status: 'draft', operation: 'create', sha256: current.sha256 }] }))
    await f.click('test-history-load'); f.get('test-history-list').value = '1'; f.get('test-history-list').fire('change')
    const editor = f.get('test-editor').value, review = f.get('test-review').textContent, messages = [...f.messages]
    f.request.mockImplementationOnce(async () => ({ ...current, [field]: field === 'id' ? randomUUID() : field === 'generation' ? 2 : 'b'.repeat(64) }))
    await f.click('test-history-inspect')
    expect(f.get('test-history-detail').textContent).toBe('')
    expect(f.get('test-history-status').textContent).toContain('We could not read this saved version')
    expect(f.get('test-history-status').textContent).not.toContain('loaded for viewing')
    expect(f.get('test-editor').value).toBe(editor); expect(f.get('test-review').textContent).toBe(review)
    expect(f.messages).toEqual(messages); expect(f.failures).toEqual([]); expect(f.run).not.toHaveBeenCalled()
  })
  it.each(['resolve', 'reject'])('fences late private-read %s feedback after choosing another historical version', async outcome => {
    const f = fixture(); await f.click('test-create'); const current = structuredClone(f.records.get(f.state.testId!))
    f.request.mockImplementationOnce(async () => ({ test: { id: current.id }, versions: [
      { generation: 1, status: 'draft', operation: 'create', sha256: current.sha256 },
      { generation: 2, status: 'draft', operation: 'edit', sha256: 'b'.repeat(64) }] }))
    await f.click('test-history-load'); f.get('test-history-list').value = '1'; f.get('test-history-list').fire('change')
    let resolve!: (value: any) => void, reject!: (reason: unknown) => void
    f.request.mockImplementationOnce(async () => new Promise((yes, no) => { resolve = yes; reject = no }))
    f.get('test-history-inspect').fire(); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    expect(f.get('test-history-status').textContent).toContain('Reading this saved version')
    f.get('test-history-list').value = '2'; f.get('test-history-list').fire('change')
    const count = f.request.mock.calls.length, messages = [...f.messages]
    if (outcome === 'resolve') resolve(current); else reject(Error('LATE_PRIVATE_ERROR'))
    await vi.waitFor(() => expect(f.get('test-create').disabled).toBe(false))
    expect(f.get('test-history-detail').textContent).toBe(''); expect(f.get('test-history-status').textContent).toBe('')
    expect(f.get('test-history-list').value).toBe('2'); expect(f.request.mock.calls).toHaveLength(count)
    expect(f.messages).toEqual(messages); expect(f.failures).toEqual([]); expect(f.run).not.toHaveBeenCalled()
  })
  it('inspects a historical definition separately without replacing the latest editor or action guard', async () => {
    const f = fixture(); await f.click('test-create'); f.get('test-authorize').checked = true; await f.click('test-accept')
    const current = structuredClone(f.records.get(f.state.testId!)), draft = { ...current, generation: 1, status: 'draft',
      definition: { ...current.definition, input: 'OLD_PRIVATE_INPUT' } }
    const editor = f.get('test-editor').value, review = f.get('test-review').textContent
    f.request.mockImplementationOnce(async () => ({ test: { id: current.id }, versions: [
      { generation: 1, status: 'draft', operation: 'create', archived: false, sha256: draft.sha256 },
      { generation: 2, status: 'accepted', operation: 'accept', archived: false, sha256: current.sha256 }] }))
    await f.click('test-history-load')
    expect(f.get('test-history-list').children.map(item => item.value)).toEqual(['', '1', '2'])
    f.get('test-history-list').value = '1'; f.get('test-history-list').fire('change')
    f.request.mockImplementationOnce(async () => draft)
    await f.click('test-history-inspect')
    expect(f.request.mock.calls.at(-1)?.[0]).toEqual({ operation: 'tests.show', id: current.id, generation: 1 })
    expect(f.get('test-history-detail').textContent).toContain('OLD_PRIVATE_INPUT')
    expect(f.get('test-editor').value).toBe(editor); expect(f.get('test-review').textContent).toBe(review)
    expect(f.run).not.toHaveBeenCalled()
    f.get('test-authorize').checked = true; await f.click('test-archive')
    expect(f.calls.find(call => call.operation === 'tests.archive')).toMatchObject({ expectedGeneration: 2 })
    expect(f.get('test-history-detail').textContent).toBe('')
  })
  it.each(['clear', 'case', 'disconnect', 'scope', 'pagehide'])('fences a late private historical definition after %s', async change => {
    const f = fixture(); await f.click('test-create'); const id = f.state.testId!
    f.request.mockImplementationOnce(async () => ({ test: { id }, versions: [{ generation: 1, status: 'draft', operation: 'create', archived: false, sha256: 'a'.repeat(64) }] }))
    await f.click('test-history-load'); f.get('test-history-list').value = '1'; f.get('test-history-list').fire('change')
    let resolve!: (value: any) => void
    f.request.mockImplementationOnce(async () => new Promise(value => { resolve = value }))
    f.get('test-history-inspect').fire(); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    if (change === 'clear') f.get('test-history-clear').fire()
    if (change === 'case') { f.state.testId = randomUUID(); f.controls.observe(); f.state.testId = id; f.controls.observe() }
    if (change === 'disconnect') { f.connect(false); f.connect(true) }
    if (change === 'scope') { f.connect(true, 'other'); f.connect(true, 'fixture-preview-1') }
    if (change === 'pagehide') f.pagehide()
    const count = f.request.mock.calls.length
    resolve({ ...f.records.get(id), private: 'LATE_PRIVATE_HISTORY' })
    await new Promise(value => setTimeout(value, 0))
    expect(f.get('test-history-detail').textContent).toBe(''); expect(f.request.mock.calls).toHaveLength(count)
    expect(f.get('test-history-status').textContent).toBe('')
    expect(f.failures).toEqual([]); expect(f.run).not.toHaveBeenCalled()
  })
  it('fences a late history list after Clear without accepting or automatically reloading it', async () => {
    const f = fixture(); await f.click('test-create'); let resolve!: (value: any) => void
    f.request.mockImplementationOnce(async () => new Promise(value => { resolve = value }))
    f.get('test-history-load').fire(); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    f.get('test-history-clear').fire(); const count = f.request.mock.calls.length
    resolve({ test: { id: f.state.testId }, versions: [{ generation: 1, status: 'draft' }] })
    await new Promise(value => setTimeout(value, 0))
    expect(f.get('test-history-list').children).toEqual([]); expect(f.request.mock.calls).toHaveLength(count)
    expect(f.run).not.toHaveBeenCalled(); expect(f.failures).toEqual([])
  })
  it.each(['draft', 'accepted'])('archives and restores the exact %s case only with consent; never executes or changes its definition', async status => {
    const f = fixture(); await f.click('test-create')
    if (status === 'accepted') { f.get('test-authorize').checked = true; await f.click('test-accept') }
    const before = structuredClone(f.records.get(f.state.testId!)), count = f.calls.length
    expect(f.get('test-archive').disabled).toBe(false); expect(f.get('test-unarchive').disabled).toBe(true)
    await f.click('test-archive')
    expect(f.calls).toHaveLength(count); expect(f.failures).toHaveLength(1)
    f.get('test-authorize').checked = true; await f.click('test-archive')
    const archived = f.records.get(before.id)
    expect(archived).toEqual({ ...before, generation: before.generation + 1, archived: true })
    expect(f.calls.find(call => call.operation === 'tests.archive')).toEqual({ operation: 'tests.archive', id: before.id,
      expectedGeneration: before.generation, reviewedSha256: before.sha256, archived: true })
    expect(f.get('test-authorize').checked).toBe(false); expect(f.get('test-archive').disabled).toBe(true)
    for (const id of ['test-edit','test-accept','test-run']) expect(f.get(id).disabled).toBe(true)
    expect(f.get('test-unarchive').disabled).toBe(false)
    f.get('test-authorize').checked = true; await f.click('test-unarchive')
    expect(f.records.get(before.id)).toEqual({ ...before, generation: before.generation + 2, archived: false })
    expect(f.get('test-authorize').checked).toBe(false); expect(f.get('test-run').disabled).toBe(status !== 'accepted')
    expect(f.run).not.toHaveBeenCalled(); expect(f.calls.some(call => ['decide','cancel','advance'].includes(call.operation))).toBe(false)
  })
  it.each([true, false])('refuses lifecycle action archived=%s when the editor differs from the reviewed definition', async archived => {
    const f = fixture(); await f.click('test-create')
    if (!archived) { f.get('test-authorize').checked = true; await f.click('test-archive') }
    const draft = JSON.parse(f.get('test-editor').value); draft.input = 'UNSAVED_PRIVATE_CHANGE'
    f.get('test-editor').value = JSON.stringify(draft); f.get('test-authorize').checked = true
    const count = f.calls.length; await f.click(archived ? 'test-archive' : 'test-unarchive')
    expect(f.calls).toHaveLength(count); expect(f.failures.at(-1)).toMatchObject({ message: expect.stringContaining('Save or reload') })
    expect(f.run).not.toHaveBeenCalled()
  })
  it('does not retry an uncertain archive automatically or update its guard before explicit inspection', async () => {
    const f = fixture(); await f.click('test-create'); f.get('test-authorize').checked = true
    const before = structuredClone(f.records.get(f.state.testId!))
    f.request.mockImplementationOnce(async () => { throw Error('Lost lifecycle reply') })
    await f.click('test-archive')
    expect(f.request.mock.calls.at(-1)?.[0]).toMatchObject({ operation: 'tests.archive', expectedGeneration: before.generation })
    expect(f.get('test-authorize').checked).toBe(false); expect(f.failures.at(-1)).toMatchObject({ message: 'Lost lifecycle reply' })
    const count = f.request.mock.calls.length; await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.request.mock.calls).toHaveLength(count); expect(f.records.get(before.id)).toEqual(before)
    expect(f.state.testId).toBe(before.id); expect(f.run).not.toHaveBeenCalled()
  })
  it('ignores a late archive acknowledgement after disconnect without restoring private data or resubmitting', async () => {
    const f = fixture(); await f.click('test-create'); f.get('test-authorize').checked = true
    const before = structuredClone(f.records.get(f.state.testId!)); let resolve!: (value: any) => void
    f.request.mockImplementationOnce(async () => new Promise(value => { resolve = value }))
    f.get('test-archive').fire(); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    f.connect(false); f.connect(true); const count = f.request.mock.calls.length
    resolve({ ...before, generation: before.generation + 1, archived: true })
    await new Promise(value => setTimeout(value, 0))
    expect(f.get('test-review').textContent).toBe(''); expect(f.get('test-editor').value).not.toContain('private input')
    expect(f.request.mock.calls).toHaveLength(count); expect(f.failures).toEqual([]); expect(f.run).not.toHaveBeenCalled()
  })
  it('refuses even a delayed host refresh after pagehide, and pageshow enables explicit reads without automatically restoring private data', async () => {
    const f = fixture(); f.state.batchId = randomUUID(); f.state.runId = randomUUID()
    f.pagehide(); await f.controls.refresh()
    expect(f.calls).toEqual([]); expect(f.get('test-refresh').disabled).toBe(true)
    f.pageshow()
    expect(f.get('test-refresh').disabled).toBe(false); expect(f.calls).toEqual([])
    expect(f.get('test-report').textContent).toBe(''); expect(f.get('test-batch').textContent).toBe('')
    await f.controls.refresh()
    expect(f.calls.map(call => call.operation)).toEqual(['tests.list', 'tests.generation'])
    expect(f.run).not.toHaveBeenCalled()
  })
  it.each(['disconnect', 'scope', 'run', 'clear', 'pagehide'])('does not restore a late admitted-run report after %s or submit another run', async change => {
    const f = fixture(); await f.click('test-create'); f.get('test-authorize').checked = true; await f.click('test-accept')
    const runId = randomUUID(); let resolve!: (value: any) => void
    f.run.mockImplementationOnce(async () => {
      f.state.runId = runId
      return new Promise(value => { resolve = value })
    })
    f.get('test-run').fire(); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    if (change === 'disconnect') { f.connect(false); f.connect(true) }
    if (change === 'scope') { f.connect(true, 'other-preview'); f.connect(true, 'fixture-preview-1') }
    if (change === 'run') { f.state.runId = randomUUID(); f.controls.observe(); f.state.runId = runId; f.controls.observe() }
    if (change === 'clear') f.get('test-result-clear').fire()
    if (change === 'pagehide') f.pagehide()
    resolve({ run: { id: runId }, assessment: 'passed', workflowStatus: 'waiting', terminal: false, private: 'LATE_ADMITTED_RUN_REPORT' })
    await new Promise(value => setTimeout(value, 0))
    expect(f.get('test-report').textContent).not.toContain('LATE_ADMITTED_RUN_REPORT')
    expect(f.run).toHaveBeenCalledOnce(); expect(f.state.runId).toBe(runId); expect(f.failures).toEqual([])
    expect(f.calls.some(call => ['decide', 'cancel', 'advance'].includes(call.operation))).toBe(false)
  })
  it.each(['tests.list', 'tests.show', 'tests.generation', 'tests.generate'])('discards late %s data after a session change without applying its receipt or making more requests', async operation => {
    const f = fixture(), testId = randomUUID(), batchId = randomUUID()
    f.records.set(testId, { id: testId, generation: 1, sha256: 'a'.repeat(64), status: 'draft',
      definition: { title: 'PRIVATE_OLD_CASE', input: 'PRIVATE_OLD_INPUT', expectations: [{ kind: 'status', value: 'waiting' }] } })
    f.state.testId = testId; f.state.batchId = batchId; f.state.pendingBatch = true
    let resolve!: (value: any) => void
    const original = f.request.getMockImplementation()!
    f.request.mockImplementation(async command => command.operation === operation ? new Promise(value => { resolve = value }) : original(command))
    if (operation === 'tests.generate') f.get('test-generate').fire()
    else void f.controls.refresh()
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    f.connect(false); const count = f.request.mock.calls.length
    resolve(operation === 'tests.list' ? { tests: [{ title: 'LATE_PRIVATE_LIST' }] }
      : operation === 'tests.show' ? f.records.get(testId) : { private: 'LATE_PRIVATE_BATCH' })
    await new Promise(value => setTimeout(value, 0))
    for (const id of ['test-review', 'test-batch', 'test-report']) expect(f.get(id).textContent).toBe('')
    expect(f.get('test-editor').value).not.toContain('PRIVATE_OLD')
    expect(f.request.mock.calls).toHaveLength(count); expect(f.failures).toEqual([])
    expect(f.state.pendingBatch).toBe(true); expect(f.state.batchId).toBe(batchId)
    expect(f.run).not.toHaveBeenCalled()
  })
  it('does not show a stale definition after changing cases and returning to the same ID', async () => {
    const f = fixture(), id = randomUUID(), other = randomUUID(); f.state.testId = id; f.controls.observe()
    let resolve!: (value: any) => void
    f.request.mockImplementationOnce(async () => new Promise(value => { resolve = value }))
    f.get('test-list').value = id; f.get('test-list').fire('change')
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    f.state.testId = other; f.controls.observe(); f.state.testId = id; f.controls.observe()
    resolve({ id, definition: { title: 'STALE_PRIVATE_CASE', input: 'STALE_PRIVATE_INPUT', expectations: [] } })
    await new Promise(value => setTimeout(value, 0))
    expect(f.get('test-review').textContent).toBe(''); expect(f.get('test-editor').value).not.toContain('STALE_PRIVATE')
    expect(f.failures).toEqual([])
  })
  it('suppresses a rejected old private read and never blocks a new session action with its old finalizer', async () => {
    const f = fixture(); f.state.runId = randomUUID(); f.controls.observe()
    let reject!: (error: Error) => void
    f.request.mockImplementationOnce(async () => new Promise((_value, error) => { reject = error }))
    f.get('test-result').fire(); await vi.waitFor(() => expect(reject).toBeTypeOf('function'))
    f.connect(false); f.connect(true, 'next-session')
    await f.click('test-create'); expect(f.get('test-review').textContent).toContain('draft')
    reject(Error('PRIVATE_OLD_READ_FAILURE')); await new Promise(value => setTimeout(value, 0))
    expect(f.failures).toEqual([]); expect(f.get('test-create').disabled).toBe(false)
    expect(f.get('test-review').textContent).toContain('draft'); expect(f.run).not.toHaveBeenCalled()
  })
  it('disconnects safely, clears all private displays/consent and disables actions without changing retained identities', async () => {
    const f = fixture(); await f.click('test-create')
    f.state.runId = randomUUID(); f.get('test-authorize').checked = true
    f.get('test-batch').textContent = 'PRIVATE_BATCH'; f.get('test-report').textContent = 'PRIVATE_REPORT'
    const identities = structuredClone(f.state), count = f.calls.length, stored = f.stored.length
    expect(() => f.connect(false)).not.toThrow()
    for (const id of ['test-review', 'test-batch', 'test-report']) expect(f.get(id).textContent).toBe('')
    expect(f.get('test-editor').value).not.toContain('private input')
    expect(f.get('test-authorize').checked).toBe(false)
    for (const id of ['test-create', 'test-edit', 'test-accept', 'test-run', 'test-result', 'test-refresh']) expect(f.get(id).disabled).toBe(true)
    expect(f.state).toEqual(identities); expect(f.calls).toHaveLength(count); expect(f.stored).toHaveLength(stored)
  })
  it.each(['disconnect', 'scope', 'run', 'clear', 'pagehide'])('fences a late private result after %s, including returning to the same original identity', async change => {
    const f = fixture(), runId = randomUUID(); f.state.runId = runId; f.controls.observe()
    let resolve!: (value: any) => void
    f.request.mockImplementationOnce(async () => new Promise(value => { resolve = value }))
    f.get('test-result').fire(); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    if (change === 'disconnect') { f.connect(false); f.connect(true) }
    if (change === 'scope') { f.connect(true, 'other-preview'); f.connect(true, 'fixture-preview-1') }
    if (change === 'run') { f.state.runId = randomUUID(); f.controls.observe(); f.state.runId = runId; f.controls.observe() }
    if (change === 'clear') f.get('test-result-clear').fire()
    if (change === 'pagehide') f.pagehide()
    resolve({ run: { id: runId }, assessment: 'passed', workflowStatus: 'waiting', terminal: false, private: 'LATE_PRIVATE_RESULT' })
    await new Promise(value => setTimeout(value, 0))
    expect(f.get('test-report').textContent).not.toContain('LATE_PRIVATE_RESULT')
    expect(f.failures).toEqual([]); expect(f.run).not.toHaveBeenCalled()
    expect(f.stored).toEqual([])
  })
  it('labels archived cases and disables mutations/new execution without hiding historical selection', async () => {
    const f = fixture(), id = randomUUID()
    f.records.set(id, { id, generation: 3, sha256: 'a'.repeat(64), status: 'accepted', archived: true,
      definition: { title: 'Retired case', input: 'private input', expectations: [{ kind: 'status', value: 'completed' }] } })
    f.state.testId = id; await f.click('test-refresh')
    expect(f.get('test-list').children.some(option => option.textContent.includes('archived'))).toBe(true)
    for (const key of ['test-edit', 'test-accept', 'test-run']) expect(f.get(key).disabled).toBe(true)
    await f.click('test-run'); await f.click('test-edit')
    expect(f.run).not.toHaveBeenCalled(); expect(f.calls.some(call => call.operation === 'tests.edit')).toBe(false)
  })
  it('preserves API mode through save, load and edit; entry copy only changes unsaved fields and revokes consent', async () => {
    const f = fixture('api')
    expect(JSON.parse(f.get('test-editor').value).triggerMode).toBe('api')
    await f.click('test-create'); expect(f.calls[0]).toMatchObject({ triggerMode: 'api' })
    f.setMode(); await f.controls.refresh()
    expect(JSON.parse(f.get('test-editor').value).triggerMode).toBe('api')
    f.get('test-authorize').checked = true; await f.click('test-use-entry')
    expect(JSON.parse(f.get('test-editor').value)).not.toHaveProperty('triggerMode')
    expect(f.get('test-authorize').checked).toBe(false)
    f.get('test-authorize').checked = true; await f.click('test-accept')
    expect(f.calls.some(c => c.operation === 'tests.accept')).toBe(false)
    await f.click('test-edit'); expect(f.calls.find(c => c.operation === 'tests.edit')).not.toHaveProperty('triggerMode')
    f.setMode('api'); const count = f.calls.length; await f.click('test-use-entry')
    expect(f.calls).toHaveLength(count); expect(JSON.parse(f.get('test-editor').value).triggerMode).toBe('api')
    await f.click('test-edit'); f.get('test-authorize').checked = true; await f.click('test-accept')
    f.setMode(); await f.click('test-run')
    expect(f.run).toHaveBeenCalledOnce(); expect(f.run.mock.calls[0]![0]).not.toHaveProperty('triggerMode')
  })
  it.each([null, false, 'manual', 'chat', 'webhook', ['api'], {}])('refuses malformed case mode %j before saving or authorizing', async mode => {
    const f = fixture(), draft = JSON.parse(f.get('test-editor').value)
    f.get('test-editor').value = JSON.stringify({ ...draft, triggerMode: mode }); await f.click('test-create')
    expect(f.failures).toHaveLength(1); expect(f.calls).toEqual([]); expect(f.stored).toEqual([])
  })
  it.each([undefined, 'api'] as const)('retries a lost generation with retained mode %s rather than a changed selector', async mode => {
    const f = fixture(mode); f.failNextGeneration(); await f.click('test-generate')
    const first = f.calls[0]; f.setMode(mode === 'api' ? undefined : 'api')
    expect(f.state.batchTriggerMode).toBe(mode)
    await f.click('test-generate')
    expect(f.calls[1]).toEqual(first); expect(f.stored[0].batchTriggerMode).toBe(mode)
    await f.click('test-generate')
    const latest = f.calls.filter(c => c.operation === 'tests.generate').at(-1)
    expect(latest.id).not.toBe(first.id); expect(latest.triggerMode).toBe(mode === 'api' ? undefined : 'api')
  })
  it('retries a historical pending batch with omitted mode even when the new selector is API', async () => {
    const f = fixture('api'), id = randomUUID()
    f.state.batchId = id; f.state.pendingBatch = true
    await f.click('test-generate')
    expect(f.calls[0]).toEqual({ operation: 'tests.generate', id, limit: 12 })
    expect(f.stored[0]).not.toHaveProperty('batchTriggerMode'); expect(f.run).not.toHaveBeenCalled()
  })
  it('copies only current input into an unsaved definition, clears review authority and makes no requests', async () => {
    const f = fixture(), definition = { title: 'Keep title', input: 'old', expectations: [{ kind: 'status', value: 'waiting' }] }
    f.get('test-editor').value = JSON.stringify(definition); f.get('test-authorize').checked = true
    await f.click('test-copy-input')
    expect(JSON.parse(f.get('test-editor').value)).toEqual({ ...definition, input: 'private input' })
    expect(f.get('test-authorize').checked).toBe(false); expect(f.calls).toEqual([]); expect(f.stored).toEqual([]); expect(f.run).not.toHaveBeenCalled()
    f.get('test-editor').value = 'INVALID_CASE_JSON'; await f.click('test-copy-input')
    expect(f.get('test-editor').value).toBe('INVALID_CASE_JSON'); expect(f.failures).toHaveLength(1)
  })
  it('refreshes only reads and never generates, accepts or runs restored identities', async () => {
    const f = fixture(), id = randomUUID()
    f.records.set(id, { id, generation: 2, sha256: 'a'.repeat(64), status: 'accepted',
      definition: { title: 'Existing', input: 'saved', expectations: [{ kind: 'status', value: 'completed' }] } })
    f.state.testId = id; f.state.batchId = randomUUID()
    await f.controls.refresh()
    expect(f.calls.map(call => call.operation)).toEqual(['tests.list', 'tests.show', 'tests.generation'])
    expect(f.run).not.toHaveBeenCalled()
  })

  it('requires explicit reviewed acceptance and runs only its returned accepted version', async () => {
    const f = fixture()
    await f.click('test-create')
    expect(f.calls[0].operation).toBe('tests.create'); expect(f.run).not.toHaveBeenCalled()
    await f.click('test-accept')
    expect(f.calls.some(call => call.operation === 'tests.accept')).toBe(false)
    f.get('test-authorize').checked = true; await f.click('test-accept')
    expect(f.calls.find(call => call.operation === 'tests.accept')).toMatchObject({ expectedGeneration: 1, reviewedSha256: 'a'.repeat(64) })
    expect(f.get('test-authorize').checked).toBe(false); expect(f.run).not.toHaveBeenCalled()
    await f.click('test-run')
    expect(f.run).toHaveBeenCalledWith({ id: f.state.testId, generation: 2, sha256: 'a'.repeat(64) })
    expect(JSON.parse(f.get('test-report').textContent)).toMatchObject({ assessment: 'passed', workflowStatus: 'waiting', terminal: false })
    expect(f.calls.some(call => call.operation === 'decide')).toBe(false)
  })

  it('does not accept or execute unsaved editor changes and clears authorization on input', async () => {
    const f = fixture(); await f.click('test-create')
    f.get('test-authorize').checked = true
    const draft = JSON.parse(f.get('test-editor').value); draft.input = 'changed'
    f.get('test-editor').value = JSON.stringify(draft); f.get('test-editor').fire('input')
    expect(f.get('test-authorize').checked).toBe(false)
    f.get('test-authorize').checked = true; await f.click('test-accept')
    expect(f.calls.some(call => call.operation === 'tests.accept')).toBe(false)
    await f.click('test-edit')
    expect(f.calls.find(call => call.operation === 'tests.edit')).toMatchObject({ expectedGeneration: 1, input: 'changed' })
    f.get('test-authorize').checked = true; await f.click('test-accept')
    f.get('test-editor').value = JSON.stringify({ ...draft, input: 'unsaved after acceptance' })
    await f.click('test-run'); expect(f.run).not.toHaveBeenCalled()
  })

  it('retains the generation UUID across a lost response and retries only on another explicit click', async () => {
    const f = fixture(); f.failNextGeneration(); await f.click('test-generate')
    const id = f.state.batchId
    expect(f.state.pendingBatch).toBe(true)
    expect(f.calls.filter(call => call.operation === 'tests.generate')).toHaveLength(1)
    await f.click('test-generate')
    expect(f.calls.filter(call => call.operation === 'tests.generate').map(call => call.id)).toEqual([id, id])
    expect(f.state.pendingBatch).toBe(false); expect(f.run).not.toHaveBeenCalled()
  })
  it('explains successful read-only batch resolution before a separately requested new batch', async () => {
    const f = fixture('api'); f.failNextGeneration(); await f.click('test-generate')
    const original = f.state.batchId; expect(f.state.pendingBatch).toBe(true)
    f.setMode(undefined); await f.click('test-refresh')
    expect(f.calls).toEqual([{ operation: 'tests.generate', id: original, limit: 12, triggerMode: 'api' },
      { operation: 'tests.list' }, { operation: 'tests.generation', id: original }])
    expect(f.state).toMatchObject({ batchId: original, batchTriggerMode: 'api', pendingBatch: false })
    expect(f.messages.at(-1)).toContain('draft batch is saved'); expect(f.messages.at(-1)).toContain('now creates a new batch')
    expect(f.run).not.toHaveBeenCalled()
    await f.click('test-generate')
    const requests = f.calls.filter(call => call.operation === 'tests.generate')
    expect(requests).toHaveLength(2); expect(requests[1].id).not.toBe(original); expect(requests[1]).not.toHaveProperty('triggerMode')
    expect(f.run).not.toHaveBeenCalled(); expect(f.calls.some(call => call.operation === 'tests.accept')).toBe(false)
  })
  it('does not claim saved resolution or clear the pending identity when refresh is uncertain', async () => {
    const f = fixture('api'); f.failNextGeneration(); await f.click('test-generate')
    const retained = structuredClone(f.state), messages = [...f.messages]
    f.request.mockImplementationOnce(async () => ({ tests: [] })).mockImplementationOnce(async () => { throw Error('Lost saved-test lookup') })
    await f.click('test-refresh')
    expect(f.state).toEqual(retained); expect(f.messages).toEqual(messages)
    expect(f.failures.at(-1)).toMatchObject({ message: 'Lost saved-test lookup' })
    expect(f.request.mock.calls.slice(-2).map(([command]) => command)).toEqual([
      { operation: 'tests.list' }, { operation: 'tests.generation', id: retained.batchId }])
    expect(f.calls.filter(call => call.operation === 'tests.generate')).toHaveLength(1); expect(f.run).not.toHaveBeenCalled()
  })
})
