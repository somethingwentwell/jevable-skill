/** Compile JSON/template bindings and evaluate them as bounded values, never executable code. */
import { assertNever, deepEqualJson, deepFreeze } from "../shared/values.js";
import { compileExpression, evaluateExpression } from "./expressions.js";
import { admitWorkflowData } from "./value-schema.js";
import { WorkflowCompileError, WorkflowValueError } from "./errors.js";
function expressionEnd(text, start) {
    let quote = '';
    for (let i = start; i < text.length; i++) {
        const char = text[i];
        if (quote) {
            if (char === '\\')
                i++;
            else if (char === quote)
                quote = '';
        }
        else if (char === '"' || char === "'")
            quote = char;
        else if (char === '}' && text[i + 1] === '}')
            return i;
    }
    throw new WorkflowCompileError('Template expression is missing its closing delimiter.');
}
/**
 * Compile JSON with whole-value expressions and scalar-only text interpolation.
 * @param value - unknown JSON binding; `${{ expression }}` preserves its typed value when it occupies the complete string.
 * @param environment - trusted types exposing only values available at this graph position.
 * @param limits - whole binding/data limits and per-expression budgets.
 * @returns detached immutable binding instructions and their structural result type.
 * @throws WorkflowCompileError for malformed interpolation or heterogeneous inline arrays, without exposing authored values.
 */
export function compileBinding(value, environment, limits) {
    if (!Number.isSafeInteger(limits.maxExpressions) || limits.maxExpressions < 1) {
        throw new WorkflowCompileError('Binding expression budget must be a positive safe integer.');
    }
    const admitted = admitWorkflowData(value, limits.data);
    let expressions = 0;
    const compile = (item) => {
        if (typeof item === 'string') {
            const parts = [];
            let offset = 0;
            for (let start = item.indexOf('${{', offset); start >= 0; start = item.indexOf('${{', offset)) {
                if (++expressions > limits.maxExpressions)
                    throw new WorkflowCompileError('Binding exceeds its expression count budget.');
                if (start > offset)
                    parts.push(item.slice(offset, start));
                const end = expressionEnd(item, start + 3);
                parts.push(compileExpression(item.slice(start + 3, end), environment, limits.expression));
                offset = end + 2;
            }
            if (parts.length === 0)
                return { instruction: { kind: 'literal', value: item }, resultType: { kind: 'string' } };
            if (offset < item.length)
                parts.push(item.slice(offset));
            const first = parts[0];
            if (parts.length === 1 && typeof first === 'object') {
                return { instruction: { kind: 'expression', expression: first }, resultType: first.resultType };
            }
            for (const part of parts) {
                if (typeof part !== 'string' && (part.resultType.kind === 'object' || part.resultType.kind === 'array')) {
                    throw new WorkflowCompileError('Text interpolation requires scalar expressions; map objects as whole values.');
                }
            }
            return { instruction: { kind: 'text', parts }, resultType: { kind: 'string' } };
        }
        if (Array.isArray(item)) {
            const entries = item.map(compile);
            const itemType = entries[0]?.resultType ?? { kind: 'null' };
            if (entries.some(entry => !deepEqualJson(entry.resultType, itemType))) {
                throw new WorkflowCompileError('Inline binding arrays require one structural item type; use a typed array reference.');
            }
            return { instruction: { kind: 'array', entries: entries.map(entry => entry.instruction) },
                resultType: { kind: 'array', items: itemType, empty: entries.length === 0 } };
        }
        if (item !== null && typeof item === 'object') {
            const entries = Object.entries(item).map(([key, child]) => [key, compile(child)]);
            return { instruction: { kind: 'object', entries: entries.map(([key, child]) => [key, child.instruction]) },
                resultType: { kind: 'object', required: entries.map(([key]) => key).sort(),
                    properties: Object.fromEntries(entries.map(([key, child]) => [key, child.resultType])) } };
        }
        return { instruction: { kind: 'literal', value: item },
            resultType: { kind: item === null ? 'null' : typeof item } };
    };
    return deepFreeze({ ...compile(admitted), limits: { ...limits.data } });
}
/**
 * Evaluate a compiled binding while budgeting the complete JSON encoding, including keys and containers.
 * @param binding - local compiled instructions, never unvalidated file or wire data.
 * @param values - schema-validated current run values.
 * @returns a detached frozen JSON value; no context value can be mutated through the result.
 * @throws WorkflowValueError for whole-result budget exhaustion; expression failures retain safe diagnostics.
 */
export function evaluateBinding(binding, values) {
    let bytes = 0;
    const charge = (count) => {
        bytes += count;
        if (bytes > binding.limits.maxBytes)
            throw new WorkflowValueError('Binding result exceeds its complete byte budget.');
    };
    const evaluate = (instruction) => {
        switch (instruction.kind) {
            case 'literal':
                charge(Buffer.byteLength(JSON.stringify(instruction.value)));
                return instruction.value;
            case 'expression': {
                const result = evaluateExpression(instruction.expression, values);
                charge(Buffer.byteLength(JSON.stringify(result)));
                return result;
            }
            case 'text': {
                const chunks = [];
                let textBytes = 0;
                for (const part of instruction.parts) {
                    // Compilation restricts interpolated expressions to these scalar result types.
                    const scalar = typeof part === 'string' ? part : evaluateExpression(part, values);
                    const chunk = String(scalar);
                    textBytes += Buffer.byteLength(chunk);
                    if (textBytes > binding.limits.maxBytes)
                        throw new WorkflowValueError('Interpolated text exceeds its byte budget.');
                    chunks.push(chunk);
                }
                const result = chunks.join('');
                charge(Buffer.byteLength(JSON.stringify(result)));
                return result;
            }
            case 'array':
                charge(2 + Math.max(0, instruction.entries.length - 1));
                return instruction.entries.map(evaluate);
            case 'object': {
                charge(2 + Math.max(0, instruction.entries.length - 1));
                return Object.fromEntries(instruction.entries.map(([key, child]) => {
                    charge(Buffer.byteLength(JSON.stringify(key)) + 1);
                    return [key, evaluate(child)];
                }));
            }
            /* v8 ignore next -- compileBinding emits only the closed instruction union. */
            default: return assertNever(instruction);
        }
    };
    return admitWorkflowData(evaluate(binding.instruction), binding.limits);
}
