import { assertNever, deepFreeze } from "../shared/values.js";
import { snapshotWorkflow, parseWorkflow } from "./source.js";
import { schemaIssues } from "./issues.js";
import { WorkflowCompileError } from "./errors.js";
import { compileBinding, evaluateBinding } from "./bindings.js";
import { compileValueSchema } from "./value-schema.js";
import { triggerConfig, llmConfig, decisionConfig, ruleConfig, outputConfig, approvalConfig, loopConfig, customConfig } from "./node-config.js";
import { compileDecisionOutput } from "./decision.js";
function config(schema, value) {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
        throw new WorkflowCompileError(`Node configuration is missing required settings or contains unsupported fields: ${schemaIssues(parsed.error.issues)}`);
    }
    return parsed.data;
}
/** Name the step a compile error belongs to, so an author (or the workflow assistant) knows where to look. */
function inStep(id, compile) {
    try {
        return compile();
    }
    catch (error) {
        if (error instanceof WorkflowCompileError)
            throw new WorkflowCompileError(`Step ${id}: ${error.message}`);
        throw error;
    }
}
function requireType(binding, kind) {
    if (binding.resultType.kind !== kind)
        throw new WorkflowCompileError(`Binding must produce a ${kind} value.`);
    return binding;
}
/** Structural compatibility is static; numeric/string bounds still require runtime value validation. */
function requireAssignable(type, schema) {
    const expected = schema.type === 'integer' ? 'number' : schema.type;
    if (type.kind !== expected)
        throw new WorkflowCompileError('Mapped value does not match the declared schema type.');
    if (type.kind === 'object') {
        if ((schema.required ?? []).some(key => !type.required.includes(key))) {
            throw new WorkflowCompileError('Mapped value cannot guarantee a required schema property.');
        }
        for (const [key, child] of Object.entries(type.properties)) {
            const target = schema.properties?.[key];
            if (target)
                requireAssignable(child, target);
            else if (schema.additionalProperties === false)
                throw new WorkflowCompileError('Mapped value contains an undeclared schema property.');
        }
    }
    else if (type.kind === 'array' && !type.empty) {
        requireAssignable(type.items, schema.items);
    }
}
const numberType = { kind: 'number' };
/** Structural type identity, independent of property declaration order. */
function sameType(left, right) {
    if (left.kind !== right.kind)
        return false;
    if (left.kind === 'array' && right.kind === 'array')
        return !left.empty === !right.empty && sameType(left.items, right.items);
    if (left.kind === 'object' && right.kind === 'object') {
        const keys = Object.keys(left.properties);
        return keys.length === Object.keys(right.properties).length && [...left.required].sort().join('\0') === [...right.required].sort().join('\0')
            && keys.every(key => Object.hasOwn(right.properties, key)
                && sameType(left.properties[key], right.properties[key]));
    }
    return true;
}
function compileNode(node, environment, limits, outer) {
    const bind = (value) => compileBinding(value, environment, limits.binding);
    const schema = (value) => compileValueSchema(value, limits.schema);
    switch (node.type) {
        case 'trigger': {
            const settings = config(triggerConfig, node.config);
            // A chat message starts the run as the message text itself, or as `{ message }` when that is the only required property.
            const inputs = environment.inputs;
            const chatInput = inputs.kind === 'string' || (inputs.kind === 'object' && inputs.required.length === 1
                && inputs.required[0] === 'message' && inputs.properties.message?.kind === 'string');
            if (settings.modes.includes('chat') && !chatInput) {
                throw new WorkflowCompileError('A chat trigger needs a string input schema, or an object whose only required property is a string `message`.');
            }
            return { plan: { kind: 'trigger', ...settings }, outputType: environment.inputs, ports: ['next'] };
        }
        case 'llm': {
            const settings = config(llmConfig, node.config);
            if ((settings.input === undefined) !== (settings.inputSchema === undefined)) {
                throw new WorkflowCompileError('LLM input mapping and input schema must be declared together.');
            }
            if (settings.responseFormat === 'json-schema' && settings.outputSchema === undefined) {
                throw new WorkflowCompileError('Structured LLM output requires an output schema.');
            }
            if (settings.historyScope !== 'none' && settings.historyLimits === undefined) {
                throw new WorkflowCompileError('Admitted history requires message and byte limits.');
            }
            if (settings.historyScope === 'none' && settings.historyLimits !== undefined) {
                throw new WorkflowCompileError('History limits are only valid for an admitted history scope.');
            }
            const output = schema(settings.outputSchema ?? { type: 'string' });
            if (settings.responseFormat === 'text' && output.valueType.kind !== 'string') {
                throw new WorkflowCompileError('Plain-text LLM output requires a string schema.');
            }
            const input = settings.input === undefined ? undefined : { binding: bind(settings.input), schema: schema(settings.inputSchema) };
            if (input)
                requireAssignable(input.binding.resultType, input.schema.definition);
            return {
                plan: { kind: 'llm', provider: settings.provider, model: settings.model, connection: settings.connection,
                    prompt: requireType(bind(settings.prompt), 'string'), systemPrompt: requireType(bind(settings.systemPrompt ?? ''), 'string'),
                    input, output, responseFormat: settings.responseFormat, generation: settings.generation, execution: settings.execution,
                    history: settings.historyScope === 'none' ? { scope: 'none' }
                        : { scope: settings.historyScope, ...settings.historyLimits } },
                outputType: output.valueType, ports: ['next'],
            };
        }
        case 'decision': {
            const settings = config(decisionConfig, node.config);
            const output = compileDecisionOutput(settings.questions, limits.schema, settings.answerFormat);
            return { plan: { kind: 'decision', provider: settings.provider, model: settings.model, connection: settings.connection,
                    state: bind(settings.state), questions: settings.questions, output, execution: settings.execution,
                    ...settings.llm ? { llm: settings.llm } : {}, ...settings.answerFormat ? { answerFormat: settings.answerFormat } : {} },
                outputType: output.valueType, ports: ['next'] };
        }
        case 'rule': {
            const settings = config(ruleConfig, node.config);
            const outputType = { kind: 'object', required: ['selectedPort'], properties: { selectedPort: { kind: 'string' } } };
            if (settings.mode === 'ifElse') {
                return { plan: { kind: 'ifElse', condition: requireType(bind(settings.condition), 'boolean') },
                    outputType, ports: ['true', 'false'] };
            }
            const value = bind(settings.value);
            if (value.resultType.kind === 'object' || value.resultType.kind === 'array') {
                throw new WorkflowCompileError('Switch requires a scalar value.');
            }
            for (const entry of settings.cases) {
                const kind = entry.value === null ? 'null' : typeof entry.value;
                if (kind !== value.resultType.kind)
                    throw new WorkflowCompileError('Switch case values must match the selected value type.');
            }
            const ports = settings.cases.map(entry => entry.port);
            if (new Set(ports).size !== ports.length)
                throw new WorkflowCompileError('Switch case ports must be unique.');
            return { plan: { kind: 'switch', value, cases: settings.cases }, outputType, ports: [...ports, 'default'] };
        }
        case 'humanApproval': {
            const settings = config(approvalConfig, node.config);
            const input = { binding: bind(settings.input), schema: schema(settings.inputSchema) };
            requireAssignable(input.binding.resultType, input.schema.definition);
            const ports = settings.actions.filter(action => action !== 'reject' || settings.onReject === 'branch');
            if (settings.onTimeout === 'branch')
                ports.push('timeout');
            return {
                plan: { kind: 'humanApproval', title: requireType(bind(settings.title), 'string'), input,
                    actions: settings.actions, expiresAfterMs: settings.expiresAfter,
                    onReject: settings.onReject, onTimeout: settings.onTimeout },
                outputType: { kind: 'object', required: ['action'], properties: { action: { kind: 'string' } } }, ports,
            };
        }
        case 'output': {
            const settings = config(outputConfig, node.config);
            const value = bind(settings.value);
            const output = settings.outputSchema === undefined ? undefined : schema(settings.outputSchema);
            if (output)
                requireAssignable(value.resultType, output.definition);
            return { plan: { kind: 'output', value, schema: output }, outputType: value.resultType, ports: [] };
        }
        case 'custom': {
            if (Object.hasOwn(node.config, 'mode')) {
                throw new WorkflowCompileError('Imported Custom modes (API, MCP or container) require a reviewed conversion to code first.');
            }
            const settings = config(customConfig, node.config);
            if (!settings.code.trim())
                throw new WorkflowCompileError('Custom code is empty.');
            const input = { binding: bind(settings.input), schema: settings.inputSchema === undefined ? undefined : schema(settings.inputSchema) };
            if (input.schema)
                requireAssignable(input.binding.resultType, input.schema.definition);
            const output = schema(settings.outputSchema);
            return { plan: { kind: 'custom', language: settings.language, code: settings.code, input, output,
                    ...settings.execution ? { execution: settings.execution } : {} }, outputType: output.valueType, ports: ['next'] };
        }
        case 'loop': {
            const settings = config(loopConfig, node.config);
            let item, items, input;
            if (settings.mode === 'forEach') {
                items = bind(settings.items);
                if (items.resultType.kind !== 'array' || items.resultType.empty) {
                    throw new WorkflowCompileError('For Each items must be a typed, non-literal-empty array.');
                }
                item = items.resultType.items;
            }
            else {
                input = bind(settings.input);
                item = input.resultType;
            }
            const body = compileLoopBody(settings.body, { ...environment, loop: { item } }, limits, outer);
            const until = settings.mode === 'repeatUntil'
                ? requireType(compileBinding(settings.until, { ...environment, loop: { item: body.result } }, limits.binding), 'boolean') : undefined;
            const results = { kind: 'array', items: body.result };
            return {
                plan: { kind: 'loop', mode: settings.mode, items, input, until, maxIterations: settings.maxIterations,
                    timeoutSeconds: settings.timeoutSeconds, ...settings.mode === 'repeatUntil' ? { onLimit: settings.onLimit } : {},
                    body: { entry: body.entry, nodes: body.nodes, exits: body.exits }, result: body.result },
                outputType: { kind: 'object', required: ['results', 'count'], properties: { results, count: numberType } },
                ports: settings.mode === 'repeatUntil' && settings.onLimit === 'branch' ? ['done', 'limit'] : ['done'],
            };
        }
        /* v8 ignore next -- the source schema admits only the closed NodeType union. */
        default: return assertNever(node.type);
    }
}
/**
 * Compile a Loop body as its own acyclic graph, entered at `entry`, where every step port either continues or exits.
 * Body steps see the loop's outer environment plus body outputs guaranteed on every path; exits must agree on one result type.
 */
