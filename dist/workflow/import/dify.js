/** Dify workflow DSL YAML to a reviewable Jevable draft for a documented node subset. */
import { DraftBuilder, llmConfig, placeholder, workflowId } from "./import-draft.js";
/** Dify DSL versions whose workflow graph layout this converter was written and tested against. */
export const DIFY_DSL_VERSIONS = /^0\.[1-3]\.\d+$/u;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/**
 * Whether a parsed YAML value looks like a Dify workflow export.
 * @param value - Parsed file content.
 * @returns true for a DSL document with a workflow graph.
 */
export function isDifyApp(value) {
    return object(value) && typeof value.version === 'string' && object(value.workflow) && object(value.workflow.graph)
        && Array.isArray(value.workflow.graph.nodes) && Array.isArray(value.workflow.graph.edges);
}
/**
 * Convert a Dify workflow export; unsupported nodes become placeholders that keep the draft from running.
 * @param app - Parsed DSL document with a supported version.
 * @returns the draft and its mapping report.
 */
export function convertDify(app) {
    const draft = new DraftBuilder(), nodes = app.workflow.graph.nodes.filter(node => object(node) && object(node.data));
    const title = app.app?.name?.trim() || 'Imported Dify workflow';
    const byId = new Map(nodes.map(node => [node.id, node]));
    const idOf = (node) => draft.id(node.id, node.data.title ?? node.id);
    const start = nodes.find(node => node.data.type === 'start');
    /** Translate a `[nodeId, variable]` selector into a Jevable reference path. */
    const selector = (path) => {
        if (!Array.isArray(path) || path.length < 2 || !path.every(part => typeof part === 'string'))
            return undefined;
        const [nodeId, ...rest] = path;
        const source = byId.get(nodeId);
        if (!source)
            return undefined;
        if (source.data.type === 'start')
            return `inputs.${rest.join('.')}`;
        if (source.data.type === 'iteration') {
            // Inside the body the iteration's item and index are the loop's; outside, its collected list is the loop result.
            if (rest[0] === 'item')
                return ['loop.item', ...rest.slice(1)].join('.');
            if (rest[0] === 'index')
                return 'loop.index';
            if (rest[0] === 'output')
                return `nodes.${idOf(source)}.output.results`;
        }
        if (source.data.type === 'llm' && rest.length === 1 && rest[0] === 'text')
            return `nodes.${idOf(source)}.output`;
        return `nodes.${idOf(source)}.output.${rest.join('.')}`;
    };
    const template = (text) => {
        let exact = true;
        const translated = text.replace(/\{\{#([^#]+)#\}\}/gu, (whole, inner) => {
            const path = selector(inner.split('.'));
            if (!path) {
                exact = false;
                return whole;
            }
            return `\${{ ${path} }}`;
        });
        return { text: translated, exact };
    };
    const operators = { 'is': '==', '=': '==', 'is not': '!=', '≠': '!=', '>': '>', '<': '<', '≥': '>=', '≤': '<=' };
    const condition = (data) => {
        const cases = Array.isArray(data.cases) ? data.cases : [{ conditions: data.conditions, logical_operator: data.logical_operator }];
        if (cases.length !== 1 || !object(cases[0]) || !Array.isArray(cases[0].conditions) || !cases[0].conditions.length)
            return undefined;
        const parts = [];
        for (const item of cases[0].conditions) {
            if (!object(item))
                return undefined;
            const left = selector(item.variable_selector), operation = String(item.comparison_operator);
            if (!left)
                return undefined;
            if (operation === 'empty' || operation === 'not empty')
                parts.push(`${operation === 'empty' ? '!' : ''}exists(${left})`);
            else {
                const operator = operators[operation];
                if (!operator)
                    return undefined;
                const numeric = typeof item.value === 'string' && ['>', '<', '≥', '≤'].includes(operation) && item.value.trim() !== '' && !Number.isNaN(Number(item.value));
                parts.push(`${left} ${operator} ${JSON.stringify(numeric ? Number(item.value) : item.value)}`);
            }
        }
        return `\${{ ${parts.join(cases[0].logical_operator === 'or' ? ' || ' : ' && ')} }}`;
    };
    const properties = {}, required = [];
    for (const variable of Array.isArray(start?.data.variables) ? start.data.variables : []) {
        if (!object(variable) || typeof variable.variable !== 'string')
            continue;
        const type = variable.type === 'number' ? { type: 'number' }
            : variable.type === 'select' && Array.isArray(variable.options) ? { type: 'string', enum: variable.options }
                : { type: 'string', ...typeof variable.max_length === 'number' ? { maxLength: variable.max_length } : {} };
        properties[variable.variable] = type;
        if (variable.required === true)
            required.push(variable.variable);
    }
    /** Convert one step that can appear in the outer graph or inside an iteration body. */
    const convert = (node) => {
        const data = node.data;
        if (data.type === 'llm') {
            const messages = Array.isArray(data.prompt_template) ? data.prompt_template.filter(object)
                : object(data.prompt_template) ? [data.prompt_template] : [];
            const user = template(messages.filter(item => item.role !== 'system').map(item => item.text).join('\n\n'));
            const system = template(messages.filter(item => item.role === 'system').map(item => item.text).join('\n\n'));
            const model = object(data.model) ? data.model : {};
            return { node: { type: 'llm', config: llmConfig(user.text, typeof model.name === 'string' ? model.name : undefined, typeof model.provider === 'string' ? model.provider : undefined, system.text) }, kind: 'approximate',
                reason: user.exact && system.exact ? 'model-route' : 'expression' };
        }
        if (data.type === 'if-else') {
            const translated = condition(data);
            const handle = Array.isArray(data.cases) && object(data.cases[0]) ? String(data.cases[0].case_id) : 'true';
            return { node: translated ? { type: 'rule', config: { mode: 'ifElse', condition: translated } }
                    : placeholder('The original branches use several cases or operators that have no Jevable rule equivalent.'),
                kind: translated ? 'exact' : 'unsupported', reason: translated ? 'mapped' : 'operator',
                port: value => (translated ? value === handle || value === 'true' ? 'true' : 'false' : undefined) };
        }
        if (data.type === 'code' && data.code_language === 'javascript') {
            const inputs = Array.isArray(data.variables) ? data.variables.filter(object) : [];
            const input = Object.fromEntries(inputs.flatMap((item) => {
                const path = selector(item.value_selector);
                return path && typeof item.variable === 'string' ? [[item.variable, `\${{ ${path} }}`]] : [];
            }));
            return { node: { type: 'custom', config: { language: 'javascript', code: typeof data.code === 'string' ? data.code : '', input,
                        outputSchema: { type: 'object' } } }, kind: 'approximate', reason: 'code' };
        }
        return { node: placeholder(`Imported from Dify node type ${data.type}; convert it by hand.`), kind: 'unsupported',
            reason: data.type === 'code' ? 'language' : 'node-type' };
    };
    const children = (parent) => nodes.filter(node => node.parentId === parent && node.data.type !== 'iteration-start');
    /** A sequential For Each over the iterator variable; its body keeps the iteration's own steps and connections. */
    const iteration = (node) => {
        const data = node.data, items = selector(data.iterator_selector), output = selector(data.output_selector);
        const inside = children(node.id), ids = new Set(inside.map(child => child.id));
        const first = app.workflow.graph.edges.find(edge => edge.source === data.start_node_id && ids.has(edge.target))?.target;
        const entry = inside.find(child => child.id === first);
        if (!items || !output || !entry) {
            return { node: placeholder('The iteration has no readable input list, first step or collected output.'), kind: 'unsupported', reason: 'loop' };
        }
        const body = {}, edges = [], ports = new Map();
        for (const child of inside) {
            const converted = convert(child), id = idOf(child);
            body[id] = { ...converted.node, title: child.data.title ?? child.id };
            ports.set(child.id, converted.port);
            draft.nest(child.data.title ?? child.id, child.data.type, id, converted.kind, converted.reason);
        }
        for (const edge of app.workflow.graph.edges) {
            const from = ids.has(edge.source) ? byId.get(edge.source) : undefined, to = ids.has(edge.target) ? byId.get(edge.target) : undefined;
            if (!from || !to)
                continue;
            const port = ports.get(edge.source)?.(edge.sourceHandle);
            if (edges.some(existing => existing.from === idOf(from) && existing.port === port))
                continue;
            edges.push({ from: idOf(from), to: idOf(to), ...port ? { port } : {} });
        }
        const exits = Object.entries(body).flatMap(([id, step]) => (step.type === 'rule' ? ['true', 'false'] : [undefined])
            .filter(port => !edges.some(edge => edge.from === id && edge.port === port))
            .map(port => ({ from: id, ...port ? { port } : {}, result: `\${{ ${output} }}` })));
        return { node: { type: 'loop', config: { mode: 'forEach', items: `\${{ ${items} }}`, maxIterations: 100, timeoutSeconds: 600,
                    body: { entry: idOf(entry), nodes: body, edges, exits } } },
            kind: 'approximate', reason: 'loop', port: () => 'done' };
    };
    const ports = new Map();
    for (const node of nodes) {
        const data = node.data, label = data.title ?? node.id;
        if (node.parentId !== undefined || data.type === 'iteration-start')
            continue;
        if (data.type === 'start') {
            const files = (Array.isArray(data.variables) ? data.variables : []).some(item => object(item) && String(item.type).includes('file'));
            draft.add(node.id, label, 'start', { type: 'trigger', config: { modes: ['manual'] } }, files ? 'approximate' : 'exact', files ? 'node-type' : 'mapped');
        }
        else if (data.type === 'end') {
            const outputs = Array.isArray(data.outputs) ? data.outputs : [];
            const value = {};
            let exact = true;
            for (const output of outputs) {
                const path = object(output) ? selector(output.value_selector) : undefined;
                if (!path || !object(output) || typeof output.variable !== 'string') {
                    exact = false;
                    continue;
                }
                value[output.variable] = `\${{ ${path} }}`;
            }
            draft.add(node.id, label, 'end', { type: 'output', config: { value } }, exact ? 'exact' : 'approximate', exact ? 'mapped' : 'expression');
        }
        else {
            const converted = data.type === 'iteration' ? iteration(node) : convert(node);
            draft.add(node.id, label, data.type, converted.node, converted.kind, converted.reason);
            ports.set(node.id, converted.port);
        }
    }
    for (const edge of app.workflow.graph.edges) {
        const from = byId.get(edge.source), to = byId.get(edge.target);
        if (!from || !to || from.parentId !== undefined || to.parentId !== undefined)
            continue;
        draft.connect(idOf(from), idOf(to), ports.get(edge.source)?.(edge.sourceHandle));
    }
    const kinds = draft.mappings.map(item => item.kind);
    const fidelity = kinds.includes('unsupported') ? 'unsupported' : kinds.includes('approximate') ? 'approximate' : 'exact';
    const document = draft.document({ type: 'object', properties, ...required.length ? { required } : {} }, { id: workflowId(title), name: title }, { format: 'dify', version: app.version, fidelity });
    return { format: 'dify', version: app.version, title, document, mappings: draft.mappings };
}
