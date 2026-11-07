import { isDeepStrictEqual } from 'node:util'
import { modelRequestPlan, type ModelNodePlan, type PreparedModelInput } from '../runtime/model-plan.ts'
import { ProviderError } from './config.ts'
import { prepareModelWire } from './model-wire.ts'
import type { ModelEvidence } from './records.ts'

/** Check any retained request, including an unsettled one, against its source-pinned preparation. No current credentials or I/O. */
export function verifyEvidenceRequest(node: ModelNodePlan, input: PreparedModelInput, evidence: ModelEvidence) {
  const plan = modelRequestPlan(node)
  let wire: ReturnType<typeof prepareModelWire>
  try { wire = prepareModelWire(plan, input, evidence.route.connection) } catch { throw new ProviderError('corrupt-evidence') }
  if (plan.connection.mode !== 'workspace' || evidence.route.connection.id !== plan.connection.id
    || evidence.route.connection.provider !== plan.provider || !evidence.route.connection.allowedModels.includes(plan.model)
    || !isDeepStrictEqual(evidence.request, wire.request)
    || (evidence.schemaVersion === 1 ? plan.execution.maxAttempts !== 1 : evidence.policy.maxAttempts !== plan.execution.maxAttempts
      || evidence.policy.timeoutSeconds !== plan.execution.timeoutSeconds)) throw new ProviderError('corrupt-evidence')
  if (wire.decode && evidence.result.status === 'completed') {
    try {
      const result = wire.decode(evidence.result.output)
      if (!isDeepStrictEqual(evidence.result.usage, { ...result.usage, tries: evidence.schemaVersion === 1 ? 1 : evidence.tries.length })
        || evidence.result.providerModel !== result.providerModel || evidence.result.responseId !== undefined) throw new Error()
    } catch { throw new ProviderError('corrupt-evidence') }
  }
}
