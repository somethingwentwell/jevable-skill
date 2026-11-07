/** Mutable draft used while converting one vendor workflow. */
export class DraftBuilder {
    /** Outer graph nodes by Jevable identifier. */
    nodes = {};
    /** Outer graph edges; at most one continuation per source port. */
    edges = [];
    /** Report entries in source order. */
    mappings = [];
    ids = new Map();
    inputs = new Map();
    /**
     * Allocate a Jevable node identifier for a vendor node, stable within this conversion.
     * @param key - Vendor node identity.
     * @param label - Human name used to derive a readable identifier.
     * @returns an identifier matching the Jevable source rules and unique in this draft.
     */
    id(key, label) {
        const existing = this.ids.get(key);
        if (existing)
            return existing;
        // Expressions read nodes as `nodes.<id>`, so identifiers avoid `-`, which would parse as subtraction.
        const base = (label.normalize('NFKD').replace(/[^A-Za-z0-9_]+/gu, '_').replace(/^[^A-Za-z]+/u, '').replace(/_+$/u, '') || 'step').slice(0, 100);
        let candidate = base, index = 2;
        const taken = new Set(this.ids.values());
        while (taken.has(candidate) || ['__proto__', 'constructor', 'prototype'].includes(candidate))
            candidate = `${base}_${index++}`;
        this.ids.set(key, candidate);
        return candidate;
    }
    /**
     * Add one converted node and record how it maps to the vendor node.
     * @param key - Vendor node identity.
     * @param label - Vendor node name.
     * @param sourceType - Vendor node type, for the report.
     * @param node - Jevable node.
     * @param kind - Mapping fidelity.
     * @param reason - Stable reason code.
     * @returns the Jevable node identifier.
     */
    add(key, label, sourceType, node, kind, reason) {
        const id = this.id(key, label);
        this.nodes[id] = { ...node, title: node.title ?? label };
        this.mappings.push({ source: label, sourceType, target: id, kind, reason });
        return id;
    }
    /**
     * Record that a translated expression reads an input field, so the inferred input schema declares it.
     * @param path - Field path below `inputs`.
     * @param type - Type implied by how the field is used; a later, more specific use wins over `string`.
     */
    input(path, type) {
        const key = path.join('.'), previous = this.inputs.get(key);
        if (!previous || previous === 'string')
            this.inputs.set(key, type);
    }
    /**
     * Build an input schema declaring every recorded field as required, nesting objects along dotted paths. A `[]` segment
     * makes the field before it a list whose items have the rest of the path.
     * @returns a Jevable input schema; with no recorded fields, an open object.
     */
    inferredInputSchema() {
        const root = { type: 'object' };
        for (const [key, type] of this.inputs) {
            let current = root;
            const parts = key.split('.');
            for (const [index, part] of parts.entries()) {
                const last = index === parts.length - 1, next = last ? type : parts[index + 1] === '[]' ? 'array' : 'object';
                if (part === '[]') {
                    current = (current.items ??= { type: next });
                }
                else {
                    const properties = (current.properties ??= {});
                    const required = (current.required ??= []);
                    if (!required.includes(part))
                        required.push(part);
                    current = properties[part] ??= { type: next };
                }
                if (!last)
                    current.type = next;
            }
        }
        return root;
    }
    /**
     * Record a vendor node converted into a loop body step; it is not an outer node, so pruning never removes it.
     * @param label - Vendor node name.
     * @param sourceType - Vendor node type.
     * @param target - Body step identifier.
     * @param kind - Mapping fidelity.
     * @param reason - Stable reason code.
     */
    nest(label, sourceType, target, kind, reason) {
        this.mappings.push({ source: label, sourceType, target, kind, reason });
    }
    /**
     * Record a vendor node that has no Jevable node of its own, such as a model sub-node or an extra trigger.
     * @param label - Vendor node name.
     * @param sourceType - Vendor node type.
     * @param kind - Mapping fidelity.
     * @param reason - Stable reason code.
     */
    note(label, sourceType, kind, reason) {
        this.mappings.push({ source: label, sourceType, kind, reason });
    }
    /**
     * Finish the draft: add a manual Start when the source had no trigger, drop nodes that are unreachable because Jevable
     * has one continuation per port (reported as `unreachable`), and give every node without a continuation its own Output.
     * @param inputSchema - Workflow input schema.
     * @param metadata - Workflow identity and name.
     * @param extension - Import record kept in the revision for review.
     * @returns a complete Jevable workflow document.
     */
    document(inputSchema, metadata, extension) {
        let trigger = Object.entries(this.nodes).find(([, node]) => node.type === 'trigger')?.[0];
        if (!trigger) {
            const roots = Object.keys(this.nodes).filter(id => !this.edges.some(edge => edge.to === id));
            trigger = this.add('jevable:start', 'Start', 'none', { type: 'trigger', config: { modes: ['manual'] } }, 'approximate', 'trigger-mode');
            if (roots[0])
                this.edges.push({ from: trigger, to: roots[0] });
        }
        const reachable = new Set([trigger]), queue = [trigger];
        // The queue grows while it is iterated, visiting every reachable node once.
        for (const id of queue) {
            for (const edge of this.edges)
                if (edge.from === id && !reachable.has(edge.to)) {
                    reachable.add(edge.to);
                    queue.push(edge.to);
                }
        }
        const removed = new Set(Object.keys(this.nodes).filter(id => !reachable.has(id)));
        this.nodes = Object.fromEntries(Object.entries(this.nodes).filter(([id]) => reachable.has(id)));
        for (const [index, mapping] of this.mappings.entries()) {
            if (mapping.target !== undefined && removed.has(mapping.target)) {
                this.mappings[index] = { source: mapping.source, sourceType: mapping.sourceType, kind: 'unsupported', reason: 'unreachable' };
            }
        }
        const edges = this.edges.filter(edge => reachable.has(edge.from) && reachable.has(edge.to));
        this.edges.length = 0;
        this.edges.push(...edges);
        for (const [id, node] of Object.entries(this.nodes)) {
            if (node.type === 'output')
                continue;
            const expected = node.type === 'rule' && node.config.mode === 'ifElse' ? ['true', 'false'] : node.type === 'loop' ? ['done']
                : node.type === 'rule' && node.config.mode === 'switch' ? [...node.config.cases.map(item => item.port), 'default']
                    : [undefined];
            for (const port of expected) {
                if (this.edges.some(edge => edge.from === id && edge.port === port))
                    continue;
                const output = this.id(`${id}:${port ?? 'next'}:output`, port ? `${id}_${port}_result` : `${id}_result`);
                this.nodes[output] = { type: 'output', title: 'Result', config: { value: node.type === 'trigger' ? '${{ inputs }}' : `\${{ nodes.${id}.output }}` } };
                this.edges.push({ from: id, to: output, ...port ? { port } : {} });
            }
        }
        return { apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata, extensions: { 'jevable.ai/import': extension },
            spec: { inputSchema, nodes: this.nodes, edges: this.edges } };
    }
    /**
     * Add an edge unless its source is an Output or the port already continues elsewhere; a second continuation is parallel
     * fan-out Jevable cannot express.
     * @param from - Source node.
     * @param to - Target node.
     * @param port - Source port, omitted for the default continuation.
     */
    connect(from, to, port) {
        // An Output ends its path; a vendor edge leaving one has no Jevable meaning.
        if (this.nodes[from]?.type === 'output')
            return;
        if (!this.edges.some(edge => edge.from === from && edge.port === port))
            this.edges.push({ from, to, ...port ? { port } : {} });
    }
}
/**
 * Derive a workflow metadata identifier from a vendor workflow name.
 * @param name - Vendor workflow name.
 * @returns a lowercase slug that starts with a letter.
 */
