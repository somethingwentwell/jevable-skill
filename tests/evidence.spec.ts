import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalRuntime, RUN_EVIDENCE_LIMITS, type ModelCalls } from '../src/runtime/index.ts'
import { RunStore } from '../src/runtime/store.ts'
import { createRunEvidence } from '../src/runtime/evidence.ts'
import { renderTemplate, listTemplates } from '../src/templates/index.ts'
import { main } from '../src/cli.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(options: Partial<Parameters<typeof LocalRuntime.open>[0]> = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-evidence-'))
  const runtime = await LocalRuntime.open({ dataDirectory, ...options }); cleanup.push(() => runtime.close())
  return { runtime, dataDirectory }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const modelSource = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'model', name: 'Model' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false },
      execution: { timeoutSeconds: 60, maxAttempts: 1 }, historyScope: 'none' } },
    end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } },
  edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })

describe('bounded read-only run evidence export', () => {
  it('excludes all payloads by default while retaining exact identities, step order and journal boundary', async () => {
    const { runtime } = await fixture()
    runtime.setCredential('secret/ref', 'CREDENTIAL_NOT_IN_EXPORT', 0, 'PRIVATE_CREDENTIAL_ACTOR')
    const run = await runtime.run(echo.replace('Standalone echo', 'PRIVATE_SOURCE_NAME'), 'PRIVATE_INPUT_OUTPUT')
    const before = await runtime.events(run.id), evidence = await runtime.exportRun(run.id)
    expect(evidence.snapshot.run).toMatchObject({ id: run.id, revision: run.revision, status: 'completed' })
    expect(evidence.snapshot.steps.map(step => step.nodeId)).toEqual(run.state.steps.map(step => step.nodeId))
    expect(evidence.snapshot.boundary).toMatchObject({ eventCount: before.length, firstSequence: before[0]!.sequence, lastSequence: before.at(-1)!.sequence, terminal: true })
    expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE_|CREDENTIAL_NOT_IN_EXPORT/)
    expect(evidence.snapshot).not.toHaveProperty('private')
    expect(evidence.snapshot.run).not.toHaveProperty('output')
    expect(evidence.checksum.value).toBe(digest(evidence.snapshot))
    expect(await runtime.exportRun(run.id)).toEqual(evidence)
    expect(await runtime.events(run.id)).toEqual(before)
    const privateEvidence = await runtime.exportRun(run.id, true)
    expect(privateEvidence.snapshot.private!.run).toEqual(run)
    expect(privateEvidence.snapshot.private!.journal).toEqual(before)
    expect(JSON.stringify(privateEvidence)).toContain('PRIVATE_INPUT_OUTPUT')
    expect(JSON.stringify(privateEvidence)).not.toContain('CREDENTIAL_NOT_IN_EXPORT')
  })

  it('keeps waiting/decision/cancellation evidence without default actors or approval payloads', async () => {
    const { runtime } = await fixture(), run = await runtime.run(approval, { message: 'PRIVATE_REVIEW' })
    const waiting = await runtime.exportRun(run.id)
    expect(waiting.snapshot.boundary.terminal).toBe(false)
    expect(waiting.snapshot.run).toMatchObject({ status: 'waiting', attempt: { id: 'attempt' in run.state ? run.state.attempt.id : '' } })
    const stopped = runtime.cancel(run.id, randomUUID(), 'PRIVATE_CANCEL_ACTOR')
    const exported = await runtime.exportRun(run.id)
    expect(exported.snapshot.run).toMatchObject({ status: 'cancelled', previousStatus: 'waiting', cancellation: { id: stopped.cancellation!.id } })
    expect(JSON.stringify(exported)).not.toMatch(/PRIVATE_REVIEW|PRIVATE_CANCEL_ACTOR/)
    expect((await runtime.exportRun(run.id, true)).snapshot.private!.run.cancellation!.actor).toBe('PRIVATE_CANCEL_ACTOR')
    const next = await runtime.run(approval, { message: 'PRIVATE_SECOND_REVIEW' })
    if (next.state.status !== 'waiting') throw Error('Expected wait')
    await runtime.decide(next.id, next.state.attempt.id, 'approve', 'PRIVATE_REVIEWER')
    const decided = await runtime.exportRun(next.id)
    expect(decided.snapshot.journal.find(event => event.kind === 'approval-decided')).toHaveProperty('decision.kind', 'action')
    expect(JSON.stringify(decided)).not.toContain('PRIVATE_REVIEWER')
    const reject = await runtime.run(approval, { message: 'PRIVATE_REJECTED_INPUT' })
    if (reject.state.status !== 'waiting') throw Error('Expected wait')
    await runtime.decide(reject.id, reject.state.attempt.id, 'reject', 'PRIVATE_REJECTOR')
    const failed = await runtime.exportRun(reject.id)
    expect(failed.snapshot.run).toMatchObject({ status: 'failed', code: 'approval-rejected', failedAttempt: { attemptId: reject.state.attempt.id } })
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_REJECT')
  })

  it('retains loop scopes and available model usage without another model execution', async () => {
    const execute = vi.fn(async () => ({ output: 'PRIVATE_MODEL_OUTPUT', usage: { tries: 1, inputTokens: 3, outputTokens: 4 } }))
    const models: ModelCalls = { admit() {}, execute, async verify() {} }
    const { runtime } = await fixture({ models })
    const run = await runtime.run(modelSource, 'PRIVATE_MODEL_INPUT'), result = await runtime.exportRun(run.id)
    expect(result.snapshot.steps.find(step => step.nodeId === 'write')!.modelUsage).toEqual({ tries: 1, inputTokens: 3, outputTokens: 4 })
    expect(execute).toHaveBeenCalledOnce(); expect(JSON.stringify(result)).not.toContain('PRIVATE_MODEL')
    const template = listTemplates().find(item => item.id === 'expense-check')!
    const loop = await runtime.run(JSON.stringify(renderTemplate(template.id)), template.sample)
    expect((await runtime.exportRun(loop.id)).snapshot.steps.map(step => step.scope)).toEqual(loop.state.steps.map(step => step.scope))
  })

  it('does not resume paused or redispatch uncertain runs to obtain an export', async () => {
    const paused = await fixture({ maxTransitionsPerRun: 1 }), pausedId = randomUUID()
    await expect(paused.runtime.run(echo, 'private', { id: pausedId })).rejects.toHaveProperty('code', 'limit')
    expect((await paused.runtime.exportRun(pausedId)).snapshot.run.status).toBe('paused')
    const execute = vi.fn(async () => { throw Error('uncertain fixture') })
    const { runtime } = await fixture({ models: { admit() {}, execute, async verify() {} } }), id = randomUUID()
    await expect(runtime.run(modelSource, 'input', { id })).rejects.toThrow()
    const exported = await runtime.exportRun(id)
    expect(exported.snapshot.run.status).toBe('executing'); expect(exported.snapshot.boundary.terminal).toBe(false)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('retries a read if a cancellation commits during validation, without mixing checkpoints', async () => {
    const { runtime } = await fixture(), run = await runtime.run(approval, { message: 'Review' })
    const show = runtime.show.bind(runtime)
    vi.spyOn(runtime, 'show').mockImplementationOnce(async id => {
      const before = await show(id); runtime.cancel(id, randomUUID(), 'local:concurrent'); return before
    })
    const result = await runtime.exportRun(run.id, true)
    expect(result.snapshot.run.status).toBe('cancelled')
    expect(result.snapshot.private!.run).toEqual(await show(run.id))
    expect(result.snapshot.journal.at(-1)!.kind).toBe('run-cancelled')
    expect(result.checksum.value).toBe(digest(result.snapshot))
  })

  it('bounds concurrent snapshot retries, journal admission and serialized artifact size', async () => {
    const { runtime } = await fixture(), run = await runtime.run(echo, 'input'), show = runtime.show.bind(runtime)
    const read = vi.spyOn(runtime, 'show').mockImplementation(async id => ({ ...await show(id), updatedAt: '2000-01-01T00:00:00.000Z' }))
    await expect(runtime.exportRun(run.id)).rejects.toHaveProperty('code', 'busy')
    expect(read).toHaveBeenCalledTimes(RUN_EVIDENCE_LIMITS.snapshotAttempts); read.mockRestore()
    const bounds = vi.spyOn(RunStore.prototype, 'eventSize').mockReturnValue({ count: RUN_EVIDENCE_LIMITS.events + 1, bytes: 0 })
    await expect(runtime.exportRun(run.id)).rejects.toHaveProperty('code', 'limit')
    bounds.mockReturnValue({ count: 1, bytes: RUN_EVIDENCE_LIMITS.journalBytes + 1 })
    await expect(runtime.exportRun(run.id)).rejects.toHaveProperty('code', 'limit'); bounds.mockRestore()
    expect(() => createRunEvidence({ ...run, input: 'x'.repeat(RUN_EVIDENCE_LIMITS.artifactBytes) }, [], true)).toThrow(/limit/)
    await expect(runtime.exportRun(run.id, 'true' as unknown as boolean)).rejects.toHaveProperty('code', 'invalid-command')
  })

  it('rejects unsupported or unordered journal metadata rather than exporting a partial log', async () => {
    const { runtime } = await fixture(), run = await runtime.run(echo, 'input')
    const events = await runtime.events(run.id)
    expect(() => createRunEvidence(run, [...events, events[0]!], false)).toThrow(/corrupt/)
    expect(() => createRunEvidence(run, [{ ...events[0]!, kind: 'unknown-event' }], false)).toThrow(/corrupt/)
    expect(() => createRunEvidence(run, [{ ...events[0]!, at: 'invalid-time' }], false)).toThrow(/corrupt/)
    const intent = events.find(event => event.kind === 'node-intent')!
    expect(() => createRunEvidence(run, [{ ...intent, data: { attempt: { id: 'not-a-uuid', nodeId: 'start' } } }], true)).toThrow(/corrupt/)
  })

  it('keeps test provenance without exporting case names or expectations, and survives owner restart', async () => {
    const { runtime, dataDirectory } = await fixture(), project = runtime.editProject({ operation: 'create', title: 'PRIVATE_PROJECT_TITLE', yaml: echo, actor: 'local:owner' })
    const draft = runtime.editTest({ operation: 'create', actor: 'local:owner', definition: { title: 'PRIVATE_CASE_NAME',
      project: { id: project.id, generation: 1, revision: project.acceptedRevision }, input: 'PRIVATE_CASE_INPUT',
      expectations: [{ kind: 'status', value: 'completed' }, { kind: 'output-equals', value: 'PRIVATE_EXPECTATION' }] } })
    const accepted = runtime.editTest({ operation: 'accept', id: draft.id, expectedGeneration: 1, reviewedSha256: draft.sha256, actor: 'local:reviewer' })
    const test = { id: accepted.id, generation: accepted.generation, sha256: accepted.sha256 }, result = await runtime.runTest(test, randomUUID())
    const evidence = await runtime.exportRun(result.run.id)
    expect(evidence.snapshot.run.test).toEqual(test); expect(JSON.stringify(evidence)).not.toContain('PRIVATE_')
    await runtime.close(); const reopened = await LocalRuntime.open({ dataDirectory }); cleanup.push(() => reopened.close())
    expect(await reopened.exportRun(result.run.id)).toEqual(evidence)
  })

  it('publishes a private-mode file through the CLI and refuses implicit overwrite', async () => {
    const { runtime, dataDirectory } = await fixture(), run = await runtime.run(echo, 'PRIVATE_CLI_INPUT')
    await runtime.close()
    const output = join(dataDirectory, 'evidence.json'), out = vi.fn(), err = vi.fn()
    const command = ['runs', 'export', run.id, '--output', output, '--data-dir', dataDirectory]
    expect(await main(command, { out, err })).toBe(0)
    const receipt = JSON.parse(out.mock.calls.at(-1)![0]), bytes = await readFile(output)
    expect(receipt.artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(bytes.toString()).not.toContain('PRIVATE_CLI_INPUT')
    if (process.platform !== 'win32') expect((await stat(output)).mode & 0o777).toBe(0o600)
    expect(await main(command, { out, err })).toBe(1)
    expect(await main([...command, '--include-private', '--overwrite'], { out, err })).toBe(0)
    expect(await readFile(output, 'utf8')).toContain('PRIVATE_CLI_INPUT')
    expect(JSON.stringify(out.mock.calls)).not.toContain('PRIVATE_CLI_INPUT')
  })
})
