import { expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { WorkflowCompilerLimits } from '../src/workflow/index.ts'
import { advanceDurably, admitExecution, compileLocalRun, findNode, initialCheckpoint } from '../src/runtime/run-evaluator.ts'
import type { RunCheckpoint } from '../src/runtime/run-evaluator.ts'
import type { JevableNodeAttempt } from '../src/runtime/run-types.ts'

const limits: WorkflowCompilerLimits = {
  source: { maxSourceBytes: 10_000, maxDepth: 24, maxValues: 1000, maxNodes: 10, maxEdges: 10 },
  schema: { maxBytes: 10_000, maxDepth: 24, maxValues: 1000 },
  binding: { data: { maxBytes: 10_000, maxDepth: 24, maxValues: 1000 }, maxExpressions: 10,
    expression: { maxSourceBytes: 1024, maxNodes: 100, maxDepth: 24, maxResultBytes: 10_000 } },
}
const graph = compileLocalRun(JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow',
  metadata: { id: 'prepared', name: 'Prepared' }, spec: { inputSchema: { type: 'string' },
    nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
      result: { type: 'output', config: { value: '${{ inputs }}' } } }, edges: [{ from: 'start', to: 'result' }] } }), limits)

it('refuses Custom execution even when the source compiles', () => {
  expect(() => compileLocalRun(JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'code', name: 'Code' },
    spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
      code: { type: 'custom', config: { language: 'javascript', code: 'return input', input: '${{ inputs }}', outputSchema: { type: 'string' } } },
      result: { type: 'output', config: { value: '${{ nodes.code.output }}' } } },
    edges: [{ from: 'start', to: 'code' }, { from: 'code', to: 'result' }] } }), limits)).toThrow('invalid-command')
})

it('admits Human Approval in the outer graph and inside a bounded loop body', async () => {
  const yaml = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
  await expect(admitExecution(compileLocalRun(yaml, limits))).resolves.toBeUndefined()
  const nested = compileLocalRun(JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'nested', name: 'Nested' },
    spec: { inputSchema: { type: 'array', items: { type: 'string' } }, nodes: {
      start: { type: 'trigger', config: { modes: ['manual'] } },
      each: { type: 'loop', config: { mode: 'forEach', items: '${{ inputs }}', maxIterations: 3, timeoutSeconds: 60, body: { entry: 'review',
        nodes: { review: { type: 'humanApproval', config: { title: 'Check', input: '${{ loop.item }}', inputSchema: { type: 'string' },
          actions: ['approve'], expiresAfter: '1h', onReject: 'branch', onTimeout: 'expired' } } },
        edges: [], exits: [{ from: 'review', port: 'approve', result: true }] } } },
      result: { type: 'output', config: { value: '${{ nodes.each.output.count }}' } },
    }, edges: [{ from: 'start', to: 'each' }, { from: 'each', port: 'done', to: 'result' }] } }), limits)
  await expect(admitExecution(nested)).resolves.toBeUndefined()
})

it('requires explicit model execution policy for Decision graphs before creating a run', async () => {
  const yaml = await readFile(new URL('../examples/decision.yaml', import.meta.url), 'utf8')
  await expect(admitExecution(compileLocalRun(yaml, limits))).rejects.toThrow('invalid-command')
})

it('waits for immutable preparation to commit before starting a span or settling the result', async () => {
  const committed = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<JevableNodeAttempt>()
  const span = vi.fn(() => undefined), result = vi.fn(async (value: RunCheckpoint) => value)
  const run = advanceDurably(graph, 'Saved input', initialCheckpoint(graph), limits.schema, {
    async intent(attempt) { entered.resolve(attempt); await committed.promise }, span, result,
  })
  const attempt = await entered.promise
  expect(attempt).toEqual({ id: expect.any(String) as unknown, nodeId: 'start', prepared: { status: 'ready', input: 'Saved input' } })
  expect(Object.isFrozen(attempt.prepared)).toBe(true)
  expect(span).not.toHaveBeenCalled()
  expect(result).not.toHaveBeenCalled()
  committed.resolve(undefined)
  expect(await run).toMatchObject({ status: 'paused', steps: [{ inspection: { input: 'Saved input', attemptId: attempt.id } }] })
  expect(span).toHaveBeenCalledExactlyOnceWith(attempt.id)
  expect(result).toHaveBeenCalledTimes(1)
})

it('does not start an attempt span or settle a result if intent storage fails', async () => {
  const span = vi.fn(() => undefined), result = vi.fn()
  await expect(advanceDurably(graph, 'Saved input', initialCheckpoint(graph), limits.schema, {
    async intent() { throw new Error('storage unavailable') }, span, result,
  })).rejects.toThrow('storage unavailable')
  expect(span).not.toHaveBeenCalled()
  expect(result).not.toHaveBeenCalled()
})

it('finds scoped nodes only inside an existing loop body', () => {
  type Id = Parameters<typeof findNode>[1]
  expect(findNode(graph, 'result' as Id)?.id).toBe('result')
  expect(findNode(graph, 'result' as Id, { loop: 'start' as Id, index: 0 })).toBeUndefined()
  expect(findNode(graph, 'result' as Id, { loop: 'missing' as Id, index: 0 })).toBeUndefined()
})
