/** Acorn parses syntax; only the explicit instruction whitelist below can reach evaluation. */
import { parseExpressionAt } from 'acorn';
import { assertNever, deepFreeze } from "../shared/values.js";
/** Safe expression failure; never contains authored expressions or runtime values. */
export class WorkflowExpressionError extends Error {
    name = 'WorkflowExpressionError';
}
const booleanType = Object.freeze({ kind: 'boolean' });
const numberType = Object.freeze({ kind: 'number' });
const reserved = new Set(['__proto__', 'constructor', 'prototype']);
function fail(message) {
    throw new WorkflowExpressionError(message);
}
function referencePath(node, depth, maxDepth) {
    if (depth > maxDepth)
        fail('Expression exceeds the configured nesting budget.');
    if (node.type === 'Identifier')
        return [node.name];
    if (node.type !== 'MemberExpression' || node.optional || node.object.type === 'Super') {
        return fail('References require a declared root and static property names or array indices.');
    }
    const property = node.property;
    let key;
    if (!node.computed && property.type === 'Identifier')
        key = property.name;
    else if (node.computed && property.type === 'Literal'
        && (typeof property.value === 'string' || (typeof property.value === 'number' && Number.isSafeInteger(property.value) && property.value >= 0))) {
        key = property.value;
    }
    else
        return fail('Computed references require a literal property name or nonnegative integer.');
    if (typeof key === 'string' && reserved.has(key))
        fail('Expression references a reserved property.');
    return [...referencePath(node.object, depth + 1, maxDepth), key];
}
function referenceType(path, environment) {
    const root = {
        kind: 'object', required: ['inputs', 'nodes', ...(environment.loop ? ['loop'] : [])], properties: {
            inputs: environment.inputs,
            nodes: { kind: 'object', required: Object.keys(environment.nodes), properties: Object.fromEntries(Object.entries(environment.nodes)
                    .map(([id, output]) => [id, { kind: 'object', required: ['output'], properties: { output } }])) },
            ...(environment.loop ? { loop: { kind: 'object', required: ['item', 'index'],
                    properties: { item: environment.loop.item, index: numberType } } } : {}),
        },
    };
    if (path[0] !== 'inputs' && path[0] !== 'nodes' && path[0] !== 'loop')
        fail('Expression references an undeclared root.');
    if ((path[0] === 'nodes' && (path.length < 3 || path[2] !== 'output')) || (path[0] === 'loop' && path.length < 2)) {
        fail('Node references require an output; loop references require an item or index.');
    }
    let type = root;
    for (const key of path) {
        const property = type.kind === 'object' && typeof key === 'string' && Object.hasOwn(type.properties, key)
            ? type.properties[key] : undefined;
        if (property)
            type = property;
        else if (type.kind === 'array' && typeof key === 'number')
            type = type.items;
        else
            return fail('Expression references a missing, unavailable or incorrectly indexed value.');
    }
    return type;
}
/**
 * Compile one expression with literals, typed references, comparisons, boolean operators and exists(reference).
 * Equality is scalar and strict, including when authored with == or !=; no coercion, method calls or JS evaluation occurs.
 * @param source - expression text, without template delimiters.
 * @param environment - trusted schema types, exposing only guaranteed upstream node outputs and the current loop scope.
 * @param limits - explicit byte, instruction, nesting and result budgets; depth cannot exceed 128.
 * @returns a detached frozen instruction tree and the references that need runtime values.
 * @throws WorkflowExpressionError for unsupported syntax, unavailable references, type errors or exceeded budgets.
 */