function compileLoopBody(body, environment, limits, outer) {
    const ids = Object.keys(body.nodes).sort();
    if (ids.length > limits.source.maxNodes || body.edges.length + body.exits.length > limits.source.maxEdges) {
        throw new WorkflowCompileError('Loop body exceeds the configured node or edge budget.');
    }
    if (ids.some(id => outer.has(id)))
        throw new WorkflowCompileError('Loop body node IDs must differ from outer workflow node IDs.');
    if (!Object.hasOwn(body.nodes, body.entry))
        throw new WorkflowCompileError('Loop body entry must name a body node.');
    const leaving = new Set(), incoming = new Map(ids.map(id => [id, 0]));
    const claim = (from, port) => {
        const key = JSON.stringify([from, port ?? 'next']);
        if (!Object.hasOwn(body.nodes, from) || leaving.has(key))
            throw new WorkflowCompileError('Loop body ports must leave a body node exactly once.');
        leaving.add(key);
    };
    for (const edge of body.edges) {
        claim(edge.from, edge.port);
        if (!Object.hasOwn(body.nodes, edge.to) || edge.to === body.entry) {
            throw new WorkflowCompileError('Loop body edges must reach a body node other than the entry.');
        }
        incoming.set(edge.to, incoming.get(edge.to) + 1);
    }
    for (const exit of body.exits)
        claim(exit.from, exit.port);
    const order = [], ready = [body.entry];
    for (let id = ready.shift(); id; id = ready.shift()) {
        order.push(id);
        for (const edge of body.edges.filter(candidate => candidate.from === id)) {
            const remaining = incoming.get(edge.to) - 1;
            incoming.set(edge.to, remaining);
            if (remaining === 0) {
                ready.push(edge.to);
                ready.sort();
            }
        }
    }
    if (order.length !== ids.length)
        throw new WorkflowCompileError('Loop body must be acyclic and reachable from its entry.');
    const available = new Map();
    const nodes = [], exits = [];
    let result;
    for (const id of order) {
        const predecessors = body.edges.filter(edge => edge.to === id)
            .map(edge => available.get(edge.from));
        const first = predecessors[0] ?? environment.nodes;
        const upstream = Object.fromEntries(Object.entries(first).filter(([key]) => predecessors.every(branch => Object.hasOwn(branch, key))));
        const compiled = inStep(id, () => compileNode(body.nodes[id], { ...environment, nodes: upstream }, limits, outer));
        const reached = { ...upstream, [id]: compiled.outputType };
        const destinations = {};
        for (const edge of body.edges.filter(candidate => candidate.from === id))
            destinations[edge.port ?? 'next'] = edge.to;
        for (const exit of body.exits.filter(candidate => candidate.from === id)) {
            const port = exit.port ?? 'next';
            const binding = compileBinding(exit.result, { ...environment, nodes: reached }, limits.binding);
            if (result !== undefined && !sameType(result, binding.resultType)) {
                throw new WorkflowCompileError('Every Loop body exit must produce the same result type.');
            }
            result = binding.resultType;
            exits.push({ from: id, port, result: binding });
        }
        const covered = [...Object.keys(destinations), ...exits.filter(exit => exit.from === id).map(exit => exit.port)];
        if (covered.some(port => !compiled.ports.includes(port)) || compiled.ports.some(port => !covered.includes(port))) {
            throw new WorkflowCompileError('Every Loop body port requires exactly one continuation or exit.');
        }
        nodes.push({ id, plan: compiled.plan, outputType: compiled.outputType, destinations });
        available.set(id, reached);
    }
    return { entry: body.entry, nodes, exits, result: result };
}
/**
 * Revalidate source and compile the supported Trigger/LLM/Decision/Rule/Approval/Output graph into immutable local instructions.
 * Provider credentials, egress, capabilities and history authorization are runtime responsibilities, not granted by compilation.
 * @param value - unknown source document, including data loaded from disk, API, import or an AI proposal.
 * @param limits - explicit parser/schema/binding budgets from the consuming host.
 * @returns source-pinned instructions, exact branch destinations and validated input/output schema receipts.
 * @throws WorkflowCompileError for unsupported nodes/settings, incomplete ports or path-dependent references.
 */
