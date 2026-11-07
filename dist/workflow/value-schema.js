/** Bounded JSON Schema admission and Ajv validation without coercion, defaults, regexes or remote references. */
import { Ajv } from 'ajv';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { deepFreeze } from "../shared/values.js";
import { assertJsonTree } from "./json-data.js";
import { WorkflowCompileError, WorkflowValueError } from "./errors.js";
const natural = z.number().int().nonnegative();
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const common = { description: z.string().optional() };
const scalarFields = { ...common, enum: z.array(scalar).min(1).optional() };
const schema = z.lazy(() => z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('object'), ...common, properties: z.record(z.string(), schema).optional(),
        required: z.array(z.string()).optional(), additionalProperties: z.boolean().optional() }),
    z.strictObject({ type: z.literal('array'), ...common, items: schema, minItems: natural.optional(), maxItems: natural.optional() }),
    z.strictObject({ type: z.literal('string'), ...scalarFields, minLength: natural.optional(), maxLength: natural.optional() }),
    z.strictObject({ type: z.enum(['number', 'integer']), ...scalarFields, minimum: z.number().optional(),
        maximum: z.number().optional() }),
    z.strictObject({ type: z.enum(['boolean', 'null']), ...scalarFields }),
]));
const validators = new WeakMap();
// Repeated journal checks still admit and validate each schema under the caller's
// current budgets. Reuse only immutable receipts; weak references do not extend
// their payload/validator lifetime, and bounded digest keys contain no schema text.
const receipts = new Map();
const RECEIPT_CACHE_LIMIT = 128;
const ajv = new Ajv({ strict: true, allErrors: false, ownProperties: true, validateFormats: false,
    coerceTypes: false, useDefaults: false, removeAdditional: false, addUsedSchema: false, logger: false });
/**
 * Validate JSON resource limits and return a detached immutable value.
 * @param value - unknown deserialized data; not a hostile in-process Proxy.
 * @param limits - positive byte, value and nesting budgets, with depth at most 128.
 * @returns a frozen JSON copy, without silently dropping unsupported values.
 * @throws WorkflowValueError for invalid budgets, non-JSON data or exceeded limits, without exposing the value.
 */
export function admitWorkflowData(value, limits) {
    if (Object.values(limits).some(limit => !Number.isSafeInteger(limit) || limit < 1) || limits.maxDepth > 128) {
        throw new WorkflowValueError('Data budgets must be positive safe integers; maxDepth cannot exceed 128.');
    }
    try {
        assertJsonTree(value, limits);
    }
    catch (_error) {
        throw new WorkflowValueError('Workflow data must be a bounded JSON tree without reserved properties.');
    }
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json, 'utf8') > limits.maxBytes)
        throw new WorkflowValueError('Workflow data exceeds its byte budget.');
    return deepFreeze(JSON.parse(json));
}
function projectType(definition) {
    if (definition.type === 'object') {
        return { kind: 'object', required: [...definition.required ?? []].sort(), properties: Object.fromEntries(Object.entries(definition.properties ?? {})
                .map(([key, child]) => [key, projectType(child)])) };
    }
    if (definition.type === 'array') {
        // The schema validator requires items; this assertion does not admit external data.
        return { kind: 'array', items: projectType(definition.items) };
    }
    return { kind: definition.type === 'integer' ? 'number' : definition.type };
}
/**
 * Compile the supported finite JSON Schema subset and project its declared properties into expression types.
 * Unknown keywords, external/local refs, regexes, formats, schema unions and executable annotations are rejected.
 * @param value - unknown schema data from workflow source.
 * @param limits - schema byte, depth and value budgets.
 * @returns a detached frozen schema and type receipt usable by validateWorkflowValue in this process.
 * @throws WorkflowCompileError for unsupported or inconsistent schemas, without source snippets.
 * @throws WorkflowValueError for invalid JSON data or schema resource budgets.
 */
export function compileValueSchema(value, limits) {
    const admitted = admitWorkflowData(value, limits);
    const parsed = schema.safeParse(admitted);
    if (!parsed.success)
        throw new WorkflowCompileError('Schema must use the supported typed JSON Schema subset.');
    const key = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
    const cached = receipts.get(key)?.deref();
    if (cached) {
        receipts.delete(key);
        receipts.set(key, new WeakRef(cached));
        return cached;
    }
    let validate;
    try {
        validate = ajv.compile(parsed.data);
    }
    catch (_error) {
        throw new WorkflowCompileError('Schema contains invalid or inconsistent constraints.');
    }
    finally {
        // The caller's receipt owns validator lifetime; the shared Ajv instance must not retain every revision.
        ajv.removeSchema(parsed.data);
    }
    const compiled = deepFreeze({ definition: parsed.data, valueType: projectType(parsed.data) });
    validators.set(compiled, validate);
    receipts.delete(key);
    receipts.set(key, new WeakRef(compiled));
    if (receipts.size > RECEIPT_CACHE_LIMIT)
        receipts.delete(receipts.keys().next().value);
    return compiled;
}
/**
 * Validate and snapshot a node input/output with no type coercion or added defaults.
 * @param compiled - schema receipt from compileValueSchema in this process, not deserialized compiled data.
 * @param value - untrusted provider, ingress or persisted JSON data.
 * @param limits - budgets for the complete retained value.
 * @returns a frozen detached value satisfying the complete supported schema.
 * @throws WorkflowValueError for invalid data or an unrecognized receipt; values are never included in diagnostics.
 */
export function validateWorkflowValue(compiled, value, limits) {
    const validate = validators.get(compiled);
    if (!validate)
        throw new WorkflowValueError('Schema receipt is not local; compile its definition before validation.');
    const admitted = admitWorkflowData(value, limits);
    if (!validate(admitted))
        throw new WorkflowValueError('Workflow value does not satisfy its declared schema.');
    return admitted;
}
