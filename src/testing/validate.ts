import { validateWorkflowValue, type CompiledWorkflow, type WorkflowCompilerLimits } from '../workflow/index.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import type { TestDefinition } from './schema.ts'

export function validateTestTriggerMode(triggerMode: TestDefinition['triggerMode'], graph: CompiledWorkflow) {
  if (triggerMode === undefined) return
  const trigger = graph.nodes[0]?.plan
  if (triggerMode !== 'api' || trigger?.kind !== 'trigger' || !trigger.modes.includes('api')) throw new WorkflowRuntimeError('invalid-command')
}

/** Same semantic admission for local drafts and untrusted transferred definitions; no execution. */
export function validateTestSource(definition: TestDefinition, graph: CompiledWorkflow, limits: WorkflowCompilerLimits) {
  validateTestTriggerMode(definition.triggerMode, graph)
  validateWorkflowValue(graph.input, definition.input, limits.binding.data)
  for (const expectation of definition.expectations) {
    if (!('nodeId' in expectation)) continue
    const loop = expectation.scope ? graph.nodes.find(node => node.id === expectation.scope!.loop)?.plan : undefined
    const nodes = expectation.scope ? loop?.kind === 'loop' ? loop.body.nodes : [] : graph.nodes
    const selected = nodes.find(node => node.id === expectation.nodeId)
    if (!selected) throw new WorkflowRuntimeError('invalid-command')
    if (expectation.kind === 'node-port-equals') {
      const exits = expectation.scope && loop?.kind === 'loop' ? loop.body.exits : []
      if (!Object.hasOwn(selected.destinations, expectation.value)
        && !exits.some(exit => exit.from === selected.id && exit.port === expectation.value)) throw new WorkflowRuntimeError('invalid-command')
    }
  }
}
