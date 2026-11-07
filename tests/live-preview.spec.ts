import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { Script } from 'node:vm'
import { startRuntimeService, RuntimeClient, type RuntimeServiceOptions } from '../src/http/index.ts'
import { LocalRuntime, type ModelCalls } from '../src/runtime/index.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'
import { renderLivePage } from '../src/preview/live-page.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const api = await readFile(new URL('../examples/api-echo.yaml', import.meta.url), 'utf8')
const ownerToken = randomBytes(32).toString('hex'), cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(source = echo, options: Partial<RuntimeServiceOptions> = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-live-preview-'))
  const service = await startRuntimeService({ runtime: { dataDirectory }, token: ownerToken, actor: 'local:preview-owner', preview: { source }, ...options })
  cleanup.push(() => service.close())
  const owner = new RuntimeClient(service.url, ownerToken)
  const post = (path: string, command: unknown, token = ownerToken, headers: Record<string, string> = {}) => fetch(service.url + path, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Jevable-Protocol': PROTOCOL_VERSION, ...headers },
    body: JSON.stringify(command) })
  const boot = await post('/v1/preview/bootstrap', {})
  expect(boot.status).toBe(200)
  const session = (await boot.json() as any).result
  const raw = (command: unknown, token = session.token, headers?: Record<string, string>) => post('/v1/preview/operations', command, token, headers)
  const operation = async (command: unknown) => { const response = await raw(command); expect(response.status).toBe(200); return (await response.json() as any).result }
  return { service, owner, post, raw, operation, session, dataDirectory }
}

