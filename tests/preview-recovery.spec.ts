import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createPreview } from '../src/preview/model.ts'
import { previewRecoveryTarget } from '../src/preview/recovery.ts'
import { parse } from 'yaml'

const source = await readFile(new URL('../examples/native-decision.yaml', import.meta.url), 'utf8')
const preview = createPreview(source)
const receipt = () => ({ id: randomUUID(), revision: preview.revision, checkpointSha256: 'a'.repeat(64),
  status: 'executing', nodeId: 'judge', attemptId: randomUUID() })
const target: typeof previewRecoveryTarget = new Function(`return (${previewRecoveryTarget.toString()})`)()

describe('serialized preview recovery eligibility hints (not evidence of a committed reply)', () => {
  it('pins the exact run, revision, attempt and checkpoint without carrying source or private inputs', () => {
    const run = { ...receipt(), input: 'PRIVATE_INPUT' }, result = target(preview, run)
    expect(result).toMatchObject({ id: run.id, attemptId: run.attemptId, checkpointSha256: run.checkpointSha256, label: 'judge' })
    expect(result!.identity).toContain(preview.revision); expect(JSON.stringify(result)).not.toContain('PRIVATE_')
    expect(target(preview, { ...run, checkpointSha256: 'b'.repeat(64) })!.identity).not.toBe(result!.identity)
  })
  it.each(['paused', 'waiting', 'completed', 'failed', 'cancelled'])('refuses %s status', status => {
    expect(target(preview, { ...receipt(), status })).toBeNull()
  })
  it.each([
    { id: 'invalid' }, { revision: 'b'.repeat(64) }, { attemptId: 'invalid' }, { checkpointSha256: 'invalid' },
    { cancellation: {} }, { nodeId: 'start' }, { nodeId: 'result' }, { nodeId: 'missing' }, { scope: null },
    { scope: { loop: 'judge', index: 0 } }, { scope: { loop: 'missing', index: 0 } },
  ])('refuses mismatched, cancelled or non-model receipt $nodeId', fields => {
    expect(target(preview, { ...receipt(), ...fields })).toBeNull()
  })
  it('only offers a scoped model in its actual loop body and iteration', () => {
    const definition = parse(source), judge = definition.spec.nodes.judge
    definition.spec.inputSchema = { type: 'array', items: { type: 'string' }, maxItems: 2 }; judge.config.state = '${{ loop.item }}'
    definition.spec.nodes = { start: definition.spec.nodes.start, each: { type: 'loop', config: { mode: 'forEach', items: '${{ inputs }}',
      maxIterations: 2, timeoutSeconds: 60, body: { entry: 'judge', nodes: { judge }, edges: [], exits: [{ from: 'judge', result: '${{ nodes.judge.output }}' }] } } },
    result: { type: 'output', config: { value: '${{ nodes.each.output.results }}' } } }
    definition.spec.edges = [{ from: 'start', to: 'each' }, { from: 'each', port: 'done', to: 'result' }]
    const graph = createPreview(JSON.stringify(definition))
    expect(graph.validation.status).toBe('valid')
    const run = { ...receipt(), revision: graph.revision, scope: { loop: 'each', index: 1 } }
    expect(target(graph, run)!.label).toContain('iteration 1')
    expect(target(graph, { ...run, scope: undefined })).toBeNull()
    for (const index of [-1, 0.5, '1']) expect(target(graph, { ...run, scope: { loop: 'each', index } })).toBeNull()
    expect(target(graph, { ...run, scope: { loop: 'each', index: 0 } })!.identity).not.toBe(target(graph, run)!.identity)
  })
})