export function compileWorkflow(value, limits) {
    const source = snapshotWorkflow(value, limits.source);
    const input = compileValueSchema(source.document.spec.inputSchema, limits.schema);
    const available = new Map();
    const nodes = [];
    const outer = new Set(source.order);
    for (const id of source.order) {
        // Source admission guarantees a topological order over exactly these node identities.
        const node = source.document.spec.nodes[id];
        const predecessors = source.document.spec.edges.filter(edge => edge.to === id).map(edge => edge.from);
        const incoming = predecessors.map(previous => available.get(previous));
        const first = incoming[0] ?? {};
        const upstream = Object.fromEntries(Object.entries(first).filter(([key]) => incoming.every(branch => Object.hasOwn(branch, key))));
        const compiled = inStep(id, () => compileNode(node, { inputs: input.valueType, nodes: upstream }, limits, outer));
        const edges = source.document.spec.edges.filter(edge => edge.from === id);
        const destinations = {};
        for (const edge of edges) {
            const port = edge.port ?? 'next';
            if (!compiled.ports.includes(port) || Object.hasOwn(destinations, port)) {
                throw new WorkflowCompileError('Node edge uses an unsupported or duplicated output port.');
            }
            destinations[port] = edge.to;
        }
        if (compiled.ports.some(port => !Object.hasOwn(destinations, port))) {
            throw new WorkflowCompileError('Every node output port requires a destination, including Rule defaults.');
        }
        nodes.push({ id, plan: compiled.plan, outputType: compiled.outputType, destinations });
        available.set(id, { ...upstream, [id]: compiled.outputType });
    }
    return deepFreeze({ compilerVersion: 'jevable-compiler/v1alpha1', source, input, nodes });
}
/**
 * Parse bounded YAML and compile it through the same admission path as object sources.
 * @param source - exactly one YAML workflow document.
 * @param limits - host-owned source/schema/binding budgets.
 * @returns a source-pinned immutable execution plan, without starting any nodes.
 */
