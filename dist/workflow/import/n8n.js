/** n8n single-workflow JSON (editor Download) to a reviewable Jevable draft for a documented node subset. */
import { DraftBuilder, llmConfig, placeholder, workflowId } from "./import-draft.js";
/** Minimum n8n typeVersion per converted node type; older versions store different parameters and are reported as unsupported. */
export const N8N_NODE_VERSIONS = {
    'n8n-nodes-base.manualTrigger': 1, 'n8n-nodes-base.webhook': 1, 'n8n-nodes-base.scheduleTrigger': 1,
    'n8n-nodes-base.if': 2, 'n8n-nodes-base.switch': 3, 'n8n-nodes-base.code': 2,
    '@n8n/n8n-nodes-langchain.chainLlm': 1, '@n8n/n8n-nodes-langchain.agent': 1, 'n8n-nodes-base.splitInBatches': 3,
};
const triggers = new Set(['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.webhook', 'n8n-nodes-base.scheduleTrigger']);
const languageModels = /^@n8n\/n8n-nodes-langchain\.lm/u;
const loopType = 'n8n-nodes-base.splitInBatches';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/**
 * Whether a parsed JSON value looks like an n8n editor workflow.
 * @param value - Parsed file content.
 * @returns true for an object with a node list whose entries carry n8n node types.
 */
export function isN8nWorkflow(value) {
    return object(value) && Array.isArray(value.nodes) && value.nodes.every(node => object(node) && typeof node.name === 'string'
        && typeof node.type === 'string') && value.nodes.some(node => /^(n8n-nodes-base|@n8n\/)/u.test(node.type));
}
/**
 * Convert an n8n workflow; unsupported nodes become placeholders that keep the draft from running.
 * @param workflow - Parsed editor JSON.
 * @returns the draft and its mapping report.
 */
