import { ProviderError } from "./config.js";
import { requestBody, readCompletion } from "./openai-wire.js";
import { createSystemOneRequest, parseSystemOneReply, readSystemOneReply } from "./systemone.js";
export const nativeDataLimits = { maxDepth: 64, maxValues: 100_000 };
function nativeResult(result) {
    return { output: result.raw, providerModel: result.reply.model, usage: { tries: 1,
            inputTokens: result.reply.usage.input_tokens, outputTokens: result.reply.usage.output_tokens } };
}
export function prepareModelWire(plan, input, connection) {
    if (plan.responseFormat === 'systemone-v1') {
        if (connection.protocol !== 'systemone' || input.systemPrompt !== '' || input.history !== undefined)
            throw new ProviderError('unsupported-settings');
        let state;
        try {
            state = JSON.parse(input.prompt);
        }
        catch {
            throw new ProviderError('unsupported-settings');
        }
        const limits = { maxRequestBytes: connection.maxRequestBytes, maxResponseBytes: connection.maxResponseBytes, ...nativeDataLimits };
        const request = createSystemOneRequest({ model: plan.model, state, questions: plan.questions }, limits);
        return { request, path: '/systemone', accept: 'application/json',
            read: async (response) => nativeResult(await readSystemOneReply(response, request, limits)),
            decode: (raw) => nativeResult(parseSystemOneReply(raw, request, limits)) };
    }
    if (connection.protocol !== 'openai-compatible')
        throw new ProviderError('unsupported-settings');
    return { request: requestBody(plan, input, connection.tokenParameter), path: '/chat/completions',
        accept: plan.generation.stream ? 'text/event-stream' : 'application/json',
        read: (response) => readCompletion(response, plan, connection) };
}
