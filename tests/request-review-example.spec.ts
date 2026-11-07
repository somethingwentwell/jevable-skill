import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileWorkflowYaml } from '../src/workflow/index.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { LocalRuntime } from '../src/runtime/index.ts'
import { AGENT_SKILL_RESOURCES } from '../src/management/skill-resources.ts'

const example = (name: string) => readFile(new URL(`../examples/${name}`, import.meta.url), 'utf8')

describe('shipped model-free Request review example', () => {
  it('ships the workflow and both inputs in the standalone skill inventory', async () => {
    for (const name of ['request-review.yaml', 'request-review-routine-input.json', 'request-review-sensitive-input.json']) {
      expect(AGENT_SKILL_RESOURCES.filter(resource => resource === `examples/${name}`)).toHaveLength(1)
      expect((await example(name)).length).toBeGreaterThan(0)
    }
  })

  it('compiles and retains distinct routine completion and sensitive approval wait across owner replacement', async () => {
    const source = await example('request-review.yaml')
    expect(() => compileWorkflowYaml(source, DEFAULT_COMPILER_LIMITS)).not.toThrow()
    const routineInput = JSON.parse(await example('request-review-routine-input.json'))
    const sensitiveInput = JSON.parse(await example('request-review-sensitive-input.json'))
    const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-request-review-example-'))
    let runtime = await LocalRuntime.open({ dataDirectory })
    let routineId = '', sensitiveId = '', attemptId = ''
    try {
      const routine = await runtime.run(source, routineInput)
      const sensitive = await runtime.run(source, sensitiveInput)
      routineId = routine.id
      sensitiveId = sensitive.id
      expect(routine.state).toMatchObject({ status: 'completed', output: routineInput.message })
      expect(routine.state.steps.map(step => [step.nodeId, step.port])).toEqual([
        ['start', 'next'], ['route', 'false'], ['directResult', undefined],
      ])
      expect(sensitive.state.status).toBe('waiting')
      if (sensitive.state.status !== 'waiting') throw Error('Expected a retained approval wait')
      attemptId = sensitive.state.attempt.id
      expect(sensitive.state.steps.map(step => [step.nodeId, step.port])).toEqual([
        ['start', 'next'], ['route', 'true'],
      ])
      expect(await runtime.events(sensitiveId)).not.toContainEqual(expect.objectContaining({ kind: 'approval-decided' }))
    } finally { await runtime.close() }

    runtime = await LocalRuntime.open({ dataDirectory })
    try {
      expect((await runtime.show(routineId)).state).toMatchObject({ status: 'completed', output: routineInput.message })
      const sensitive = await runtime.show(sensitiveId)
      expect(sensitive.state).toMatchObject({ status: 'waiting', attempt: { id: attemptId } })
      expect(sensitive.state.steps.some(step => step.nodeId === 'reviewedResult')).toBe(false)
    } finally { await runtime.close() }
  })
})