describe('experimental project-scoped live preview protocol (not browser qualification)', () => {
  it('reads selected historical test coverage over the authenticated project boundary without execution or private data', async () => {
    const f = await fixture(approval), id = randomUUID()
    const draft = await f.operation({ operation: 'tests.create', id, title: 'PRIVATE_CASE_TITLE', input: { message: 'PRIVATE_COVERAGE_INPUT' },
      expectations: [{ kind: 'status', value: 'waiting' }] })
    const accepted = await f.operation({ operation: 'tests.accept', id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256 })
    const runId = randomUUID()
    await f.operation({ operation: 'tests.run', runId, test: { id, generation: accepted.generation, sha256: accepted.sha256 } })
    const before = await f.owner.operation({ operation: 'runs.events', id: runId })
    const listed = await f.operation({ operation: 'tests.coverage-runs' })
    expect(listed).toMatchObject({ project: f.session.project, totalRuns: 1, execution: 'not-requested' })
    expect(listed.runs[0]).toMatchObject({ id: runId, status: 'waiting' })
    const report = await f.operation({ operation: 'tests.coverage', runIds: [runId] })
    expect(report).toMatchObject({ project: f.session.project, observationStatus: 'complete', execution: 'not-requested',
      summary: { observedRuns: 1, nodesWithResults: 1, totalNodes: 3, terminalRuns: 0 } })
    expect(JSON.stringify([listed, report])).not.toContain('PRIVATE_')
    const foreign: any = (await f.owner.operation({ operation: 'runs.start', id: randomUUID(), yaml: echo, input: 'PRIVATE_FOREIGN' }) as any).result
    expect((await f.raw({ operation: 'tests.coverage', runIds: [runId, foreign.id] })).status).toBe(404)
    expect((await f.raw({ operation: 'tests.coverage', runIds: [runId], actor: 'override' })).status).toBe(400)
    expect((await f.raw({ operation: 'tests.coverage-runs', inspect: true })).status).toBe(400)
    expect((await f.raw({ operation: 'tests.coverage-runs' }, ownerToken)).status).toBe(401)
    expect(await f.owner.operation({ operation: 'runs.events', id: runId })).toEqual(before)
  })
  it('lists retained version metadata and explicitly reads old definitions without changing the accepted case or admitted run', async () => {
    const f = await fixture(approval), id = randomUUID(), fields = { title: 'History review', input: { message: 'PRIVATE_HISTORY_INPUT' },
      expectations: [{ kind: 'status', value: 'waiting' }] }
    const draft = await f.operation({ operation: 'tests.create', id, ...fields })
    const accepted = await f.operation({ operation: 'tests.accept', id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256 })
    const runId = randomUUID()
    await f.operation({ operation: 'tests.run', test: { id, generation: accepted.generation, sha256: accepted.sha256 }, runId })
    const before = await f.operation({ operation: 'show', id: runId }), result = await f.operation({ operation: 'tests.result', runId, inspect: true })
    const archived = await f.operation({ operation: 'tests.archive', id, expectedGeneration: accepted.generation, reviewedSha256: accepted.sha256, archived: true })
    const restored = await f.operation({ operation: 'tests.archive', id, expectedGeneration: archived.generation, reviewedSha256: archived.sha256, archived: false })
    const history = await f.operation({ operation: 'tests.history', id })
    expect(history).toMatchObject({ project: f.session.project, test: { id, generation: restored.generation, sha256: restored.sha256 }, execution: 'not-run' })
    expect(history.versions.map((version: any) => [version.generation, version.operation, version.status, version.archived])).toEqual([
      [1, 'create', 'draft', false], [2, 'accept', 'accepted', false], [3, 'archive', 'accepted', true], [4, 'archive', 'accepted', false]])
    expect(JSON.stringify(history)).not.toContain('PRIVATE_HISTORY_INPUT'); expect(JSON.stringify(history)).not.toContain('local:preview-owner')
    expect(await f.operation({ operation: 'tests.show', id, generation: 1 })).toEqual(draft)
    expect(await f.operation({ operation: 'tests.show', id })).toEqual(restored)
    expect(await f.operation({ operation: 'show', id: runId })).toEqual(before)
    expect(await f.operation({ operation: 'tests.result', runId, inspect: true })).toEqual(result)
    for (const extra of [{ actor: 'override' }, { project: f.session.project }, { generation: 1 }, { includePrivate: true }])
      expect((await f.raw({ operation: 'tests.history', id, ...extra })).status).toBe(400)
    await f.service.close(); const owner = await LocalRuntime.open({ dataDirectory: f.dataDirectory })
    try { expect(owner.testHistory(id).versions).toHaveLength(4); expect(owner.testCase(id)).toEqual(restored) }
    finally { await owner.close() }
  })
  it.each(['draft', 'accepted'])('archives and restores an exact scoped %s case with guarded versions and unchanged definitions', async status => {
    const f = await fixture(), id = randomUUID(), fields = { title: 'Lifecycle', input: 'PRIVATE_ARCHIVE_INPUT',
      expectations: [{ kind: 'status', value: 'completed' }] }
    let current = await f.operation({ operation: 'tests.create', id, ...fields })
    if (status === 'accepted') current = await f.operation({ operation: 'tests.accept', id, expectedGeneration: current.generation, reviewedSha256: current.sha256 })
    const command = { operation: 'tests.archive', id, expectedGeneration: current.generation, reviewedSha256: current.sha256, archived: true }
    expect((await f.raw({ ...command, reviewedSha256: '0'.repeat(64) })).status).toBe(409)
    const archived = await f.operation(command)
    expect(archived).toMatchObject({ status, archived: true, generation: current.generation + 1,
      sha256: current.sha256, definition: current.definition, actor: 'local:preview-owner' })
    expect((await f.operation({ operation: 'tests.list' })).tests.find((row: any) => row.id === id)).toHaveProperty('archived', true)
    expect((await f.raw(command)).status).toBe(409)
    expect((await f.raw({ operation: 'tests.run', test: { id, generation: archived.generation, sha256: archived.sha256 }, runId: randomUUID() })).status).toBe(409)
    const restored = await f.operation({ ...command, expectedGeneration: archived.generation, archived: false })
    expect(restored).toMatchObject({ status, archived: false, generation: archived.generation + 1, definition: current.definition })
    expect(await f.operation({ operation: 'tests.show', id, generation: current.generation })).toEqual(current)
    expect(await f.operation({ operation: 'runs' })).toEqual({ runs: [] })
    await f.service.close(); const owner = await LocalRuntime.open({ dataDirectory: f.dataDirectory })
    try { expect(owner.testCase(id)).toEqual(restored) } finally { await owner.close() }
  })
  it('preserves an admitted waiting test/result through archive/restore without approval or new execution', async () => {
    const f = await fixture(approval), id = randomUUID()
    const draft = await f.operation({ operation: 'tests.create', id, title: 'Waiting archive', input: { message: 'PRIVATE_WAIT' },
      expectations: [{ kind: 'status', value: 'waiting' }] })
    const accepted = await f.operation({ operation: 'tests.accept', id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256 })
    const runId = randomUUID(), run = { operation: 'tests.run', test: { id, generation: accepted.generation, sha256: accepted.sha256 }, runId }
    const result = await f.operation(run), before = await f.operation({ operation: 'show', id: runId })
    const archive = { operation: 'tests.archive', id, expectedGeneration: accepted.generation, reviewedSha256: accepted.sha256, archived: true }
    const archived = await f.operation(archive)
    expect(await f.operation(run)).toEqual(result); expect(await f.operation({ operation: 'show', id: runId })).toEqual(before)
    expect((await f.operation({ operation: 'tests.result', runId, inspect: true })).workflowStatus).toBe('waiting')
    expect((await f.raw({ ...run, runId: randomUUID() })).status).toBe(409)
    await f.operation({ ...archive, expectedGeneration: archived.generation, archived: false })
    expect(await f.operation({ operation: 'show', id: runId })).toEqual(before)
    expect((await f.operation({ operation: 'runs' })).runs).toHaveLength(1)
  })
  it.each([{ actor: 'spoofed' }, { project: { id: randomUUID() } }, { input: 'override' }, { archived: 'true' }, { archived: undefined }])
    ('refuses widened or malformed preview lifecycle command %j before mutation', async extra => {
      const f = await fixture(), id = randomUUID()
      const draft = await f.operation({ operation: 'tests.create', id, title: 'Pinned', input: 'private', expectations: [{ kind: 'status', value: 'completed' }] })
      expect((await f.raw({ operation: 'tests.archive', id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256, archived: true, ...extra })).status).toBe(400)
      expect(await f.operation({ operation: 'tests.show', id })).toEqual(draft)
    })
  it('reads exactly one selected private node record and refuses stale/foreign or widened selectors', async () => {
    const f = await fixture(), run = await f.operation({ operation: 'run', id: randomUUID(), input: 'PRIVATE_NODE_VALUE' })
    const command = { operation: 'node.inspect', id: run.id, expectedCheckpointSha256: run.checkpointSha256,
      selection: { nodeId: 'result', graphScope: 'workflow', record: { kind: 'step', index: 1 } } }
    const before = await f.owner.operation({ operation: 'runs.events', id: run.id })
    const result = await f.operation(command)
    expect(result).toMatchObject({ privateInspection: true, kind: 'node-result', output: { status: 'recorded', value: 'PRIVATE_NODE_VALUE' } })
    expect(result).not.toHaveProperty('yaml'); expect(result).not.toHaveProperty('steps'); expect(result).not.toHaveProperty('run')
    expect((await f.raw({ ...command, expectedCheckpointSha256: 'b'.repeat(64) })).status).toBe(409)
    expect((await f.raw({ ...command, actor: 'spoofed' })).status).toBe(400)
    expect((await f.raw({ ...command, selection: { ...command.selection, record: { kind: 'step', index: 0 } } })).status).toBe(404)
    const foreign = (await f.owner.operation({ operation: 'runs.start', id: randomUUID(), yaml: echo, input: 'FOREIGN_NODE_VALUE' }) as any).result
    const refused = await f.raw({ ...command, id: foreign.id, expectedCheckpointSha256: foreign.checkpointSha256 })
    expect(refused.status).toBe(404); expect(await refused.text()).not.toContain('FOREIGN_NODE_VALUE')
    expect(await f.owner.operation({ operation: 'runs.events', id: run.id })).toEqual(before)
    expect(await f.operation({ operation: 'show', id: run.id })).toEqual(run)
  })
  it('reports declared API entry without implicit selection and admits only its explicit scoped run', async () => {
    const f = await fixture(api), id = randomUUID()
    const localView = await f.operation({ operation: 'view' })
    expect(localView).toMatchObject({ entry: { local: false, api: true }, readiness: { runtimeReadiness: 'unavailable' }, execution: 'not-run' })
    expect(localView.readiness).not.toHaveProperty('triggerMode')
    expect(await f.operation({ operation: 'view', triggerMode: 'api' })).toMatchObject({ entry: { local: false, api: true },
      readiness: { runtimeReadiness: 'ready', triggerMode: 'api' }, visualReview: 'not-performed' })
    expect((await f.raw({ operation: 'run', id, input: 'PRIVATE_API' })).status).toBe(400)
    expect(await f.operation({ operation: 'runs' })).toEqual({ runs: [] })
    const command = { operation: 'run', id, input: 'PRIVATE_API', triggerMode: 'api' }
    const run = await f.operation(command)
    expect(run).toMatchObject({ status: 'completed', triggerMode: 'api', output: 'PRIVATE_API' })
    expect(await f.operation(command)).toEqual(run)
    expect((await f.operation({ operation: 'runs' })).runs[0]).toMatchObject({ id, triggerMode: 'api' })
    const evidence = await f.operation({ operation: 'evidence', id })
    expect(evidence.snapshot.run.triggerMode).toBe('api'); expect(JSON.stringify(evidence)).not.toContain('PRIVATE_API')
    await f.service.close(); const owner = await LocalRuntime.open({ dataDirectory: f.dataDirectory })
    try { expect((await owner.show(id)).triggerMode).toBe('api') } finally { await owner.close() }
  })
  it.each([null, false, 1, 'manual', 'chat', 'webhook', {}, ['api']])('refuses unsupported preview entry %j before mutation', async triggerMode => {
    const f = await fixture(api)
    for (const command of [{ operation: 'view' }, { operation: 'run', id: randomUUID(), input: 'x' },
      { operation: 'tests.generate', id: randomUUID() }, { operation: 'tests.create', id: randomUUID(), title: 'x', input: 'x',
        expectations: [{ kind: 'status', value: 'completed' }] }]) {
      expect((await f.raw({ ...command, triggerMode })).status).toBe(400)
    }
    expect(await f.operation({ operation: 'runs' })).toEqual({ runs: [] })
    expect(await f.operation({ operation: 'tests.list' })).toEqual({ tests: [] })
  })
  it('retains exact API candidate batch and accepted-case mode; tests.run cannot override the reviewed contract', async () => {
    const f = await fixture(api), batchCommand = { operation: 'tests.generate', id: randomUUID(), limit: 1, triggerMode: 'api' }
    const defaultDrafts = await f.operation({ operation: 'tests.generate', id: randomUUID(), limit: 1 })
    expect(defaultDrafts.snapshot.request).not.toHaveProperty('triggerMode')
    expect(defaultDrafts.snapshot.execution).toBe('not-run')
    const batch = await f.operation(batchCommand)
    expect(batch.snapshot.request.triggerMode).toBe('api'); expect(await f.operation(batchCommand)).toEqual(batch)
    expect((await f.raw({ ...batchCommand, triggerMode: undefined })).status).not.toBe(200)
    const draft = await f.operation({ operation: 'tests.show', id: batch.snapshot.cases[0].id })
    expect(draft.definition.triggerMode).toBe('api')
    const accepted = await f.operation({ operation: 'tests.accept', id: draft.id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256 })
    const command = { operation: 'tests.run', runId: randomUUID(), test: { id: accepted.id, generation: accepted.generation, sha256: accepted.sha256 } }
    expect((await f.raw({ ...command, triggerMode: 'api' })).status).toBe(400)
    expect((await f.raw({ operation: 'tests.accept', id: draft.id, expectedGeneration: accepted.generation,
      reviewedSha256: accepted.sha256, triggerMode: 'api' })).status).toBe(400)
    expect(await f.operation({ operation: 'runs' })).toEqual({ runs: [] })
    const result = await f.operation(command)
    expect(result).toMatchObject({ assessment: 'passed', workflowStatus: 'completed', run: { triggerMode: 'api' } })
    expect(await f.operation(command)).toEqual(result)
    expect((await f.operation({ operation: 'tests.result', runId: command.runId, inspect: true })).run.triggerMode).toBe('api')
  })
  it('makes changing a saved entry a new reviewed definition and refuses retargeting a retained mixed-entry run', async () => {
    const f = await fixture(echo.replace('[manual]', '[manual, api]'))
    const fields = { title: 'Mixed entry', input: 'x', expectations: [{ kind: 'status', value: 'completed' }] }
    const draft = await f.operation({ operation: 'tests.create', id: randomUUID(), ...fields, triggerMode: 'api' })
    const accepted = await f.operation({ operation: 'tests.accept', id: draft.id, expectedGeneration: draft.generation, reviewedSha256: draft.sha256 })
    const changed = await f.operation({ operation: 'tests.edit', id: draft.id, expectedGeneration: accepted.generation, ...fields })
    expect(changed.definition).not.toHaveProperty('triggerMode'); expect(changed.sha256).not.toBe(accepted.sha256); expect(changed.status).toBe('draft')
    expect((await f.operation({ operation: 'tests.show', id: draft.id, generation: accepted.generation })).definition.triggerMode).toBe('api')
    const command = { operation: 'run', id: randomUUID(), input: 'mixed' }, local = await f.operation(command)
    expect(local).not.toHaveProperty('triggerMode')
    expect((await f.raw({ ...command, triggerMode: 'api' })).status).toBe(409)
    const explicit = await f.operation({ ...command, id: randomUUID(), triggerMode: 'api' })
    expect((await f.raw({ ...command, id: explicit.id })).status).toBe(409)
  })
  it('keeps API mode immutable across scoped approval and checkpoint controls', async () => {
    const f = await fixture(approval.replace('[manual]', '[api]')), id = randomUUID()
    const start = await f.operation({ operation: 'run', id, input: { message: 'Review API' }, triggerMode: 'api', paused: true })
    const control = { operation: 'advance', id, requestId: randomUUID(), mode: 'continue', expectedCheckpointSha256: start.checkpointSha256 }
    expect((await f.raw({ ...control, triggerMode: 'api' })).status).toBe(400)
    const waiting = await f.operation(control)
    expect(waiting).toMatchObject({ status: 'waiting', triggerMode: 'api' })
    const decision = { operation: 'decide', id, attemptId: waiting.attemptId, action: 'approve', pauseAfter: true }
    expect((await f.raw({ ...decision, triggerMode: 'api' })).status).toBe(400)
    const paused = await f.operation(decision)
    expect(paused).toMatchObject({ status: 'paused', triggerMode: 'api' })
    expect(await f.operation({ ...control, requestId: randomUUID(), expectedCheckpointSha256: paused.checkpointSha256 })).toMatchObject({ status: 'completed', triggerMode: 'api' })
  })
  it('admits an exact scoped pause and requires explicit continuation without changing breakpoint configuration', async () => {
    const f = await fixture(), id = randomUUID(), start = await f.operation({ operation: 'run', id, input: 'debug', paused: true })
    const request = { operation: 'advance', id, requestId: randomUUID(), mode: 'pause', expectedCheckpointSha256: start.checkpointSha256 }
    expect((await f.raw({ ...request, breakpoints: [] })).status).toBe(400)
    const paused = await f.operation(request)
    expect(paused).toMatchObject({ status: 'paused', steps: [], pause: { status: 'at-safe-checkpoint' } })
    expect(await f.operation(request)).toEqual(paused)
    expect((await f.operation({ ...request, requestId: randomUUID(), mode: 'continue', expectedCheckpointSha256: paused.checkpointSha256 })).status).toBe('completed')
  })
  it('retains node breakpoints through the scoped preview protocol without automatic replay', async () => {
    const f = await fixture(), id = randomUUID()
    const start = await f.operation({ operation: 'run', id, input: 'debug', paused: true })
    const command = { operation: 'advance', id, requestId: randomUUID(), mode: 'continue',
      expectedCheckpointSha256: start.checkpointSha256, breakpoints: ['start'] }
    const hit = await f.operation(command)
    expect(hit).toMatchObject({ steps: [], breakpoint: { nodeId: 'start' } })
    expect(await f.operation(command)).toEqual(hit)
    const done = await f.operation({ ...command, requestId: randomUUID(), expectedCheckpointSha256: hit.checkpointSha256, breakpoints: [] })
    expect(done.status).toBe('completed')
  })
  it('offers pinned paused admission and guarded controls without allowing foreign-run advancement', async () => {
    const f = await fixture(), id = randomUUID()
    const run = await f.operation({ operation: 'run', id, input: 'preview debug', paused: true })
    expect(run.status).toBe('paused'); expect(run.steps).toEqual([])
    const command = { operation: 'advance', id, requestId: randomUUID(), mode: 'step', expectedCheckpointSha256: run.checkpointSha256 }
    expect((await f.raw({ ...command, actor: 'spoofed' })).status).toBe(400)
    const step = await f.operation(command)
    expect(step.status).toBe('paused'); expect(await f.operation(command)).toEqual(step)
    const foreign = (await f.owner.operation({ operation: 'runs.start', id: randomUUID(), yaml: echo, input: 'foreign', paused: true }) as any).result
    expect((await f.raw({ ...command, id: foreign.id, requestId: randomUUID(), expectedCheckpointSha256: foreign.checkpointSha256 })).status).toBe(404)
    expect((await f.operation({ ...command, mode: 'continue', requestId: randomUUID(), expectedCheckpointSha256: step.checkpointSha256 })).output).toBe('preview debug')
  })

  it('generates draft-only cases and requires exact acceptance before explicit saved-case execution', async () => {
    const f = await fixture(), batchId = randomUUID()
    const batch = await f.operation({ operation: 'tests.generate', id: batchId, limit: 2 })
    expect(batch.snapshot).toMatchObject({ execution: 'not-run', actor: 'local:preview-owner', status: 'review-required' })
    expect(await f.operation({ operation: 'tests.generation', id: batchId })).toEqual(batch)
    expect(await f.operation({ operation: 'tests.generate', id: batchId, limit: 2 })).toEqual(batch)
    const item = await f.operation({ operation: 'tests.show', id: batch.snapshot.cases[0].id })
    expect(item.status).toBe('draft')
    expect((await f.operation({ operation: 'tests.list' })).tests).toHaveLength(batch.snapshot.cases.length)
    const test = { id: item.id, generation: item.generation, sha256: item.sha256 }, runId = randomUUID()
    expect((await f.raw({ operation: 'tests.run', test, runId })).status).toBe(409)
    expect(await f.operation({ operation: 'runs' })).toEqual({ runs: [] })
    expect((await f.raw({ operation: 'tests.accept', id: item.id, expectedGeneration: item.generation, reviewedSha256: '0'.repeat(64) })).status).toBe(409)
    const accepted = await f.operation({ operation: 'tests.accept', id: item.id, expectedGeneration: item.generation, reviewedSha256: item.sha256 })
    expect(await f.operation({ operation: 'runs' })).toEqual({ runs: [] })
    const command = { operation: 'tests.run', test: { ...test, generation: accepted.generation }, runId }
    const result = await f.operation(command)
    expect(result).toMatchObject({ assessment: 'passed', workflowStatus: 'completed', terminal: true })
    expect(await f.operation(command)).toEqual(result)
    expect((await f.operation({ operation: 'tests.result', runId, inspect: true })).checks[0]).toMatchObject({ expected: 'completed', actual: 'completed' })
  })

  it('keeps saved-case review immutable across edits and reports a completed workflow separately from a failed assertion', async () => {
    const f = await fixture(), id = randomUUID(), fields = { title: 'Private case', input: 'actual',
      expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'different' }] }
    const draft = await f.operation({ operation: 'tests.create', id, ...fields })
    expect(draft.definition.project).toEqual(f.session.project)
    const accepted = await f.operation({ operation: 'tests.accept', id, expectedGeneration: 1, reviewedSha256: draft.sha256 })
    const command = { operation: 'tests.run', test: { id, generation: accepted.generation, sha256: accepted.sha256 }, runId: randomUUID() }
    const result = await f.operation(command)
    expect(result).toMatchObject({ assessment: 'failed', workflowStatus: 'completed', terminal: true })
    expect(result.checks[1]).not.toHaveProperty('actual')
    const changed = await f.operation({ operation: 'tests.edit', id, expectedGeneration: accepted.generation,
      ...fields, expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'actual' }] })
    expect(changed.status).toBe('draft')
    expect(await f.operation(command)).toEqual(result)
    expect((await f.operation({ operation: 'tests.result', runId: command.runId, inspect: true })).checks[1]).toMatchObject({ expected: 'different', actual: 'actual' })
    expect((await f.raw({ ...command, runId: randomUUID() })).status).toBe(409)
    expect((await f.raw({ operation: 'tests.edit', id, expectedGeneration: accepted.generation, ...fields })).status).toBe(409)
  })

  it('refuses foreign cases, batches and results and rejects caller-controlled project or actor fields', async () => {
    const f = await fixture(), own = async (command: any) => (await f.owner.operation(command) as any).result
    const project = await own({ operation: 'projects.command', command: { operation: 'create', yaml: echo, title: 'Other project' } })
    const batchId = randomUUID(), batch = await own({ operation: 'tests.generate', id: batchId,
      project: { id: project.id, generation: project.generation, revision: project.acceptedRevision }, limit: 1 })
    const foreign = batch.snapshot.cases[0], accepted = await own({ operation: 'tests.command',
      command: { operation: 'accept', id: foreign.id, expectedGeneration: 1, reviewedSha256: foreign.sha256 } })
    const test = { id: accepted.id, generation: accepted.generation, sha256: accepted.sha256 }, runId = randomUUID()
    await own({ operation: 'tests.run', test, runId })
    for (const command of [
      { operation: 'tests.show', id: foreign.id }, { operation: 'tests.show', id: foreign.id, generation: 1 },
      { operation: 'tests.history', id: foreign.id },
      { operation: 'tests.accept', id: foreign.id, expectedGeneration: accepted.generation, reviewedSha256: accepted.sha256 },
      { operation: 'tests.archive', id: foreign.id, expectedGeneration: accepted.generation, reviewedSha256: accepted.sha256, archived: true },
      { operation: 'tests.edit', id: foreign.id, expectedGeneration: accepted.generation, title: 'overwrite', input: 'x', expectations: [{ kind: 'status', value: 'completed' }] },
      { operation: 'tests.run', test, runId }, { operation: 'tests.result', runId, inspect: true },
      { operation: 'tests.generation', id: batchId },
    ]) expect((await f.raw(command)).status).toBe(404)
    expect(await f.operation({ operation: 'tests.list' })).toEqual({ tests: [] })
    for (const extra of [{ actor: 'spoofed' }, { project: f.session.project }]) {
      expect((await f.raw({ operation: 'tests.generate', id: randomUUID(), ...extra })).status).toBe(400)
      expect((await f.raw({ operation: 'tests.create', id: randomUUID(), title: 'x', input: 'x',
        expectations: [{ kind: 'status', value: 'completed' }], ...extra })).status).toBe(400)
    }
  })

  it('matches an approval checkpoint without automatically deciding it and retains the case after shutdown', async () => {
    const f = await fixture(approval), id = randomUUID()
    const draft = await f.operation({ operation: 'tests.create', id, title: 'Wait', input: { message: 'Review saved case' },
      expectations: [{ kind: 'status', value: 'waiting' }] })
    const accepted = await f.operation({ operation: 'tests.accept', id, expectedGeneration: 1, reviewedSha256: draft.sha256 })
    const runId = randomUUID(), result = await f.operation({ operation: 'tests.run', runId,
      test: { id, generation: accepted.generation, sha256: accepted.sha256 } })
    expect(result).toMatchObject({ assessment: 'passed', workflowStatus: 'waiting', terminal: false })
    expect((await f.operation({ operation: 'show', id: runId })).status).toBe('waiting')
    await f.service.close()
    const owner = await LocalRuntime.open({ dataDirectory: f.dataDirectory })
    try { expect(owner.testCase(id)).toEqual(accepted); expect(await owner.testResult(runId)).toEqual(result) }
    finally { await owner.close() }
  })

  it.each(['cancel', 'pause'] as const)('keeps scoped %s available when an active model run fills ordinary capacity', async control => {
    let calls = 0, aborted = false
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const models: ModelCalls = { admit() {}, async verify() {}, async execute(_node, _input, _attempt, signal) {
      calls++; entered()
      await Promise.race([released, new Promise<void>((_resolve, reject) => {
        signal!.addEventListener('abort', () => { aborted = true; reject(Error('cancelled')) }, { once: true })
      })])
      return { output: 'done', usage: { tries: 1 } }
    } }
    const source = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'model', name: 'Model' },
      spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
        write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
          prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false },
          execution: { timeoutSeconds: 60, maxAttempts: 1 }, historyScope: 'none' } },
        end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } },
      edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
    const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-preview-capacity-'))
    const f = await fixture(source, { runtime: { dataDirectory, models }, maxConcurrentRequests: 1 })
    cleanup.push(async () => release())
    const id = randomUUID(), requestId = randomUUID(), pending = f.operation({ operation: 'run', id, input: 'private' })
    await started
    expect((await f.raw({ operation: 'runs' })).status).toBe(429)
    if (control === 'pause') {
      const before = await f.operation({ operation: 'show', id })
      const command = { operation: 'advance', id, requestId, mode: 'pause', expectedCheckpointSha256: before.checkpointSha256 }
      const requested = await f.operation(command)
      expect(requested).toMatchObject({ status: 'executing', pause: { requestId, status: 'requested; current attempt may be active or uncertain' } })
      expect(await f.operation(command)).toEqual(requested)
      expect((await f.raw({ ...command, requestId: randomUUID(), expectedCheckpointSha256: '0'.repeat(64) })).status).toBe(409)
      release(); const paused = await pending
      expect(paused).toMatchObject({ status: 'paused', nodeId: 'end', pause: { status: 'at-safe-checkpoint' } })
      expect(aborted).toBe(false); expect(calls).toBe(1)
      expect(await f.operation(command)).toEqual(paused)
      expect((await f.operation({ ...command, mode: 'continue', requestId: randomUUID(), expectedCheckpointSha256: paused.checkpointSha256 })).output).toBe('done')
      expect(calls).toBe(1); return
    }
    expect((await f.raw({ operation: 'cancel', id, requestId, actor: 'spoofed' })).status).toBe(400)
    const request = await f.operation({ operation: 'cancel', id, requestId })
    expect(request.cancellation).toMatchObject({ id: requestId, actor: 'local:preview-owner' })
    expect((await pending).status).toBe('cancelled')
    expect((await f.operation({ operation: 'show', id })).status).toBe('cancelled')
  })

  it('creates a distinct project after restart and refuses the old session credential and run', async () => {
    const f = await fixture(), run = await f.operation({ operation: 'run', id: randomUUID(), input: 'old session' })
    await f.service.close()
    const next = await fixture(echo, { runtime: { dataDirectory: f.dataDirectory } })
    expect(next.session.project.id).not.toBe(f.session.project.id)
    expect((await next.raw({ operation: 'view' }, f.session.token)).status).toBe(401)
    expect((await next.raw({ operation: 'show', id: run.id })).status).toBe(404)
    expect(await next.operation({ operation: 'runs' })).toEqual({ runs: [] })
    expect((await next.owner.operation({ operation: 'runs.show', id: run.id }) as any).result.status).toBe('completed')
  })

  it('serves an inert credential-free shell and keeps source behind scoped authentication', async () => {
    const source = echo.replace('Standalone echo', 'PRIVATE_WORKFLOW_NAME'), f = await fixture(source)
    const response = await fetch(f.service.url), html = await response.text()
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
    expect(html).not.toContain(ownerToken); expect(html).not.toContain(f.session.token); expect(html).not.toContain('PRIVATE_WORKFLOW_NAME')
    expect(html).not.toContain(source)
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'")
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(response.headers.get('set-cookie')).toBeNull()
    expect((await f.raw({ operation: 'view' }, 'bad')).status).toBe(401)
    const view = await f.operation({ operation: 'view' })
    expect(view.project).toEqual(f.service.preview!.project)
    expect(view.preview.source).toBe(source); expect(view.execution).toBe('not-run')
    expect(await f.operation({ operation: 'runs' })).toEqual({ runs: [] })
    await fetch(f.service.url); await f.operation({ operation: 'view' })
    expect(await f.operation({ operation: 'runs' })).toEqual({ runs: [] })
  })

  it('does not let a scoped browser credential access owner APIs or mutate project/provider settings', async () => {
    const f = await fixture()
    expect((await f.post('/v1/operations', { operation: 'projects.list' }, f.session.token)).status).toBe(401)
    expect((await f.post('/v1/preview/bootstrap', {}, f.session.token)).status).toBe(401)
    for (const operation of ['projects.command', 'providers.set', 'credentials.set', 'runRelease'])
      expect((await f.raw({ operation })).status).toBe(400)
    expect((await f.raw({ operation: 'run', id: randomUUID(), input: 'input', actor: 'spoofed' })).status).toBe(400)
    expect((await f.raw({ operation: 'view' }, ownerToken)).status).toBe(401)
  })

  it('rejects cross-origin requests, token URLs, duplicate fields and protocol mismatch', async () => {
    const f = await fixture()
    expect((await f.raw({ operation: 'view' }, f.session.token, { Origin: 'null' })).status).toBe(403)
    expect((await f.raw({ operation: 'view' }, f.session.token, { Origin: 'http://attacker.invalid' })).status).toBe(403)
    expect((await f.raw({ operation: 'view' }, f.session.token, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    expect((await f.raw({ operation: 'view' }, f.session.token, { 'X-Jevable-Protocol': 'other' })).status).toBe(409)
    expect((await f.post('/v1/preview/bootstrap?token=bad', {})).status).toBe(400)
    expect((await f.post('/v1/preview/bootstrap', { scope: 'all' })).status).toBe(400)
  })

  it('pins explicit runs and retrieves them without replaying on reads or identical retry', async () => {
    const f = await fixture(), id = randomUUID(), command = { operation: 'run', id, input: 'PRIVATE_RUN_INPUT' }
    const result = await f.operation(command)
    expect(result).toMatchObject({ status: 'completed', id, project: { id: f.session.project.id, generation: 1 }, output: 'PRIVATE_RUN_INPUT' })
    expect(await f.operation(command)).toEqual(result)
    expect(await f.operation({ operation: 'show', id })).toEqual(result)
    expect((await f.operation({ operation: 'runs' })).runs).toHaveLength(1)
    expect((await f.operation({ operation: 'inspect', id })).run.input).toBe('PRIVATE_RUN_INPUT')
    const evidence = await f.operation({ operation: 'evidence', id })
    expect(evidence.snapshot.run.id).toBe(id); expect(JSON.stringify(evidence)).not.toContain('PRIVATE_RUN_INPUT')
    expect((await f.operation({ operation: 'evidence', id, includePrivate: true })).snapshot.private.run.input).toBe('PRIVATE_RUN_INPUT')
  })

  it('refuses runs outside its exact preview project even with an owner-known run ID', async () => {
    const f = await fixture(), id = randomUUID()
    await f.owner.operation({ operation: 'runs.start', id, yaml: echo, input: 'other private input' })
    for (const operation of ['show', 'inspect', 'approval', 'evidence']) expect((await f.raw({ operation, id })).status).toBe(404)
    expect((await f.raw({ operation: 'evidence', id, includePrivate: true })).status).toBe(404)
    expect((await f.raw({ operation: 'cancel', id, requestId: randomUUID() })).status).toBe(404)
    expect((await f.raw({ operation: 'decide', id, attemptId: randomUUID(), action: 'approve' })).status).toBe(404)
    expect((await f.raw({ operation: 'run', id, input: 'other private input' })).status).toBe(409)
    expect(await f.operation({ operation: 'runs' })).toEqual({ runs: [] })
  })

  it('does not retarget a preview after its project changes through the owner API', async () => {
    const f = await fixture(), view = await f.operation({ operation: 'view' })
    await f.owner.operation({ operation: 'projects.command', command: { operation: 'rename', id: f.session.project.id,
      expectedGeneration: 1, title: 'Changed outside preview' } })
    expect((await f.raw({ operation: 'run', id: randomUUID(), input: 'input' })).status).toBe(409)
    expect((await f.operation({ operation: 'view' })).project).toEqual(view.project)
  })

  it('requires explicit approval decisions with the exact attempt and authenticated owner actor', async () => {
    const f = await fixture(approval), run = await f.operation({ operation: 'run', id: randomUUID(), input: { message: 'Review this' } })
    expect(run.status).toBe('waiting')
    const review = await f.operation({ operation: 'approval', id: run.id })
    expect(review.review.input.input).toBe('Review this'); expect(review.actions).toContain('approve')
    expect((await f.raw({ operation: 'decide', id: run.id, attemptId: randomUUID(), action: 'approve' })).status).toBe(409)
    expect((await f.raw({ operation: 'decide', id: run.id, attemptId: run.attemptId, action: 'approve', actor: 'spoofed' })).status).toBe(400)
    expect((await f.operation({ operation: 'show', id: run.id })).status).toBe('waiting')
    expect((await f.operation({ operation: 'decide', id: run.id, attemptId: run.attemptId, action: 'approve' })).status).toBe('completed')
    const inspected = await f.operation({ operation: 'inspect', id: run.id })
    expect(inspected.run.state.steps.find((step: any) => step.nodeId === 'review').inspection.approval.actor).toBe('local:preview-owner')
  })

  it('reports server-observed expiry and closes only an expired attempt without approving it', async () => {
    const f = await fixture(approval.replace('expiresAfter: 24h', 'expiresAfter: 30s')),
      run = await f.operation({ operation: 'run', id: randomUUID(), input: { message: 'Synthetic deadline' } })
    expect(run.status).toBe('waiting')
    const open = await f.operation({ operation: 'approval', id: run.id })
    expect(open.deadlineStatus).toBe('open-at-observation')
    const before = await f.owner.operation({ operation: 'runs.events', id: run.id })
    expect((await f.raw({ operation: 'decide', id: run.id, attemptId: run.attemptId,
      action: 'approve', expireOnly: true })).status).toBe(409)
    expect(await f.owner.operation({ operation: 'runs.events', id: run.id })).toEqual(before)
    try {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.parse(open.expiresAt) + 1)
      expect((await f.operation({ operation: 'approval', id: run.id })).deadlineStatus).toBe('expired-at-observation')
      const closed = await f.operation({ operation: 'decide', id: run.id, attemptId: run.attemptId,
        action: 'approve', expireOnly: true })
      expect(closed).toMatchObject({ status: 'failed', code: 'approval-expired', nodeId: 'review' })
      expect(closed.steps.map((step: any) => step.nodeId)).toEqual(['start'])
    } finally { vi.useRealTimers() }
  })

  it('reports an expired timeout branch and pauses before its downstream output', async () => {
    const source = approval.replace('expiresAfter: 24h', 'expiresAfter: 30s').replace('onTimeout: expired', 'onTimeout: branch')
      .replace('      port: approve\n      to: result', '      port: approve\n      to: result\n    - from: review\n      port: timeout\n      to: result')
    const f = await fixture(source), run = await f.operation({ operation: 'run', id: randomUUID(), input: { message: 'Synthetic timeout branch' } })
    expect(run.status).toBe('waiting')
    const review = await f.operation({ operation: 'approval', id: run.id })
    expect(review).toMatchObject({ deadlineStatus: 'open-at-observation', timeoutOutcome: 'branch' })
    try {
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(review.expiresAt) + 1)
      expect((await f.operation({ operation: 'approval', id: run.id })).deadlineStatus).toBe('expired-at-observation')
      const paused = await f.operation({ operation: 'decide', id: run.id, attemptId: run.attemptId,
        action: 'approve', expireOnly: true, pauseAfter: true })
      expect(paused).toMatchObject({ status: 'paused', nodeId: 'result' })
      expect(paused.steps.map((step: any) => step.nodeId)).toEqual(['start', 'review'])
      expect((await f.operation({ operation: 'show', id: run.id })).status).toBe('paused')
    } finally { vi.useRealTimers() }
  })

  it('cancels a scoped waiting run and retains evidence after the preview owner shuts down', async () => {
    const f = await fixture(approval), run = await f.operation({ operation: 'run', id: randomUUID(), input: { message: 'Stop' } })
    const command = { operation: 'cancel', id: run.id, requestId: randomUUID() }, stopped = await f.operation(command)
    expect(stopped.status).toBe('cancelled'); expect(await f.operation(command)).toEqual(stopped)
    await f.service.close()
    const owner = await LocalRuntime.open({ dataDirectory: f.dataDirectory })
    try { expect(owner.project(f.session.project.id).acceptedRevision).toBe(f.session.project.revision)
      expect((await owner.show(run.id)).state.status).toBe('cancelled') } finally { await owner.close() }
  })

  it('bounds session credentials, revokes on logout and expires them without executing anything', async () => {
    const f = await fixture()
    for (let index = 0; index < 7; index++) expect((await f.post('/v1/preview/bootstrap', {})).status).toBe(200)
    expect((await f.post('/v1/preview/bootstrap', {})).status).toBe(413)
    expect((await f.post('/v1/preview/logout', {}, f.session.token)).status).toBe(200)
    expect((await f.raw({ operation: 'view' })).status).toBe(401)
    const next = (await (await f.post('/v1/preview/bootstrap', {})).json() as any).result
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 3_600_001)
    expect((await f.raw({ operation: 'view' }, next.token)).status).toBe(401)
    expect((await f.post('/v1/preview/bootstrap', {})).status).toBe(200)
  })

  it('rejects invalid executable previews and releases ownership without creating a project', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-invalid-preview-'))
    await expect(startRuntimeService({ runtime: { dataDirectory }, token: ownerToken, actor: 'local:owner', preview: { source: echo.replace('to: result', 'to: missing') } })).rejects.toThrow()
    const owner = await LocalRuntime.open({ dataDirectory })
    try { expect(owner.projects()).toEqual([]) } finally { await owner.close() }
  })

  it('emits parseable hashed scripts and matching control elements, without claiming browser enforcement', () => {
    const { html, csp } = renderLivePage('</script>hostile', PROTOCOL_VERSION)
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!, style = html.match(/<style>([\s\S]*?)<\/style>/)![1]!
    expect(() => new Script(script)).not.toThrow()
    for (const text of [script, style]) expect(csp).toContain(`sha256-${createHash('sha256').update(text).digest('base64')}`)
    expect(html).not.toContain('</script>hostile')
    expect(script).not.toContain('innerHTML'); expect(script).not.toContain('localStorage')
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])
    expect(new Set(ids).size).toBe(ids.length)
    for (const match of script.matchAll(/\bel\('([^']+)'\)/g)) expect(ids).toContain(match[1])
    expect(csp).not.toContain('unsafe-inline'); expect(csp).not.toContain('unsafe-eval')
  })
})
