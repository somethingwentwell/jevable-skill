/** Power Automate cloud flow definitions (package `definition.json`, solution flow JSON or a bare definition) to a Jevable draft. */
import { DraftBuilder, workflowId } from "./import-draft.js";
import { VendorSteps, aiStep, blocked } from "./vendor-steps.js";
/** Workflow Definition Language schema versions this converter understands. */
export const POWER_AUTOMATE_SCHEMA_VERSIONS = ['2016-06-01'];
/** Key under which the trigger is remembered for reference resolution; action names cannot contain `@`. */
const TRIGGER = '@trigger';
const schemaPattern = /\/schemas\/(\d{4}-\d{2}-\d{2})\/workflowdefinition\.json#?$/u;
const operators = {
    equals: '==', greater: '>', greaterOrEquals: '>=', less: '<', lessOrEquals: '<='
};
const aiConnectors = [[/openai/iu, 'openai'], [/aibuilder/iu, 'azure-openai']];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const actionsOf = (value) => object(value) && Object.values(value).every(object);
/**
 * Find the workflow definition in a parsed Power Automate export.
 * @param value - Parsed file content.
 * @returns the definition and flow name, or undefined when the value is not a Power Automate flow.
 */
export function powerAutomateFlow(value) {
    if (!object(value))
        return undefined;
    const properties = object(value.properties) ? value.properties : undefined;
    const definition = [properties?.definition, value.definition, value].find(candidate => object(candidate)
        && typeof candidate.$schema === 'string' && /workflowdefinition\.json/u.test(candidate.$schema)
        && actionsOf(candidate.triggers) && actionsOf(candidate.actions));
    if (!definition)
        return undefined;
    const title = [properties?.displayName, value.displayName].find(name => typeof name === 'string' && name.trim() !== '');
    return { definition, ...title === undefined ? {} : { title: title.trim() } };
}
/**
 * The definition schema version.
 * @param flow - Detected flow.
 * @returns the version when this converter supports it, otherwise undefined.
 */
export function powerAutomateVersion(flow) {
    const [, version] = schemaPattern.exec(flow.definition.$schema) ?? [];
    return version !== undefined && POWER_AUTOMATE_SCHEMA_VERSIONS.includes(version) ? version : undefined;
}
/**
 * Parse one Workflow Definition Language reference: a trigger field (`triggerBody()?['a']?['b']`,
 * `triggerOutputs()?['body/a']`) or an earlier action's result (`body('Name')`, `outputs('Name')`).
 * @param body - Expression text without the leading `@` or the `@{…}` braces.
 * @returns the referenced step and field path, or undefined for any other expression.
 */
function reference(body) {
    const match = /^(?:(triggerBody|triggerOutputs)\(\)|(?:body|outputs)\('([^']+)'\))((?:\??\['[^']*'\])*)$/u.exec(body);
    if (!match)
        return undefined;
    const [, trigger, action, access = ''] = match;
    const path = [...access.matchAll(/\['([^']*)'\]/gu)].flatMap(([, part = '']) => part.split('/'));
    if (action !== undefined)
        return { step: action, path };
    if (trigger === 'triggerOutputs')
        return path[0] === 'body' ? { step: TRIGGER, path: path.slice(1) } : undefined;
    return { step: TRIGGER, path };
}
/**
 * Convert a Power Automate flow. The trigger becomes a Start (exact only for a manual button); If becomes an If/Else Rule and
 * Switch a switch Rule when they compare one trigger field with constants; Scope contents are inlined; AI connector actions
 * become LLM steps; a Compose or Response that ends a path becomes an Output. Parallel branches keep their first path,
 * failure-only paths are dropped, and everything else becomes a placeholder that keeps the draft from running.
 * @param flow - Detected flow with a supported schema version.
 * @param version - Supported schema version.
 * @returns the draft and its mapping report.
 */
