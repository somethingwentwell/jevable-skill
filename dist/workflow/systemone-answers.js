import { WorkflowValueError } from "./errors.js";
export const SYSTEMONE_ROUNDING_TOLERANCE = 0.00001;
const probability = () => ({ type: 'number', minimum: 0, maximum: 1 });
export function systemOneAnswerSchema(question) {
    const type = { type: 'string', enum: [question.type] };
    if (question.type === 'noul')
        return { type: 'object', additionalProperties: false, required: ['type', 'noul'], properties: { type, noul: probability() } };
    const labels = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_value, i) => String(i));
    const probabilities = { type: 'object', additionalProperties: false, required: [...labels],
        properties: Object.fromEntries(labels.map(key => [key, probability()])) };
    if (question.type === 'choice')
        return { type: 'object', additionalProperties: false, required: ['type', 'choice', 'confidence', 'probabilities'],
            properties: { type, choice: { type: 'string', enum: [...labels] }, confidence: probability(), probabilities } };
    return { type: 'object', additionalProperties: false, required: ['type', 'score', 'confidence', 'legend', 'probabilities'],
        properties: { type, score: { type: 'number', minimum: 0, maximum: question.criteria.length - 1 }, confidence: probability(), probabilities,
            legend: { type: 'object', additionalProperties: false, required: [...labels],
                properties: Object.fromEntries(question.criteria.map((value, i) => [String(i), { type: 'string', enum: [value] }])) } } };
}
function sameKeys(left, right) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key));
}
/** Shape/range validation precedes this semantic check. No renormalization or derived confidence. */
export function assertSystemOneAnswers(questions, answers) {
    const invalid = () => { throw new WorkflowValueError('Native Decision answers do not match the reviewed questions.'); };
    if (!sameKeys(questions, answers))
        invalid();
    for (const [id, question] of Object.entries(questions)) {
        const result = answers[id];
        if (question.type !== result.type)
            invalid();
        if (result.type === 'noul')
            continue;
        const values = Object.values(result.probabilities), mass = values.reduce((sum, value) => sum + value, 0);
        if (Math.abs(mass - 1) > SYSTEMONE_ROUNDING_TOLERANCE)
            invalid();
        if (result.type === 'choice' && question.type === 'choice') {
            if (!sameKeys(result.probabilities, question.criteria) || !Object.hasOwn(result.probabilities, result.choice)
                || values.some(value => value > result.probabilities[result.choice]))
                invalid();
        }
        else if (result.type === 'score' && question.type === 'score') {
            const legend = Object.fromEntries(question.criteria.map((value, index) => [String(index), value]));
            if (!sameKeys(result.probabilities, legend) || !sameKeys(result.legend, legend)
                || Object.keys(legend).some(key => result.legend[key] !== legend[key]))
                invalid();
            const expected = question.criteria.reduce((sum, _value, index) => sum + index * result.probabilities[String(index)], 0);
            if (result.score > question.criteria.length - 1
                || Math.abs(result.score - expected) > SYSTEMONE_ROUNDING_TOLERANCE * question.criteria.length)
                invalid();
        }
    }
}
