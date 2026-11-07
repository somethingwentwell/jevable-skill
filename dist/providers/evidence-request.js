import { isDeepStrictEqual } from 'node:util';
import { modelRequestPlan } from "../runtime/model-plan.js";
import { ProviderError } from "./config.js";
import { prepareModelWire } from "./model-wire.js";
/** Check any retained request, including an unsettled one, against its source-pinned preparation. No current credentials or I/O. */
export function verifyEvidenceRequest(node, input, evidence) {
    const plan = modelRequestPlan(node);
    let wire;
    try {
        wire = prepareModelWire(plan, input, evidence.route.connection);
    }
    catch {
        throw new ProviderError('corrupt-evidence');
    }
    if (plan.connection.mode !== 'workspace' || evidence.route.connection.id !== plan.connection.id
        || evidence.route.connection.provider !== plan.provider || !evidence.route.connection.allowedModels.includes(plan.model)
        || !isDeepStrictEqual(evidence.request, wire.request)
        || (evidence.schemaVersion === 1 ? plan.execution.maxAttempts !== 1 : evidence.policy.maxAttempts !== plan.execution.maxAttempts
            || evidence.policy.timeoutSeconds !== plan.execution.timeoutSeconds))
        throw new ProviderError('corrupt-evidence');
    if (wire.decode && evidence.result.status === 'completed') {
        try {
            const result = wire.decode(evidence.result.output);
            if (!isDeepStrictEqual(evidence.result.usage, { ...result.usage, tries: evidence.schemaVersion === 1 ? 1 : evidence.tries.length })
                || evidence.result.providerModel !== result.providerModel || evidence.result.responseId !== undefined)
                throw new Error();
        }
        catch {
            throw new ProviderError('corrupt-evidence');
        }
    }
}