export function convertPowerAutomate(flow, version) {
    const draft = new DraftBuilder(), title = flow.title ?? 'Imported Power Automate flow';
    const steps = new VendorSteps(draft, reference, /@\{([^{}]*)\}/gu);
    const label = (name) => name.replace(/_/gu, ' ');
    const add = (name, action, converted) => draft.add(name, label(name), action.type ?? 'unknown', converted.node, converted.kind, converted.reason);
    const connect = (tails, id) => { for (const tail of tails)
        draft.connect(tail.from, id, tail.port); };
    /** Report every action of a scope that is not converted. */
    const skip = (actions, reason) => {
        for (const [name, action] of Object.entries(actions ?? {})) {
            draft.note(label(name), action.type ?? 'unknown', 'unsupported', reason);
            for (const nested of [action.actions, action.else?.actions, ...Object.values(action.cases ?? {}).map(item => item.actions),
                action.default?.actions])
                skip(nested, reason);
        }
    };
    /** A whole-value expression (`@expr`) or a text template with `@{expr}` interpolations, as Jevable text. */
    const text = (value) => {
        // Structured inputs are kept as JSON text; expressions inside them are not translated.
        if (typeof value !== 'string') {
            const json = value === undefined ? '' : JSON.stringify(value);
            return { text: json, exact: value !== undefined && !json.includes('@') };
        }
        if (value.startsWith('@@'))
            return { text: value.slice(1), exact: true };
        if (!value.startsWith('@') || value.startsWith('@{'))
            return steps.template(value);
        const binding = steps.binding(resolve(value));
        return binding === undefined ? { text: value, exact: false } : { text: binding, exact: true };
    };
    const resolve = (value) => typeof value === 'string' && value.startsWith('@') && !value.startsWith('@{') ? steps.resolve(value.slice(1)) : { kind: 'none' };
    /** One comparison, optionally wrapped in a single-item `and`/`or` or negated with `not`. */
    const condition = (expression) => {
        if (!object(expression))
            return undefined;
        const [[name, operands] = [], ...others] = Object.entries(expression);
        if (others.length || name === undefined)
            return undefined;
        if ((name === 'and' || name === 'or') && Array.isArray(operands) && operands.length === 1)
            return condition(operands[0]);
        if (name === 'not' && object(operands) && Array.isArray(operands.equals))
            return comparison('!=', operands.equals);
        const operator = operators[name];
        return operator && Array.isArray(operands) ? comparison(operator, operands) : undefined;
    };
    const comparison = (operator, [left, right, ...more]) => more.length || (right !== null && typeof right === 'object') || (typeof right === 'string' && right.startsWith('@'))
        ? undefined : steps.compare(resolve(left), operator, right);
    /** A switch over one trigger field with constant cases, or undefined when Jevable cannot express it. */
    const switchConfig = (action) => {
        const value = resolve(action.expression);
        const cases = Object.values(action.cases ?? {}).map((item, index) => ({ port: `case${String(index + 1)}`, value: item.case }));
        if (value.kind !== 'input' || !cases.length || cases.some(item => item.value === undefined || (item.value !== null && typeof item.value === 'object')
            || (typeof item.value === 'string' && item.value.startsWith('@'))))
            return undefined;
        return { mode: 'switch', value: steps.binding(value), cases };
    };
    /** Convert one action that has no nested scope. */
    const convert = (action, terminal) => {
        const inputs = object(action.inputs) ? action.inputs : {};
        if ((action.type === 'Compose' || action.type === 'Response') && terminal) {
            const value = text(action.type === 'Compose' ? action.inputs : inputs.body);
            // A Response also sets an HTTP status and headers, which a Jevable Output does not carry.
            return { node: { type: 'output', config: { value: value.text } }, kind: value.exact && action.type === 'Compose' ? 'exact' : 'approximate',
                reason: value.exact ? 'mapped' : 'expression' };
        }
        const host = object(inputs.host) ? inputs.host : {};
        const connector = [host.apiId, host.connectionName, host.operationId].filter(item => typeof item === 'string').join(' ');
        const provider = /OpenApiConnection|ApiConnection/u.test(action.type ?? '') ? aiConnectors.find(([pattern]) => pattern.test(connector))?.[1] : undefined;
        if (provider) {
            const parameters = object(inputs.parameters) ? inputs.parameters : {};
            const prompt = Object.entries(parameters).find(([key, item]) => /(?:^|\/)(?:prompt|text|content)$/iu.test(key) && typeof item === 'string')?.[1];
            const model = Object.entries(parameters).find(([key]) => /(?:^|\/)(?:model|deploymentId|deployment-id)$/iu.test(key))?.[1];
            return aiStep(text(typeof prompt === 'string' ? prompt : ''), model, provider);
        }
        return blocked(action.type === 'JavaScriptCode' ? 'code' : 'node-type');
    };
    /**
     * Convert one scope in `runAfter` order, connecting each action after the paths of the actions it runs after.
     * @param actions - Actions of the scope.
     * @param entry - Continuations the scope's first actions connect from.
     * @param last - Whether nothing runs after the scope, so its final actions end the flow.
     * @returns the continuations left open when the scope ends.
     */
    const walk = (actions, entry, last) => {
        // An empty branch continues straight to whatever follows it.
        if (!Object.keys(actions).length)
            return [...entry];
        const ends = new Map(), pending = new Map(Object.entries(actions));
        const succeeds = (statuses) => !Array.isArray(statuses) || statuses.includes('Succeeded');
        const followed = new Set(Object.values(actions).flatMap(action => Object.entries(action.runAfter ?? {})
            .filter(([, statuses]) => succeeds(statuses)).map(([previous]) => previous)));
        let progressed = true;
        while (pending.size && progressed) {
            progressed = false;
            for (const [name, action] of pending) {
                const after = Object.entries(action.runAfter ?? {})
                    .map(([previous, statuses]) => ({ tails: ends.get(previous), succeeded: succeeds(statuses) }));
                const ready = after.filter((item) => item.tails !== undefined);
                if (ready.length !== after.length)
                    continue;
                pending.delete(name);
                progressed = true;
                // Actions that run only after a failure, skip or timeout are error handling, which Jevable paths do not express.
                const succeeded = ready.filter(item => item.succeeded);
                if (ready.length && !succeeded.length) {
                    skip({ [name]: action }, 'unreachable');
                    ends.set(name, []);
                    continue;
                }
                ends.set(name, visit(name, action, ready.length ? succeeded.flatMap(item => item.tails) : entry, last && !followed.has(name)));
            }
        }
        // A `runAfter` naming an action outside this scope, or a cycle, leaves actions that never become ready.
        skip(Object.fromEntries(pending), 'unreachable');
        return Object.keys(actions).filter(name => !followed.has(name)).flatMap(name => ends.get(name) ?? []);
    };
    const visit = (name, action, incoming, terminal) => {
        if (action.type === 'Scope') {
            draft.note(label(name), 'Scope', 'exact', 'mapped');
            return walk(action.actions ?? {}, incoming, terminal);
        }
        if (action.type === 'If') {
            const converted = condition(action.expression);
            const id = add(name, action, converted ? { node: { type: 'rule', config: { mode: 'ifElse', condition: converted } }, kind: 'exact', reason: 'mapped' }
                : blocked('operator'));
            connect(incoming, id);
            return [...walk(action.actions ?? {}, [{ from: id, ...converted ? { port: 'true' } : {} }], terminal),
                ...walk(action.else?.actions ?? {}, [{ from: id, ...converted ? { port: 'false' } : {} }], terminal)];
        }
        if (action.type === 'Switch') {
            const config = switchConfig(action);
            const id = add(name, action, config ? { node: { type: 'rule', config }, kind: 'exact', reason: 'mapped' } : blocked('operator'));
            connect(incoming, id);
            return [...Object.values(action.cases ?? {}).flatMap((item, index) => walk(item.actions ?? {}, [{ from: id, ...config ? { port: `case${String(index + 1)}` } : {} }], terminal)),
                ...walk(action.default?.actions ?? {}, [{ from: id, ...config ? { port: 'default' } : {} }], terminal)];
        }
        if (action.type === 'Foreach' || action.type === 'Until') {
            const id = add(name, action, blocked('loop'));
            skip(action.actions, 'loop');
            connect(incoming, id);
            return [{ from: id }];
        }
        const converted = convert(action, terminal);
        const id = add(name, action, converted);
        steps.remember(name, id, converted.node.type === 'llm' ? 'ai' : 'other');
        connect(incoming, id);
        return [{ from: id }];
    };
    const [[triggerName, trigger] = [], ...extra] = Object.entries(flow.definition.triggers);
    let entry = [];
    if (triggerName !== undefined && trigger !== undefined) {
        // Only a manual button starts a flow the way a Jevable manual Start does; HTTP, schedule and connector triggers do not.
        const button = trigger.type === 'Request' && trigger.kind === 'Button';
        const id = draft.add(TRIGGER, label(triggerName), trigger.kind ? `${trigger.type ?? 'unknown'}/${trigger.kind}` : trigger.type ?? 'unknown', { type: 'trigger', config: { modes: ['manual'] } }, button ? 'exact' : 'approximate', button ? 'mapped' : 'trigger-mode');
        steps.remember(TRIGGER, id, 'trigger');
        entry = [{ from: id }];
    }
    for (const [name, other] of extra)
        draft.note(label(name), other.type ?? 'unknown', 'unsupported', 'trigger-mode');
    walk(flow.definition.actions, entry, true);
    const kinds = draft.mappings.map(item => item.kind);
    const fidelity = kinds.includes('unsupported') ? 'unsupported' : kinds.includes('approximate') ? 'approximate' : 'exact';
    const document = draft.document(draft.inferredInputSchema(), { id: workflowId(title), name: title }, { format: 'power-automate', version, fidelity });
    return { format: 'power-automate', version, title, document, mappings: draft.mappings };
}
