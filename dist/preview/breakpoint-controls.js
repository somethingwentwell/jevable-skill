/** Serialized page controller. Draft edits have no network/storage side effects. */
export function liveBreakpointControls(ctx) {
    const el = (id) => document.getElementById(id);
    const nodes = new Map(ctx.preview.graphs.flatMap(graph => graph.nodes.map(node => [node.id, { node, graph }])));
    const same = (a, b) => a.length === b.length && [...a].sort().every((id, index) => id === [...b].sort()[index]);
    const uuid = (v) => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
    const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
    const validate = (value) => {
        if (!Array.isArray(value) || value.length > 128 || value.some(id => typeof id !== 'string' || id.length > 128 || !nodes.has(id))
            || new Set(value).size !== value.length)
            throw Error('Invalid breakpoint selection for this workflow.');
        return [...value];
    };
    const inspect = (run) => {
        if (!run || !uuid(run.id) || run.revision !== ctx.preview.revision || ctx.preview.validation.status !== 'valid'
            || !hash(run.checkpointSha256) || !['paused', 'waiting', 'executing', 'completed', 'failed', 'cancelled'].includes(run.status))
            throw Error('Breakpoint metadata does not match this workflow.');
        const enabled = run.breakpoints === undefined ? [] : validate(run.breakpoints);
        if ((run.breakpoints !== undefined && !uuid(run.breakpointConfigurationRequestId))
            || (run.breakpoints === undefined && run.breakpointConfigurationRequestId !== undefined))
            throw Error('Invalid breakpoint configuration identity.');
        let hit;
        if (run.breakpoint !== undefined) {
            const value = run.breakpoint, node = nodes.get(value?.nodeId);
            if (!value || !node || run.status !== 'paused' || value.nodeId !== run.nodeId
                || !uuid(value.configurationRequestId) || !hash(value.checkpointSha256)
                || !Number.isSafeInteger(value.stepCount) || value.stepCount < 0 || !Array.isArray(run.steps) || value.stepCount !== run.steps.length
                || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at)))
                throw Error('Invalid breakpoint hit metadata.');
            const scope = value.scope;
            if (scope === undefined) {
                if (run.scope !== undefined || node.graph.scope !== ctx.preview.graphs[0].scope)
                    throw Error('Invalid breakpoint scope.');
            }
            else if (!scope || !Number.isSafeInteger(scope.index) || scope.index < 0 || run.scope?.loop !== scope.loop || run.scope?.index !== scope.index
                || nodes.get(scope.loop)?.node.bodyScope !== node.graph.scope)
                throw Error('Invalid breakpoint scope.');
            hit = { nodeId: value.nodeId, ...(scope ? { iteration: scope.index } : {}) };
        }
        return { id: run.id, checkpoint: run.checkpointSha256, enabled, ...(hit ? { hit } : {}) };
    };
    let identity = '', selected = '', base = '', draft, metadata;
    const selector = el('breakpoint-node');
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Choose a node, or select it in the graph';
    selector.append(blank);
    for (const [id, { node, graph }] of nodes) {
        const option = document.createElement('option');
        option.value = id;
        option.disabled = id.length > 128;
        option.textContent = `${graph.label} / ${node.node.title ?? id} (${id})${option.disabled ? ' · ID exceeds breakpoint limit' : ''}`;
        selector.append(option);
    }
    const observe = () => {
        const run = ctx.current(), next = typeof run?.id === 'string' ? run.id : '';
        if (next !== identity) {
            identity = next;
            selected = '';
            draft = undefined;
            base = '';
            selector.value = '';
        }
        metadata = undefined;
        let problem = '';
        if (run && !['loading', 'submitting'].includes(run.status)) {
            try {
                metadata = inspect(run);
            }
            catch {
                problem = 'Breakpoint metadata unavailable or mismatched. Inspect through the owner API; no breakpoint action is sent.';
            }
        }
        const editable = Boolean(metadata && ctx.canEdit()), stale = Boolean(draft && metadata?.checkpoint !== base);
        selector.disabled = !editable;
        el('breakpoint-toggle').disabled = !editable || !selected || selected.length > 128 || stale;
        el('breakpoint-clear').disabled = !editable || stale;
        el('breakpoint-discard').disabled = !editable || draft === undefined;
        const proposed = draft ?? metadata?.enabled ?? [], enabled = metadata?.enabled ?? [];
        el('breakpoint-toggle').textContent = proposed.includes(selected) ? 'Remove selected breakpoint from draft' : 'Add selected breakpoint to draft';
        el('breakpoint-configured').textContent = metadata ? `Runtime configuration: ${enabled.length ? enabled.join(', ') : 'none'}` : 'No retained breakpoint configuration loaded.';
        el('breakpoint-draft').textContent = draft === undefined ? 'No unapplied changes.' : `Unapplied draft: ${draft.length ? draft.join(', ') : 'clear all breakpoints'}`;
        el('breakpoint-message').textContent = problem || (stale ? 'Checkpoint changed. Discard this draft, inspect the new state, then select breakpoints again.'
            : draft ? 'Draft only. The next explicit Step or Continue applies this list and performs real execution. Refresh/reload never applies it.'
                : editable ? 'Select a node and edit a draft; no execution occurs until Step or Continue.'
                    : 'Start or select a paused run to edit breakpoints. Waiting approvals and executing/terminal runs are read-only.');
        el('breakpoint-hit').textContent = metadata?.hit ? `Paused before ${metadata.hit.nodeId}${metadata.hit.iteration === undefined ? '' : ` · loop iteration ${metadata.hit.iteration} (zero-based)`}. A fresh Step/Continue passes this recorded hit once; future matching nodes stop again.` : 'No current recorded breakpoint hit.';
        ctx.overlay(metadata ? { revision: ctx.preview.revision, enabled: [...enabled], ...(draft === undefined ? {} : { draft: [...draft] }),
            ...(metadata.hit ? { hit: { ...metadata.hit } } : {}) } : null);
        return metadata;
    };
    const edit = (value) => {
        if (!observe() || !ctx.canEdit() || (draft && metadata.checkpoint !== base))
            return;
        const next = validate(value);
        if (same(next, metadata.enabled)) {
            draft = undefined;
            base = '';
        }
        else {
            base ||= metadata.checkpoint;
            draft = next;
        }
        observe();
    };
    selector.addEventListener('change', () => { selected = nodes.has(selector.value) ? selector.value : ''; observe(); });
    el('breakpoint-toggle').addEventListener('click', () => {
        if (el('breakpoint-toggle').disabled)
            return;
        const current = draft ?? metadata?.enabled ?? [];
        if (!current.includes(selected) && current.length >= 128) {
            el('breakpoint-message').textContent = 'At most 128 node breakpoints are supported.';
            return;
        }
        edit(current.includes(selected) ? current.filter(id => id !== selected) : [...current, selected]);
    });
    el('breakpoint-clear').addEventListener('click', () => { if (!el('breakpoint-clear').disabled)
        edit([]); });
    el('breakpoint-discard').addEventListener('click', () => { if (!el('breakpoint-discard').disabled) {
        draft = undefined;
        base = '';
        observe();
    } });
    observe();
    return { observe, validate,
        select(id) { selected = id && nodes.has(id) ? id : ''; selector.value = selected; observe(); },
        fields() {
            if (!observe() || !ctx.canEdit())
                throw Error('Inspect a paused run before applying breakpoint controls.');
            if (draft && metadata.checkpoint !== base)
                throw Error('Checkpoint changed; discard the breakpoint draft and review again.');
            return draft === undefined ? {} : { breakpoints: [...draft] };
        },
        reconcile(run, request) {
            if (!request?.breakpoints || run.id !== request.id || run.lastControl?.requestId !== request.requestId)
                return;
            try {
                if (same(inspect(run).enabled, validate(request.breakpoints))) {
                    draft = undefined;
                    base = '';
                }
            }
            catch { /* Invalid metadata never acknowledges a draft. */ }
        },
    };
}
export const breakpointControlsHtml = `<section id="live-breakpoints" hidden aria-label="Node breakpoints"><h3>Node breakpoints · draft before execution</h3>
<p>Start paused first. Graph/node selection does not execute anything. Apply a draft only with Step or Continue above; Step still executes the current node. Drafts are cleared on reload or run change; submitted request identities retain their exact list for retry.</p>
<label for="breakpoint-node">Breakpoint node</label><select id="breakpoint-node" disabled></select>
<div class="live-controls"><button id="breakpoint-toggle" disabled>Add selected breakpoint to draft</button><button id="breakpoint-clear" disabled>Draft clear all</button><button id="breakpoint-discard" disabled>Discard draft</button></div>
<p id="breakpoint-configured"></p><p id="breakpoint-draft"></p><p id="breakpoint-hit" role="status" aria-live="polite"></p><p id="breakpoint-message" role="status" aria-live="polite"></p>
<p>Graph labels distinguish configured breakpoints, draft additions/removals and a recorded hit. Loop-body breakpoints apply to every iteration. Loop deadlines keep running during pauses.</p></section>`;
