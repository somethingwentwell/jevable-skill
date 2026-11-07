/** Typed Decision output schemas and provider-independent probability consistency checks. */
import { assertNever } from "../shared/values.js";
import { compileValueSchema, validateWorkflowValue } from "./value-schema.js";
import { WorkflowValueError } from "./errors.js";
import { assertSystemOneAnswers, systemOneAnswerSchema } from "./systemone-answers.js";
function probability() { return { type: 'number', minimum: 0, maximum: 1 }; }
function answerSchema(question) {
    const common = { type: { type: 'string', enum: [question.type] },
        confidence: probability(), explanation: { type: 'string' } };
    switch (question.type) {
        case 'choice': {
            const labels = Object.keys(question.criteria);
            return { type: 'object', additionalProperties: false, required: ['type', 'choice', 'probabilities', 'confidence'],
                properties: { ...common, choice: { type: 'string', enum: [...labels] },
                    probabilities: { type: 'object', additionalProperties: false, required: labels,
                        properties: Object.fromEntries(labels.map(label => [label, probability()])) } } };
        }
        case 'score': return { type: 'object', additionalProperties: false, required: ['type', 'score', 'probabilities', 'confidence'],
            properties: { ...common, score: { type: 'number', minimum: 0, maximum: question.criteria.length - 1 },
                probabilities: { type: 'array', items: probability(), minItems: question.criteria.length, maxItems: question.criteria.length } } };
        case 'noul': return { type: 'object', additionalProperties: false, required: ['type', 'probability', 'confidence'],
            properties: { ...common, probability: probability() } };
        /* v8 ignore next -- strict question admission owns this closed union. */
        default: return assertNever(question);
    }
}
/**
 * Compile exact per-question answer fields for downstream typed references.
 * @param questions - Source-admitted questions and their ordered criteria.
 * @param limits - Bounds on the complete generated schema, not just each question.
 * @returns an immutable schema receipt; numeric relationships additionally require validateDecisionAnswers.
 */
export function compileDecisionOutput(questions, limits, answerFormat) {
    return compileValueSchema({ type: 'object', additionalProperties: false, required: Object.keys(questions),
        properties: Object.fromEntries(Object.entries(questions).map(([key, question]) => [key,
            answerFormat === 'systemone-v1' ? systemOneAnswerSchema(question) : answerSchema(question)])) }, limits);
}
/**
 * Validate normalized provider answers without guessing missing values, coercing or changing probabilities.
 * @param plan - Locally compiled Decision instructions, including their exact output schema receipt.
 * @param value - Adapter-normalized untrusted answers; raw provider envelopes are not accepted.
 * @param limits - Bounds on the complete result including optional explanations.
 * @returns a detached frozen answer map with unit probability mass, maximal choices and expected ordinal scores.
 * @throws WorkflowValueError for invalid data or inconsistent distributions, without exposing provider content.
 */
export function validateDecisionAnswers(plan, value, limits) {
    if (plan.answerFormat === 'systemone-v1') {
        const answers = validateWorkflowValue(plan.output, value, limits);
        assertSystemOneAnswers(plan.questions, answers);
        return answers;
    }
    const answers = validateWorkflowValue(plan.output, value, limits);
    for (const answer of Object.values(answers)) {
        if (answer.type === 'noul')
            continue;
        const probabilities = Object.values(answer.probabilities);
        // Floating-point accumulation error only; adapters must normalize rounded provider distributions explicitly.
        const tolerance = Number.EPSILON * probabilities.length * 8;
        if (Math.abs(probabilities.reduce((total, value) => total + value, 0) - 1) > tolerance) {
            throw new WorkflowValueError('Decision probabilities must sum to one.');
        }
        if (answer.type === 'choice') {
            // The compiled schema requires every label and constrains choice to those same labels.
            const selected = answer.probabilities[answer.choice];
            if (probabilities.some(value => value > selected)) {
                throw new WorkflowValueError('Decision choice must have maximal probability.');
            }
        }
        else {
            const expected = probabilities.reduce((total, value, index) => total + value * index, 0);
            if (Math.abs(expected - answer.score) > tolerance * probabilities.length) {
                throw new WorkflowValueError('Decision score must match the expected ordinal level.');
            }
        }
    }
    return answers;
}
