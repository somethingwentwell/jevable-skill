/** Strict first-slice node configuration, with no credential resolution or network effects. */
import { z } from 'zod';
import { approvalActionSchema } from "./approval-action.js";
const positive = z.number().int().positive();
const name = z.string().trim().min(1).max(256);
const reference = z.string().regex(/^[A-Za-z][A-Za-z0-9._/-]{0,127}$/u);
const branch = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u)
    .refine(value => !['__proto__', 'constructor', 'prototype', 'default'].includes(value));
const endpoint = z.string().refine((value) => {
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
            && !url.search && !url.hash && !value.includes('${{');
    }
    catch (_error) {
        return false;
    }
});
const connection = z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('workspace'), id: reference.transform(value => value) }),
    z.strictObject({ mode: z.literal('custom'), protocol: z.literal('openai-compatible'), endpoint,
        credentialRef: reference.transform(value => value).optional() }),
]);
const decisionKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u)
    .refine(value => !['__proto__', 'constructor', 'prototype'].includes(value));
const choiceLabel = z.string().min(1).refine(value => value.trim().length > 0
    && !['__proto__', 'constructor', 'prototype'].includes(value));
const instruction = z.string().trim().min(1);
const generation = z.strictObject({ maxTokens: positive, temperature: z.number().min(0).max(2).optional(),
    topP: z.number().positive().max(1).optional(), stream: z.boolean() });
const question = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('choice'), instructions: instruction,
        criteria: z.record(choiceLabel, instruction).refine(value => Object.keys(value).length >= 2) }),
    z.strictObject({ type: z.literal('score'), instructions: instruction, criteria: z.array(instruction).min(2)
            .refine(values => new Set(values).size === values.length) }),
    z.strictObject({ type: z.literal('noul'), instructions: instruction }),
]);
/** Typed Decision questions require explicit routing and execution settings; no adapter is selected by compilation. */
export const decisionConfig = z.strictObject({
    description: z.string().optional(), provider: name, model: name,
    answerFormat: z.literal('systemone-v1').optional(),
    connection: z.discriminatedUnion('mode', [
        z.strictObject({ mode: z.literal('workspace'), id: reference.transform(value => value) }),
        z.strictObject({ mode: z.literal('custom'), protocol: name, endpoint,
            credentialRef: reference.transform(value => value).optional() }),
    ]),
    state: z.json(), questions: z.record(decisionKey, question).refine(value => Object.keys(value).length > 0),
    llm: z.strictObject({ provider: name, generation }).optional(),
    execution: z.strictObject({ timeoutSeconds: positive, maxAttempts: positive }),
}).refine(value => (value.provider === 'llm') === (value.llm !== undefined))
    .refine(value => value.answerFormat === undefined || ['jev', 'laya'].includes(value.provider)
    && Object.values(value.questions).every(question => question.type === 'choice' ? Object.keys(question.criteria).length <= 255
        : question.type === 'score' ? question.criteria.length <= 10 : true));
/** Trigger modes must be explicitly declared and unique. */
export const triggerConfig = z.strictObject({ modes: z.array(z.enum(['manual', 'chat', 'api', 'webhook'])).min(1)
        .refine(modes => new Set(modes).size === modes.length) });
/** LLM requests are explicit; unsupported settings cannot disappear during parsing. */
export const llmConfig = z.strictObject({
    description: z.string().optional(), provider: name, model: name, connection,
    prompt: z.string().min(1), systemPrompt: z.string().optional(),
    input: z.json().optional(), inputSchema: z.json().optional(), outputSchema: z.json().optional(),
    responseFormat: z.enum(['text', 'json-schema']),
    generation,
    execution: z.strictObject({ timeoutSeconds: positive, maxAttempts: positive }),
    historyScope: z.enum(['none', 'current-run', 'admitted-project']),
    historyLimits: z.strictObject({ maxMessages: positive, maxBytes: positive }).optional(),
});
/** Rule conditions remain visible, typed nodes instead of arbitrary edge scripts. */
export const ruleConfig = z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('ifElse'), condition: z.string().min(1) }),
    z.strictObject({ mode: z.literal('switch'), value: z.json(), cases: z.array(z.strictObject({ port: branch,
            value: z.union([z.string(), z.number(), z.boolean(), z.null()]) })).min(1) }),
]);
/** Output bindings may optionally declare an additional runtime result schema. */
export const outputConfig = z.strictObject({ value: z.json(), outputSchema: z.json().optional() });
/** Approval expiry is an exact positive duration; terminal rejection/expiry never authorizes continuation. */
export const approvalConfig = z.strictObject({
    title: z.string().trim().min(1), input: z.json(), inputSchema: z.json(),
    actions: z.array(approvalActionSchema).min(1).max(200)
        .refine(actions => new Set(actions).size === actions.length),
    expiresAfter: z.string().regex(/^[1-9][0-9]*(ms|s|m|h|d)$/u).transform((value) => {
        const amount = Number.parseInt(value, 10);
        const unit = value.replace(/^[0-9]+/u, '');
        return amount * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
    }).refine(value => Number.isSafeInteger(value) && value > 0),
    onReject: z.enum(['cancelled', 'branch']), onTimeout: z.enum(['expired', 'branch']),
}).refine(value => value.onReject !== 'cancelled' || value.actions.includes('reject'));
const bodyNodeId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u)
    .refine(value => !['__proto__', 'constructor', 'prototype'].includes(value));
/** Loop bodies hold only step families; triggers, outputs and nested loops are outer-graph concepts. */
const bodyNode = z.strictObject({
    type: z.enum(['llm', 'decision', 'rule', 'humanApproval', 'custom']),
    title: z.string().optional(), description: z.string().optional(),
    config: z.record(z.string(), z.json()), extensions: z.record(z.string(), z.json()).optional(),
});
const loopBody = z.strictObject({
    entry: bodyNodeId,
    nodes: z.record(bodyNodeId, bodyNode),
    edges: z.array(z.strictObject({ from: bodyNodeId, to: bodyNodeId, port: branch.optional() })),
    exits: z.array(z.strictObject({ from: bodyNodeId, port: branch.optional(), result: z.json() })).min(1),
});
const loopLimits = { maxIterations: positive, timeoutSeconds: positive };
/** Sequential, bounded iteration; the body runs once per item or until its condition holds. */
export const loopConfig = z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('forEach'), description: z.string().optional(), items: z.json(), ...loopLimits, body: loopBody }),
    z.strictObject({ mode: z.literal('repeatUntil'), description: z.string().optional(), input: z.json(), until: z.string().min(1),
        ...loopLimits, onLimit: z.enum(['fail', 'branch']), body: loopBody }),
]);
/** Code-first Custom node; compilation grants no execution, dependency or capability permission. */
export const customConfig = z.strictObject({
    language: z.literal('javascript'), code: z.string(), input: z.json(), inputSchema: z.json().optional(), outputSchema: z.json(),
    execution: z.strictObject({ timeoutSeconds: positive, maxAttempts: positive }).optional(),
});