export function compileExpression(source, environment, limits) {
    if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1) || limits.maxDepth > 128) {
        fail('Expression budgets must be positive safe integers; maxDepth cannot exceed 128.');
    }
    if (Buffer.byteLength(source, 'utf8') > limits.maxSourceBytes)
        fail('Expression exceeds the configured source byte budget.');
    let parsed;
    try {
        parsed = parseExpressionAt(source, 0, { ecmaVersion: 2022, preserveParens: true,
            onComment: () => { throw new Error('Comments are not expressions'); } });
        if (source.slice(parsed.end).trim())
            throw new Error('Trailing input');
    }
    catch (_error) {
        return fail('Expression must contain exactly one valid expression without comments.');
    }
    const references = [];
    let count = 0;
    const compile = (node, depth) => {
        if (++count > limits.maxNodes || depth > limits.maxDepth)
            fail('Expression exceeds the configured instruction or nesting budget.');
        switch (node.type) {
            case 'ParenthesizedExpression': return compile(node.expression, depth + 1);
            case 'Literal': {
                const value = node.value;
                if (value === null)
                    return { instruction: { kind: 'literal', value }, type: { kind: 'null' } };
                if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
                    return { instruction: { kind: 'literal', value }, type: { kind: typeof value } };
                }
                return fail('Expression literals must be finite JSON scalars.');
            }
            case 'Identifier':
            case 'MemberExpression': {
                const path = referencePath(node, depth, limits.maxDepth);
                count += path.length - 1;
                if (count > limits.maxNodes)
                    fail('Expression exceeds the configured instruction budget.');
                const type = referenceType(path, environment);
                references.push(path);
                return { instruction: { kind: 'reference', path, valueType: type }, type };
            }
            case 'CallExpression': {
                const argument = node.arguments[0];
                if (!argument || node.optional || node.callee.type !== 'Identifier' || node.callee.name !== 'exists' || node.arguments.length !== 1) {
                    return fail('Only exists(reference) is an allowed expression function.');
                }
                if (argument.type !== 'MemberExpression' && argument.type !== 'Identifier')
                    return fail('exists requires a reference.');
                const reference = compile(argument, depth + 1).instruction;
                // The two admitted AST kinds above always compile to a reference.
                return { instruction: { kind: 'exists', reference: reference }, type: booleanType };
            }
            case 'UnaryExpression': {
                if (node.operator !== '!' && node.operator !== '-')
                    return fail('Only boolean negation and numeric minus are allowed unary operators.');
                const operand = compile(node.argument, depth + 1);
                const expected = node.operator === '!' ? 'boolean' : 'number';
                if (operand.type.kind !== expected)
                    fail('Unary expression has an incompatible operand type.');
                return { instruction: { kind: node.operator === '!' ? 'not' : 'negative', operand: operand.instruction }, type: operand.type };
            }
            case 'LogicalExpression':
            case 'BinaryExpression': {
                const operator = node.operator === '===' ? '==' : node.operator === '!==' ? '!=' : node.operator;
                if (!['==', '!=', '>', '>=', '<', '<=', '&&', '||'].includes(operator))
                    return fail('Expression operator is not supported.');
                const left = compile(node.left, depth + 1), right = compile(node.right, depth + 1);
                const kind = left.type.kind;
                if (kind !== right.type.kind || kind === 'object' || kind === 'array')
                    fail('Expression operands must have matching scalar types.');
                if ((operator === '&&' || operator === '||') && kind !== 'boolean')
                    fail('Boolean operators require boolean operands.');
                if (['>', '>=', '<', '<='].includes(operator) && kind !== 'number')
                    fail('Ordered comparisons require numeric operands.');
                return { instruction: { kind: 'binary', operator: operator,
                        left: left.instruction, right: right.instruction }, type: booleanType };
            }
            default: return fail('Expression syntax is not supported; calls, mutation and executable JavaScript are forbidden.');
        }
    };
    const result = compile(parsed, 0);
    // Environment schema objects remain caller-owned; freeze only detached compiler values.
    return deepFreeze(structuredClone({
        instruction: result.instruction, resultType: result.type, references, maxResultBytes: limits.maxResultBytes,
    }));
}
function readReference(reference, values) {
    let value = values;
    for (const key of reference.path) {
        if (value === null || typeof value !== 'object')
            return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor)
            return undefined;
        if (!Object.hasOwn(descriptor, 'value'))
            fail('Expression values must be data, not accessors.');
        value = descriptor.value;
    }
    const kind = reference.valueType.kind;
    const matches = kind === 'null' ? value === null
        : kind === 'array' ? Array.isArray(value)
            : kind === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
                : typeof value === kind && (kind !== 'number' || Number.isFinite(value));
    if (!matches)
        fail('Expression value does not match its declared type.');
    return value;
}
/**
 * Evaluate admitted instructions against schema-validated run values, without executing JavaScript.
 * Boolean operators short-circuit; only exists may consume a missing reference. Results are detached and frozen.
 * @param expression - in-process compiled expression; durable or remote data must first be recompiled.
 * @param values - current inputs, completed outputs and optional iteration-local data.
 * @returns a bounded JSON value; errors never expose input data.
 * @throws WorkflowExpressionError for absent/wrongly typed values or oversized results.
 */
export function evaluateExpression(expression, values) {
    const evaluate = (instruction) => {
        switch (instruction.kind) {
            case 'literal': return instruction.value;
            case 'reference': {
                const value = readReference(instruction, values);
                if (value === undefined)
                    fail('Expression requires a missing input or node output.');
                return value;
            }
            case 'exists': return readReference(instruction.reference, values) !== undefined;
            case 'not': return !evaluate(instruction.operand);
            case 'negative': return -evaluate(instruction.operand);
            case 'binary': {
                const left = evaluate(instruction.left);
                if (instruction.operator === '&&')
                    return left === true && evaluate(instruction.right) === true;
                if (instruction.operator === '||')
                    return left === true || evaluate(instruction.right) === true;
                const right = evaluate(instruction.right);
                switch (instruction.operator) {
                    case '==': return left === right;
                    case '!=': return left !== right;
                    case '>': return left > right;
                    case '>=': return left >= right;
                    case '<': return left < right;
                    case '<=': return left <= right;
                    /* v8 ignore next -- compiled instructions contain only the closed operator union. */
                    default: return assertNever(instruction.operator);
                }
            }
            /* v8 ignore next -- only in-process compiler output enters this evaluator. */
            default: return assertNever(instruction);
        }
    };
    const result = evaluate(expression.instruction);
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > expression.maxResultBytes)
        fail('Expression exceeds the configured result byte budget.');
    return deepFreeze(structuredClone(result));
}
