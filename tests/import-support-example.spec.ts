import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { previewVendorImport } from '../src/projects/vendor-import.ts'
import { parseWorkflow, compileWorkflowYaml, validateWorkflowValue } from '../src/workflow/index.ts'
import type { NodeId } from '../src/workflow/index.ts'
import { renderPreview } from '../src/preview/index.ts'
import { AGENT_SKILL_RESOURCES } from '../src/management/skill-resources.ts'

const resource = (name: string) => readFile(new URL(`../examples/import-support/${name}`, import.meta.url), 'utf8')
const reviewed = () => resource('reviewed.yaml')

describe('shipped support import example', () => {
  it('keeps real converter approximations and the original workflow ID rather than claiming equivalent code/model behavior', async () => {
    const conversion = previewVendorImport(await resource('n8n.json'), DEFAULT_COMPILER_LIMITS.source)
    expect(conversion.format).toBe('n8n')
    expect(conversion.mappings.filter(item => item.kind === 'exact')).toHaveLength(2)
    expect(conversion.mappings.filter(item => item.kind === 'approximate')).toHaveLength(2)
    expect(conversion.mappings.find(item => item.source === 'Normalize')).toMatchObject({ reason: 'code', kind: 'approximate' })
    expect(parseWorkflow(await reviewed(), DEFAULT_COMPILER_LIMITS.source).document.metadata.id)
      .toBe(parseWorkflow(conversion.yaml, DEFAULT_COMPILER_LIMITS.source).document.metadata.id)
  })

  it('compiles the typed native model contract, explicit review threshold and return-only graph without an execution adapter', async () => {
    const snapshot = parseWorkflow(await reviewed(), DEFAULT_COMPILER_LIMITS.source)
    compileWorkflowYaml(snapshot.yaml, DEFAULT_COMPILER_LIMITS)
    const nodes = snapshot.document.spec.nodes
    expect(Object.values(nodes).map(node => node.type)).toEqual(['decision', 'output', 'humanApproval', 'rule', 'trigger'])
    expect(nodes['judge' as NodeId]!.config).toMatchObject({ provider: 'jev', answerFormat: 'systemone-v1', model: 'your-explicit-model-id' })
    expect(nodes['route' as NodeId]!.config.condition).toContain('team.confidence < 0.7')
    expect(nodes['route' as NodeId]!.config.condition).toContain('review.noul >= 0.65')
    expect(snapshot.document.spec.edges).toContainEqual({ from: 'review', port: 'approve', to: 'result' })
    expect(nodes['result' as NodeId]!.config.value).toBe('${{ nodes.judge.output }}')
  })

  it.each(['billing-input.json', 'support-input.json', 'ambiguous-input.json'])('admits %s as a sample input without asserting a model answer', async name => {
    const graph = compileWorkflowYaml(await reviewed(), DEFAULT_COMPILER_LIMITS)
    const input = JSON.parse(await resource(name))
    expect(validateWorkflowValue(graph.input, input, DEFAULT_COMPILER_LIMITS.binding.data)).toEqual(input)
    expect(input.message).toBeTypeOf('string')
  })

  it('ships every guide/input in the curated skill inventory and emits an inspection-only exact-revision viewer', async () => {
    for (const name of ['n8n.json', 'reviewed.yaml', 'billing-input.json', 'support-input.json', 'ambiguous-input.json'])
      expect(AGENT_SKILL_RESOURCES).toContain(`examples/import-support/${name}`)
    expect(AGENT_SKILL_RESOURCES).toContain('references/import-support.md')
    const source = await reviewed(), snapshot = parseWorkflow(source, DEFAULT_COMPILER_LIMITS.source), preview = renderPreview(source)
    expect(preview.data.revision).toBe(snapshot.revision)
    expect(preview.data.execution).toBe('not-run')
    expect(preview.data.runtimeReadiness).toBe('not-checked')
  })
})