export function compileWorkflowYaml(source, limits) {
    return compileWorkflow(parseWorkflow(source, limits.source).document, limits);
}
/**
 * Select exactly one Rule port using strict scalar comparisons and first-match Switch ordering.
 * @param rule - a local compiled If/Else or Switch plan.
 * @param values - schema-validated values available at this node.
 * @param inspect - Optional synchronous observer of the resolved condition or switch value; never receives the full context.
 * @returns a selected port and the safe structural Rule output; no provider or external side effect occurs.
 */
export function evaluateRule(rule, values, inspect) {
    const input = evaluateBinding(rule.kind === 'ifElse' ? rule.condition : rule.value, values);
    inspect?.(input);
    return evaluateResolvedRule(rule, input);
}
/**
 * Select a Rule route from its already resolved input, without evaluating a binding again.
 * @param rule - Compiled routing instructions from the pinned workflow.
 * @param input - The resolved condition or Switch value, admitted by the owning runtime.
 * @returns the selected port and structural output, using the same ordering as evaluateRule.
 */
export function evaluateResolvedRule(rule, input) {
    let port;
    switch (rule.kind) {
        case 'ifElse': {
            port = input === true ? 'true' : 'false';
            break;
        }
        case 'switch': {
            port = rule.cases.find(entry => entry.value === input)?.port ?? 'default';
            break;
        }
        /* v8 ignore next -- compiled Rule plans contain only the closed discriminated union. */
        default: return assertNever(rule);
    }
    return deepFreeze({ port, output: { selectedPort: port } });
}
