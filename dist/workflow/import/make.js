/** Make scenario blueprint JSON (Export Blueprint) to a reviewable Jevable draft for a documented module subset. */
import { DraftBuilder, workflowId } from "./import-draft.js";
import { VendorSteps, aiStep, blocked } from "./vendor-steps.js";
/** Blueprint `metadata.version` values this converter understands. */
export const MAKE_BLUEPRINT_VERSIONS = [1];
const aiApps = { 'openai-gpt-3': 'openai', 'anthropic-claude': 'anthropic', 'gemini-ai': 'gemini' };
const operators = { 'text:equal': '==', 'text:notequal': '!=',
    'number:equal': '==', 'number:notequal': '!=', 'number:greater': '>', 'number:less': '<', 'number:greaterorequal': '>=',
    'number:lessorequal': '<=' };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/**
 * Whether a parsed JSON value looks like a Make blueprint.
 * @param value - Parsed file content.
 * @returns true for an object with a `flow` list of modules.
 */
export function isMakeBlueprint(value) {
    return object(value) && Array.isArray(value.flow) && value.flow.length > 0
        && value.flow.every(item => object(item) && typeof item.module === 'string' && typeof item.id === 'number');
}
/**
 * The blueprint format version.
 * @param blueprint - Detected blueprint.
 * @returns the version when this converter supports it, otherwise undefined.
 */
export function makeVersion(blueprint) {
    const version = blueprint.metadata?.version;
    return typeof version === 'number' && MAKE_BLUEPRINT_VERSIONS.includes(version) ? version : undefined;
}
/**
 * Convert a Make scenario. The first module becomes a manual Start; a module's filter becomes an If/Else Rule when it is one
 * comparison of a trigger field; AI modules become LLM steps; a router follows its first route. Everything else becomes a
 * placeholder that keeps the draft from running.
 * @param blueprint - Parsed blueprint with a supported version.
 * @returns the draft and its mapping report.
 */
export function convertMake(blueprint) {
    const draft = new DraftBuilder(), title = blueprint.name?.trim() || 'Imported Make scenario';
    const steps = new VendorSteps(draft, (body) => {
        const [, step, path] = /^(\d+)\.([A-Za-z0-9_.]+)$/u.exec(body) ?? [];
        return step && path ? { step, path: path.split('.') } : undefined;
    });
    // The first module is always the trigger, so every later step has a predecessor.
    let previous = '';
    const connect = (id, port) => { draft.connect(previous, id, port); previous = id; };
    const add = (module, node, kind, reason) => draft.add(String(module.id), `${module.module} ${String(module.id)}`, module.module, node, kind, reason);
    const flow = [...blueprint.flow];
    for (const [index, module] of flow.entries()) {
        const [app = ''] = module.module.split(':');
        if (index === 0) {
            const id = add(module, { type: 'trigger', config: { modes: ['manual'] } }, 'approximate', 'trigger-mode');
            steps.remember(String(module.id), id, 'trigger');
            previous = id;
            continue;
        }
        if (module.filter) {
            const [[only, ...more] = [], ...groups] = module.filter.conditions ?? [];
            const operator = typeof only?.o === 'string' ? operators[only.o] : undefined;
            const condition = only && !more.length && !groups.length && operator && typeof only.a === 'string'
                ? steps.condition(only.a, operator, only.b) : undefined;
            const filter = condition
                ? draft.add(`${String(module.id)}:filter`, module.filter.name?.trim() || `Filter ${String(module.id)}`, 'filter', { type: 'rule', config: { mode: 'ifElse', condition } }, 'exact', 'mapped')
                : draft.add(`${String(module.id)}:filter`, module.filter.name?.trim() || `Filter ${String(module.id)}`, 'filter', blocked('operator').node, 'unsupported', 'operator');
            connect(filter);
        }
        if (module.module === 'builtin:BasicRouter') {
            // Make runs every route whose filters pass; Jevable follows one path, so only the first route is converted.
            const [first, ...others] = module.routes ?? [];
            for (const route of others)
                for (const skipped of route.flow ?? [])
                    draft.note(`${skipped.module} ${String(skipped.id)}`, skipped.module, 'unsupported', 'unreachable');
            flow.splice(index + 1, 0, ...first?.flow ?? []);
            draft.note(`${module.module} ${String(module.id)}`, module.module, 'approximate', 'operator');
            continue;
        }
        const provider = aiApps[app];
        const mapper = module.mapper ?? {};
        const messages = Array.isArray(mapper.messages) ? mapper.messages : [];
        const prompt = typeof mapper.prompt === 'string' ? mapper.prompt : messages.map(message => message.content).filter(text => typeof text === 'string').join('\n\n');
        const converted = provider ? aiStep(steps.template(prompt), mapper.model, provider)
            : app === 'code' ? blocked('code') : module.module === 'builtin:BasicFeeder' ? blocked('loop') : blocked('node-type');
        const id = add(module, converted.node, converted.kind, converted.reason);
        steps.remember(String(module.id), id, provider ? 'ai' : 'other');
        connect(id, draft.nodes[previous]?.type === 'rule' ? 'true' : undefined);
    }
    const document = draft.document(draft.inferredInputSchema(), { id: workflowId(title), name: title }, 
    // A Make trigger always becomes a manual Start, so no conversion is exact.
    { format: 'make', version: '1', fidelity: 'approximate' });
    return { format: 'make', version: '1', title, document, mappings: draft.mappings };
}