export function convertN8n(workflow) {
    const draft = new DraftBuilder(), title = workflow.name?.trim() || 'Imported n8n workflow';
    const nodes = workflow.nodes.filter(node => !node.disabled), connections = workflow.connections ?? {};
    const incoming = new Map();
    for (const [from, outputs] of Object.entries(connections)) {
        for (const target of (outputs.main ?? []).flat())
            if (target && !incoming.has(target.node))
                incoming.set(target.node, from);
    }
    const idOf = (name) => draft.id(name, name);
    const trigger = nodes.find(node => triggers.has(node.type));
    /**
     * The step feeding a Loop Over Items from outside its body, or undefined when the trigger or nothing feeds it; such a loop
     * iterates over an `items` input list.
     */
    const feederOf = (loop) => {
        const source = Object.entries(connections).find(([from, outputs]) => loopOf.get(from) !== loop
            && (outputs.main ?? []).flat().some(target => target?.node === loop))?.[0];
        return source === trigger?.name ? undefined : source;
    };
    const names = new Set(nodes.map(node => node.name));
    const version = (node) => (N8N_NODE_VERSIONS[node.type] ?? Infinity) <= (node.typeVersion ?? 1);
    /** Loop Over Items body: every step reached from the `loop` output before returning to the loop, or undefined when unsupported. */
    const bodyOf = (loop) => {
        const [entry, ...others] = connections[loop.name]?.main?.[1] ?? [];
        if (!entry || others.length || (loop.parameters?.batchSize ?? 1) !== 1)
            return undefined;
        const reached = new Set(), queue = [entry.node];
        for (const name of queue) {
            if (name === loop.name || reached.has(name) || !names.has(name))
                continue;
            reached.add(name);
            for (const targets of connections[name]?.main ?? [])
                for (const target of targets ?? [])
                    queue.push(target.node);
        }
        const members = nodes.filter(node => reached.has(node.name));
        const outside = Object.entries(connections).some(([from, outputs]) => from !== loop.name && !reached.has(from)
            && (outputs.main ?? []).flat().some(target => target && reached.has(target.node)));
        const nested = members.some(node => node.type === loopType || triggers.has(node.type));
        return outside || nested ? undefined : { entry: entry.node, members };
    };
    const loops = new Map(nodes.filter(node => node.type === loopType && version(node))
        .map(node => [node.name, bodyOf(node)]));
    /** The loop whose body contains a step, for translating reads of the loop's current item. */
    const loopOf = new Map([...loops].flatMap(([loop, body]) => (body?.members ?? []).map(node => [node.name, loop])));
    /** Translate `={{ $json.x }}` and `$('Node').item.json.x` references; anything else is not translated. */
    const expression = (value, current, type = 'string') => {
        if (typeof value !== 'string')
            return value === undefined ? undefined : { text: JSON.stringify(value), exact: true };
        if (!value.startsWith('='))
            return { text: JSON.stringify(value), exact: true };
        const match = /^=\{\{\s*(\$json|\$\((?:'([^']+)'|"([^"]+)")\)\.item\.json)((?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}$/u.exec(value);
        if (!match)
            return undefined;
        const source = match[2] ?? match[3] ?? incoming.get(current);
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the repeated path group always participates, possibly empty
        const path = match[4], fields = path.split('.').filter(Boolean);
        const loop = loopOf.get(current);
        if (loop !== undefined && source === loop) {
            // Inside a Loop Over Items body the loop's output is the current item.
            if (!feederOf(loop))
                draft.input(['items', '[]', ...fields], type);
            return { text: `loop.item${path}`, exact: true };
        }
        if (!source || source === trigger?.name) {
            if (fields.length)
                draft.input(fields, type);
            return { text: `inputs${path}`, exact: true };
        }
        return { text: `nodes.${idOf(source)}.output${path}`, exact: true };
    };
    const template = (value, current) => {
        if (typeof value !== 'string')
            return { text: '', exact: false };
        if (!value.startsWith('='))
            return { text: value, exact: true };
        let exact = true;
        const text = value.slice(1).replace(/\{\{\s*([^}]+?)\s*\}\}/gu, (whole, inner) => {
            const translated = expression(`={{ ${inner} }}`, current);
            if (!translated) {
                exact = false;
                return whole;
            }
            return `\${{ ${translated.text} }}`;
        });
        return { text, exact };
    };
    const operators = { equals: '==', notEquals: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
    const condition = (conditions, current) => {
        if (!object(conditions) || !Array.isArray(conditions.conditions) || !conditions.conditions.length)
            return undefined;
        const parts = [];
        for (const item of conditions.conditions) {
            if (!object(item) || !object(item.operator))
                return undefined;
            const operation = String(item.operator.operation);
            const right = item.rightValue;
            const left = expression(item.leftValue, current, operation === 'true' || operation === 'false' ? 'boolean'
                : typeof right === 'number' || item.operator.type === 'number' ? 'number' : 'string');
            if (!left)
                return undefined;
            if (operation === 'true' || operation === 'false')
                parts.push(operation === 'true' ? left.text : `!${left.text}`);
            else if (operation === 'exists' || operation === 'notExists')
                parts.push(`${operation === 'notExists' ? '!' : ''}exists(${left.text})`);
            else {
                const translated = expression(right, current), operator = operators[operation];
                if (!translated || !operator)
                    return undefined;
                parts.push(`${left.text} ${operator} ${translated.text}`);
            }
        }
        return `\${{ ${parts.join(conditions.combinator === 'or' ? ' || ' : ' && ')} }}`;
    };
    /** A Jevable switch compares one value with constants, so every rule must test the same value with `equals`. */
    const switchRules = (rules, current) => {
        let value;
        const cases = [];
        for (const [index, rule] of rules.entries()) {
            const conditions = object(rule) && object(rule.conditions) && Array.isArray(rule.conditions.conditions)
                ? rule.conditions.conditions : [];
            const only = conditions.length === 1 && object(conditions[0]) ? conditions[0] : undefined;
            const constant = only?.rightValue;
            if (!only || !object(only.operator) || only.operator.operation !== 'equals' || (constant !== null && typeof constant === 'object')
                || (typeof constant === 'string' && constant.startsWith('=')))
                return undefined;
            const left = expression(only.leftValue, current);
            if (!left || (value !== undefined && value !== left.text))
                return undefined;
            value = left.text;
            cases.push({ port: `case${index + 1}`, value: constant });
        }
        return value === undefined ? undefined : { value, cases };
    };
    /** Convert one step that can appear in the outer graph or in a Loop Over Items body. */
    const convert = (node) => {
        const parameters = node.parameters ?? {};
        const supported = version(node);
        if (node.type === 'n8n-nodes-base.if' && supported) {
            const translated = condition(parameters.conditions, node.name);
            return { node: translated ? { type: 'rule', config: { mode: 'ifElse', condition: translated } }
                    : placeholder('The original condition uses operators or expressions that have no Jevable rule equivalent.'),
                kind: translated ? 'exact' : 'unsupported', reason: translated ? 'mapped' : 'operator',
                port: index => (translated ? ['true', 'false'][index] : undefined) };
        }
        if (node.type === 'n8n-nodes-base.switch' && supported) {
            const rules = object(parameters.rules) && Array.isArray(parameters.rules.values) ? parameters.rules.values : [];
            const translated = switchRules(rules, node.name);
            return { node: translated ? { type: 'rule', config: { mode: 'switch', value: `\${{ ${translated.value} }}`, cases: translated.cases } }
                    : placeholder('The original routing rules compare different values or use operators that a Jevable switch cannot express.'),
                kind: translated ? 'exact' : 'unsupported', reason: translated ? 'mapped' : 'operator',
                port: index => (translated ? translated.cases[index]?.port ?? 'default' : undefined) };
        }
        if ((node.type === '@n8n/n8n-nodes-langchain.chainLlm' || node.type === '@n8n/n8n-nodes-langchain.agent') && supported) {
            const prompt = template(parameters.text ?? parameters.prompt, node.name);
            return { node: { type: 'llm', config: llmConfig(prompt.text) }, kind: 'approximate', reason: prompt.exact ? 'model-route' : 'expression' };
        }
        if (node.type === 'n8n-nodes-base.code' && supported && (parameters.language ?? 'javaScript') === 'javaScript') {
            const previous = incoming.get(node.name), loop = loopOf.get(node.name);
            const fromLoop = loop !== undefined && previous === loop;
            if (fromLoop && !feederOf(loop))
                draft.input(['items', '[]'], 'object');
            const input = fromLoop ? '${{ loop.item }}'
                : previous && previous !== trigger?.name ? `\${{ nodes.${idOf(previous)}.output }}` : '${{ inputs }}';
            return { node: { type: 'custom', config: { language: 'javascript', code: typeof parameters.jsCode === 'string' ? parameters.jsCode : '',
                        input, outputSchema: { type: 'object' } } }, kind: 'approximate', reason: 'code' };
        }
        return { node: placeholder(`Imported from n8n node type ${node.type}; convert it by hand.`), kind: 'unsupported',
            reason: node.type === 'n8n-nodes-base.code' && supported ? 'language' : node.type === loopType && supported ? 'loop' : 'node-type' };
    };
    /** A sequential For Each whose body keeps the loop's own steps; each step that returns to the loop, or stops, is an exit. */
    const loopNode = (loop, { entry, members }) => {
        const body = {}, edges = [];
        const ports = new Map(), inside = new Set(members.map(member => member.name));
        for (const member of members) {
            const converted = convert(member), id = idOf(member.name);
            body[id] = { ...converted.node, title: member.name };
            ports.set(member.name, converted.port);
            draft.nest(member.name, member.type, id, converted.kind, converted.reason);
        }
        for (const member of members) {
            for (const [index, targets] of (connections[member.name]?.main ?? []).entries()) {
                for (const target of targets ?? []) {
                    const port = ports.get(member.name)?.(index);
                    if (!inside.has(target.node) || edges.some(edge => edge.from === idOf(member.name) && edge.port === port))
                        continue;
                    edges.push({ from: idOf(member.name), to: idOf(target.node), ...port ? { port } : {} });
                }
            }
        }
        const exits = Object.entries(body).flatMap(([id, step]) => (step.type === 'rule' && step.config.mode === 'ifElse' ? ['true', 'false']
            : step.type === 'rule' ? [...step.config.cases.map(item => item.port), 'default'] : [undefined])
            .filter(port => !edges.some(edge => edge.from === id && edge.port === port))
            // n8n routing steps pass the item through, so a rule that returns to the loop yields the current item.
            .map(port => ({ from: id, ...port ? { port } : {},
            result: step.type === 'rule' ? '${{ loop.item }}' : `\${{ nodes.${id}.output }}` })));
        const feeder = feederOf(loop.name);
        const items = feeder === undefined ? 'inputs.items' : `nodes.${idOf(feeder)}.output`;
        return { node: { type: 'loop', config: { mode: 'forEach', items: `\${{ ${items} }}`, maxIterations: 100, timeoutSeconds: 600,
                    body: { entry: idOf(entry), nodes: body, edges, exits } } },
            kind: 'approximate', reason: 'loop', port: () => 'done' };
    };
    const ports = new Map();
    for (const node of nodes) {
        if (loopOf.has(node.name))
            continue;
        if (languageModels.test(node.type)) {
            draft.note(node.name, node.type, 'approximate', 'model-route');
            continue;
        }
        if (triggers.has(node.type) && version(node)) {
            if (node !== trigger) {
                draft.note(node.name, node.type, 'unsupported', 'trigger-mode');
                continue;
            }
            draft.add(node.name, node.name, node.type, { type: 'trigger', config: { modes: ['manual'] } }, node.type === 'n8n-nodes-base.manualTrigger' ? 'exact' : 'approximate', node.type === 'n8n-nodes-base.manualTrigger' ? 'mapped' : 'trigger-mode');
            continue;
        }
        const body = loops.get(node.name);
        const converted = body ? loopNode(node, body) : convert(node);
        draft.add(node.name, node.name, node.type, converted.node, converted.kind, converted.reason);
        ports.set(node.name, converted.port);
    }
    const typeOf = new Map(nodes.filter(node => !languageModels.test(node.type) && !loopOf.has(node.name))
        .map(node => [node.name, node.type]));
    for (const [from, outputs] of Object.entries(connections)) {
        if (!typeOf.has(from))
            continue;
        for (const [index, targets] of (outputs.main ?? []).entries()) {
            // The `loop` output of a converted Loop Over Items starts its body, which is nested in the loop step.
            if (index === 1 && loops.get(from))
                continue;
            for (const target of targets ?? []) {
                // A trigger starts the graph; an edge back into one would be a cycle.
                const type = typeOf.get(target.node);
                if (type === undefined || triggers.has(type))
                    continue;
                draft.connect(idOf(from), idOf(target.node), ports.get(from)?.(index));
            }
        }
    }
    const kinds = draft.mappings.map(item => item.kind);
    const summary = kinds.includes('unsupported') ? 'unsupported' : kinds.includes('approximate') ? 'approximate' : 'exact';
    const document = draft.document(draft.inferredInputSchema(), { id: workflowId(title), name: title }, { format: 'n8n', fidelity: summary });
    return { format: 'n8n', version: 'editor-json', title, document, mappings: draft.mappings };
}