export function workflowId(name) {
    const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60);
    return /^[a-z]/u.test(slug) ? slug : `imported-${slug || 'workflow'}`;
}
/**
 * LLM settings for an imported step. The connection names no allowed route, so the revision check reports that the user
 * must choose an allowed model before the draft can run; every limit is written into the YAML for review.
 * @param prompt - Translated prompt template.
 * @param model - Vendor model name, if known.
 * @param provider - Vendor provider name, if known.
 * @param systemPrompt - Translated system prompt, if any.
 * @returns an LLM node configuration.
 */
export function llmConfig(prompt, model, provider, systemPrompt) {
    return { provider: provider || 'choose-provider', model: model || 'choose-model', connection: { mode: 'workspace', id: 'choose-an-allowed-model' },
        prompt: prompt || 'Describe the task.', ...systemPrompt ? { systemPrompt } : {}, responseFormat: 'text',
        generation: { maxTokens: 1024, stream: true }, historyScope: 'none', execution: { timeoutSeconds: 60, maxAttempts: 1 } };
}
/**
 * Stand in for vendor behavior with no Jevable equivalent; empty code blocks compilation, so the draft cannot run.
 * @param description - Why the step needs manual conversion.
 * @returns an empty Custom step.
 */
export function placeholder(description) {
    return { type: 'custom', description, config: { language: 'javascript', code: '', input: {}, outputSchema: { type: 'object' } } };
}
