import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { JSDOM } from 'jsdom'
import { LocalRuntime } from '../src/runtime/local.ts'
import { dispatchOperation, type RuntimeOperation } from '../src/http/operations.ts'
import { PreviewSession } from '../src/preview/session.ts'
import { liveTestCoverageControls, testCoverageHtml } from '../src/preview/test-coverage-controls.ts'
import { createPreview } from '../src/preview/model.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const owners: LocalRuntime[] = [], windows: JSDOM[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const dom of windows.splice(0)) dom.window.close(); for (const owner of owners.splice(0)) await owner.close() })
async function fixture(source = echo) {
  const runtime = await LocalRuntime.open({ dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-preview-coverage-')) }); owners.push(runtime)
  const call = vi.fn((command: RuntimeOperation) => dispatchOperation({ storage: 'sqlite', runtime }, command, 'PRIVATE_ACTOR'))
  const session = await PreviewSession.create({ call }, source)
  const runIds: string[] = []
  for (let i = 0; i < 2; i++) {
    const draft: any = await session.operation({ operation: 'tests.create', id: randomUUID(), title: 'PRIVATE_CASE_TITLE',
      input: source === approval ? { message: 'PRIVATE_TEST_INPUT' } : 'PRIVATE_TEST_INPUT',
      expectations: [{ kind: 'status', value: source === approval ? 'waiting' : 'completed' }] })
    const accepted: any = await session.operation({ operation: 'tests.accept', id: draft.id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256 })
    const runId = randomUUID(); runIds.push(runId)
    await session.operation({ operation: 'tests.run', runId, test: { id: accepted.id, generation: accepted.generation, sha256: accepted.sha256 } })
  }
  call.mockClear()
  return { runtime, call, session, runIds, source }
}

describe('project-scoped retained test coverage, not execution authority', () => {
  it('returns only test-run metadata and aggregates real results without changing journals', async () => {
    const f = await fixture(), before = await Promise.all(f.runIds.map(id => f.runtime.events(id)))
    const normal: any = await f.session.operation({ operation: 'run', id: randomUUID(), input: 'PRIVATE_NORMAL_INPUT' })
    const foreign = await f.runtime.run(echo, 'PRIVATE_FOREIGN_INPUT')
    f.call.mockClear()
    const list: any = await f.session.operation({ operation: 'tests.coverage-runs' })
    expect(list).toMatchObject({ project: f.session.pin, totalRuns: 2, execution: 'not-requested' })
    expect(list.runs.map((run: any) => run.id).sort()).toEqual([...f.runIds].sort())
    expect(list.runs.every((run: any) => Object.keys(run).sort().join(',') === 'id,status,test,updatedAt')).toBe(true)
    expect(JSON.stringify(list)).not.toContain('PRIVATE_')
    const report: any = await f.session.operation({ operation: 'tests.coverage', runIds: f.runIds })
    expect(report).toMatchObject({ project: f.session.pin, observationStatus: 'complete', execution: 'not-requested',
      summary: { observedRuns: 2, selectedRuns: 2, nodesWithResults: 2, totalNodes: 2, routesWithSelections: 1, totalRoutes: 1 } })
    expect(JSON.stringify(report)).not.toContain('PRIVATE_')
    expect(await Promise.all(f.runIds.map(id => f.runtime.events(id)))).toEqual(before)
    expect(f.call.mock.calls.every(([cmd]) => ['runs.list', 'runs.show', 'tests.result'].includes(cmd.operation))).toBe(true)
    expect(f.call.mock.calls.filter(([cmd]) => cmd.operation === 'tests.result').every(([cmd]: any) => cmd.inspect === false)).toBe(true)
    expect(report.entries.map((entry: any) => entry.runId)).not.toContain(normal.id)
    expect(report.entries.map((entry: any) => entry.runId)).not.toContain(foreign.id)
  })
  it('reads a waiting approval without treating it or its downstream output as reached', async () => {
    const f = await fixture(approval), report: any = await f.session.operation({ operation: 'tests.coverage', runIds: f.runIds })
    expect(report.summary).toMatchObject({ passedAssessments: 2, terminalRuns: 0, nodesWithResults: 1 })
    expect(report.nodes.find((node: any) => node.nodeId === 'review').settledResults).toBe(0)
    expect(f.call.mock.calls.every(([cmd]) => ['runs.show', 'tests.result'].includes(cmd.operation))).toBe(true)
  })
  it.each(['foreign', 'normal', 'missing'])('preflights all selected %s run identities before reading results', async kind => {
    const f = await fixture()
    const runId = kind === 'foreign' ? (await f.runtime.run(echo, 'PRIVATE_FOREIGN')).id
      : kind === 'normal' ? (await f.session.operation({ operation: 'run', id: randomUUID(), input: 'PRIVATE_NORMAL' }) as any).id : randomUUID()
    f.call.mockClear()
    await expect(f.session.operation({ operation: 'tests.coverage', runIds: [...f.runIds, runId] })).rejects.toMatchObject({ code: 'not-found' })
    expect(f.call.mock.calls.every(([cmd]) => cmd.operation === 'runs.show')).toBe(true)
  })
  it.each(['duplicate', 'empty', 'too-many', 'invalid-id', 'actor', 'inspect', 'project'])('rejects widened or malformed %s requests without owner reads', async kind => {
    const f = await fixture(), command: any = { operation: 'tests.coverage', runIds: [...f.runIds] }
    if (kind === 'duplicate') command.runIds.push(command.runIds[0])
    if (kind === 'empty') command.runIds = []
    if (kind === 'too-many') command.runIds = Array.from({ length: 101 }, () => randomUUID())
    if (kind === 'invalid-id') command.runIds[0] = '<script>'
    if (kind === 'actor') command.actor = 'override'
    if (kind === 'inspect') command.inspect = true
    if (kind === 'project') command.project = f.session.pin
    await expect(f.session.operation(command)).rejects.toMatchObject({ code: 'invalid-command' })
    expect(f.call).not.toHaveBeenCalled()
  })
  it('detaches the caller selection and retains historical test identities after archive', async () => {
    const f = await fixture(), original = [...f.runIds]
    const first = await f.runtime.show(original[0]!), test = f.runtime.testCase(first.test!.id)
    f.runtime.editTest({ operation: 'archive', id: test.id, expectedGeneration: test.generation, reviewedSha256: test.sha256, archived: true, actor: 'fixture' })
    const command = { operation: 'tests.coverage', runIds: [...original] }, pending = f.session.operation(command)
    command.runIds[0] = randomUUID()
    const report: any = await pending
    expect(report.entries.map((entry: any) => entry.runId)).toEqual(original)
    expect(report.entries[0].test).toEqual(first.test)
    expect(f.call.mock.calls.some(([cmd]) => ['tests.show', 'tests.run', 'tests.command'].includes(cmd.operation))).toBe(false)
  })
  it('rechecks scope before each result read; a changed owner cannot expose a foreign payload', async () => {
    const f = await fixture(); let reads = 0
    f.call.mockImplementation(async command => {
      const value: any = await dispatchOperation({ storage: 'sqlite', runtime: f.runtime }, command, 'fixture')
      return command.operation === 'runs.show' && ++reads > f.runIds.length ? { ...value, project: { id: randomUUID(), generation: 1 } } : value
    })
    const report: any = await f.session.operation({ operation: 'tests.coverage', runIds: f.runIds })
    expect(report.observationStatus).toBe('partial'); expect(report.summary.observedRuns).toBe(0)
    expect(f.call.mock.calls.some(([cmd]) => cmd.operation === 'tests.result')).toBe(false)
  })
})

/** Actual serialized controller and DOM only. Not browser, layout, CSP or usability qualification. */
async function controller(source = echo) {
  const f = await fixture(source), listing = await f.session.operation({ operation: 'tests.coverage-runs' }) as any
  const dom = new JSDOM(testCoverageHtml, { runScripts: 'outside-only' }); windows.push(dom)
  let scope: string | undefined = 'fixture-connection'
  const failures: unknown[] = [], request = vi.fn((command: unknown) => f.session.operation(command))
  const ctx = { request, scope: () => scope, project: () => scope ? f.session.pin : undefined,
    preview: () => createPreview(source), error: (error: unknown) => failures.push(error) }
  ;(dom.window as any).ctx = ctx
  const controls = dom.window.eval(`(${liveTestCoverageControls.toString()})(ctx)`) as ReturnType<typeof liveTestCoverageControls>
  const get = <T extends HTMLElement = HTMLElement>(id: string) => dom.window.document.getElementById(id) as T
  const click = async (id: string) => { get<HTMLButtonElement>(id).click(); await vi.waitFor(() => expect(get<HTMLButtonElement>('test-coverage-load').disabled).toBe(false)) }
  const select = () => { const input = get('test-coverage-runs').querySelector<HTMLInputElement>('input')!; input.checked = true; input.dispatchEvent(new dom.window.Event('change')) }
  return { ...f, dom, controls, get, click, select, request, failures, listing, setScope: (value?: string) => { scope = value; controls.observe() } }
}
describe('plain-language coverage controls, explicit retained selection', () => {
  it('does not read or select automatically; loading, selecting and clearing never run work', async () => {
    const f = await controller()
    expect(f.request).not.toHaveBeenCalled(); expect(f.get<HTMLButtonElement>('test-coverage-show').disabled).toBe(true)
    await f.click('test-coverage-load')
    const inputs = [...f.get('test-coverage-runs').querySelectorAll<HTMLInputElement>('input')]
    expect(inputs).toHaveLength(2); expect(inputs.every(input => !input.checked)).toBe(true)
    f.select(); expect(f.request).toHaveBeenCalledTimes(1)
    await f.click('test-coverage-show')
    expect(f.get('test-coverage-summary').textContent).toBe('2 of 2 steps reached · 1 of 1 branches recorded')
    expect(f.get('test-coverage-status').textContent).toContain('do not prove correct results')
    expect(f.get('test-coverage-gaps').textContent).toContain('Check the expected and actual results separately')
    f.get<HTMLButtonElement>('test-coverage-clear').click()
    expect(f.get('test-coverage-summary').textContent).toBe(''); expect(f.get('test-coverage-runs').children).toHaveLength(0)
    expect(f.request.mock.calls.map(([cmd]: any) => cmd.operation)).toEqual(['tests.coverage-runs', 'tests.coverage'])
  })
  it('gives an actionable empty state without starting a test', async () => {
    const f = await controller(); f.request.mockResolvedValueOnce({ ...f.listing, runs: [], totalRuns: 0 })
    await f.click('test-coverage-load')
    expect(f.get('test-coverage-status').textContent).toContain('No past test runs yet')
    expect(f.get<HTMLButtonElement>('test-coverage-show').disabled).toBe(true); expect(f.request).toHaveBeenCalledTimes(1)
  })
  it('lists the actual approval wait and downstream gaps without interpreting a passing wait as completion', async () => {
    const f = await controller(approval); await f.click('test-coverage-load'); f.select(); await f.click('test-coverage-show')
    expect(f.get('test-coverage-summary').textContent).toContain('1 of 3 steps reached')
    expect(f.get('test-coverage-gaps').textContent).toContain('Step not reached: workflow / review')
    expect(f.get('test-coverage-gaps').textContent).toContain('Step not reached: workflow / result')
    expect(f.get('test-coverage-status').textContent).toContain('Waiting approvals are not completed steps')
    expect(f.request.mock.calls.map(([cmd]: any) => cmd.operation)).toEqual(['tests.coverage-runs', 'tests.coverage'])
  })
  it('keeps unknown results and legacy routes visible without displaying host-supplied private payloads', async () => {
    const f = await controller(); await f.click('test-coverage-load'); f.select()
    const value: any = await f.session.operation({ operation: 'tests.coverage', runIds: [f.listing.runs[0].id] })
    value.observationStatus = 'partial'; value.entries[0].observation = 'not-observed'; delete value.entries[0].result
    value.summary.observedRuns = 0
    for (const node of value.nodes) { node.runs = 0; node.settledResults = 0 }
    for (const route of value.routes) { route.runs = 0; route.selections = 0 }
    value.summary.nodesWithResults = 0; value.summary.routesWithSelections = 0; value.summary.resultsWithoutRecordedPort = 1
    value.privateInput = '<img src=x onerror=alert(1)>PRIVATE_VALUE'
    f.request.mockResolvedValueOnce(value); await f.click('test-coverage-show')
    expect(f.get('test-coverage-status').textContent).toContain('Some results are unavailable')
    expect(f.get('test-coverage-status').textContent).toContain('Their route is unknown')
    expect(f.dom.window.document.body.textContent).not.toContain('PRIVATE_VALUE')
    expect(f.dom.window.document.querySelector('img')).toBeNull(); expect(f.failures).toEqual([])
  })
  it.each(['clear', 'disconnect', 'scope', 'pagehide'])('discards a late coverage reply after %s without restoring selection or resubmitting', async kind => {
    const f = await controller(); await f.click('test-coverage-load'); f.select()
    const ids = [f.listing.runs[0].id], value = await f.session.operation({ operation: 'tests.coverage', runIds: ids })
    let resolve!: (value: any) => void
    f.request.mockImplementationOnce(async () => new Promise(done => { resolve = done }))
    f.get<HTMLButtonElement>('test-coverage-show').click(); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    if (kind === 'clear') f.get<HTMLButtonElement>('test-coverage-clear').click()
    if (kind === 'disconnect') { f.setScope(undefined); f.setScope('fixture-connection') }
    if (kind === 'scope') { f.setScope('other'); f.setScope('fixture-connection') }
    if (kind === 'pagehide') f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide'))
    const calls = f.request.mock.calls.length; resolve(value); await new Promise(done => setTimeout(done, 0))
    expect(f.get('test-coverage-summary').textContent).toBe(''); expect(f.get('test-coverage-runs').children).toHaveLength(0)
    expect(f.request).toHaveBeenCalledTimes(calls); expect(f.failures).toEqual([])
  })
  it('drops a late run list on clear and enables explicit reads on pageshow without auto reload', async () => {
    const f = await controller(); let resolve!: (value: any) => void
    f.request.mockImplementationOnce(async () => new Promise(done => { resolve = done }))
    f.get<HTMLButtonElement>('test-coverage-load').click(); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    f.get<HTMLButtonElement>('test-coverage-clear').click(); resolve(f.listing); await new Promise(done => setTimeout(done, 0))
    expect(f.get('test-coverage-runs').children).toHaveLength(0)
    f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide')); f.dom.window.dispatchEvent(new f.dom.window.Event('pageshow'))
    expect(f.get<HTMLButtonElement>('test-coverage-load').disabled).toBe(false); expect(f.request).toHaveBeenCalledTimes(1)
  })
  it.each(['project', 'revision', 'identity', 'execution', 'summary', 'node', 'port'])('rejects an inconsistent %s report without displaying it or retrying', async kind => {
    const f = await controller(); await f.click('test-coverage-load'); f.select()
    const value: any = await f.session.operation({ operation: 'tests.coverage', runIds: [f.listing.runs[0].id] })
    if (kind === 'project') value.project.id = randomUUID()
    if (kind === 'revision') value.revision = '0'.repeat(64)
    if (kind === 'identity') value.entries[0].test.generation++
    if (kind === 'execution') value.execution = 'requested'
    if (kind === 'summary') value.summary.nodesWithResults++
    if (kind === 'node') value.nodes[0].nodeId = '<script>'
    if (kind === 'port') value.routes[0].port = '<img onerror=alert(1)>'
    f.request.mockResolvedValueOnce(value); await f.click('test-coverage-show')
    expect(f.get('test-coverage-summary').textContent).toBe(''); expect(f.get('test-coverage-gaps').children).toHaveLength(0)
    expect(f.failures).toHaveLength(1); expect(f.request).toHaveBeenCalledTimes(2)
  })
})
