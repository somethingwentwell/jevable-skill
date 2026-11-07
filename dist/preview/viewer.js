/** Serialized into the standalone artifact. No imports, network, storage or runtime access. */
export function previewViewer(data, options) {
    const get = (id) => document.getElementById(id);
    const svg = document.getElementById('graph');
    const ns = 'http://www.w3.org/2000/svg';
    const makeSvg = (tag, attrs = {}, text) => {
        const element = document.createElementNS(ns, tag);
        for (const [name, value] of Object.entries(attrs))
            element.setAttribute(name, String(value));
        if (text !== undefined)
            element.textContent = text;
        return element;
    };
    let renderGeneration = 0, listGeneration = 0, detailGeneration = 0;
    const button = (label, action) => {
        const generation = renderGeneration;
        const element = document.createElement('button');
        element.type = 'button';
        element.textContent = label;
        element.addEventListener('click', () => { if (generation === renderGeneration)
            action(); });
        return element;
    };
    const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
    const compactLabel = (label) => {
        if (label.length <= 24)
            return label;
        // Older hosts keep Unicode intact rather than guessing grapheme boundaries.
        // Full text remains available in the list, inspector, tooltip and ARIA label.
        if (!segmenter)
            return /^[\x00-\x7f]*$/u.test(label) ? `${label.slice(0, 23)}…` : label;
        const graphemes = [];
        for (const { segment } of segmenter.segment(label)) {
            graphemes.push(segment);
            if (graphemes.length > 24)
                return `${graphemes.slice(0, 23).join('')}…`;
        }
        return label;
    };
    const kinds = { trigger: 'Trigger', llm: 'LLM · writing', decision: 'Jev · judgment', rule: 'Rule · routing',
        humanApproval: 'Human Approval', loop: 'Bounded loop', custom: 'Custom · execution unavailable', output: 'Output' };
    let graph = data.graphs[0], selected = null;
    let execution = null;
    let breakpoints = null;
    const breakpointLabel = (id) => {
        if (!breakpoints)
            return '';
        const enabled = breakpoints.enabled.includes(id), proposed = breakpoints.draft?.includes(id) ?? enabled;
        if (breakpoints.hit?.nodeId === id)
            return `Breakpoint hit${breakpoints.hit.iteration === undefined ? '' : ` · iteration ${breakpoints.hit.iteration}`}${breakpoints.draft !== undefined && !proposed ? ' · draft remove' : ''}`;
        return enabled ? proposed ? 'Breakpoint configured' : 'Breakpoint · draft remove' : proposed ? 'Breakpoint · draft add' : '';
    };
    const labels = { unobserved: 'No recorded result', settled: 'Recorded result', next: 'Next · not executed', waiting: 'Approval wait',
        unsettled: 'Intent · outcome unsettled', failed: 'Failed checkpoint', stopped: 'Stopped · no rollback', 'active-loop': 'Current loop' };
    const nodeStatusLabel = (node) => node.status === 'failed' && node.code === 'approval-rejected' ? 'Request rejected'
        : node.status === 'failed' && node.code === 'approval-expired' ? 'Review time expired' : labels[node.status];
    const executionDetail = () => {
        const node = execution?.graphs.find(item => item.scope === graph.scope)?.nodes.find(item => item.id === selected);
        get('detail-execution').hidden = !node;
        get('detail-execution-body').textContent = node ? JSON.stringify({ status: nodeStatusLabel(node), recordedResults: node.count,
            iterations: node.iterations, currentIteration: node.currentIteration, attemptId: node.attemptId, code: node.code,
            timing: { recordedDurationMs: node.recordedDurationMs, timedResults: node.timedRecords, meaning: 'Sum of available result timings, not total run time. Approval timing includes its wait.' },
            omittedOlderRecords: node.omittedRecords, latestRecords: node.records }, null, 2) : '';
    };
    const applyExecution = () => {
        const evidence = execution?.graphs.find(item => item.scope === graph.scope);
        get('execution-overlay').hidden = !execution;
        get('execution-summary').textContent = execution?.summary ?? '';
        // Presentation only: the complete receipt remains in the closed disclosure.
        // Older graph hosts may not have these optional, plain-language elements.
        const status = get('execution-status'), guidance = get('execution-guidance');
        if (status) {
            const messages = {
                completed: 'Run finished. Select a highlighted step to inspect its saved result.',
                waiting: 'Waiting for a person to approve or reject the request.',
                paused: 'Ready for the next step. It has not run yet.',
                executing: 'A step was started; its outcome is not yet recorded.',
                failed: 'This run stopped with an error. Select the marked step to inspect what happened.',
                cancelled: 'This run was stopped. Actions already taken are not undone.',
            };
            const rejected = execution?.graphs.some(graph => graph.nodes.some(node => node.status === 'failed' && node.code === 'approval-rejected'));
            const expired = execution?.graphs.some(graph => graph.nodes.some(node => node.status === 'failed' && node.code === 'approval-expired'));
            status.textContent = !execution ? '' : execution.status === 'failed' && rejected
                ? 'The request was rejected here. No later step ran; earlier work is not undone.'
                : execution.status === 'failed' && expired
                    ? 'The review time expired here. No later step ran; earlier work is not undone.'
                    : messages[execution.status] ?? 'Saved run activity is available for inspection.';
        }
        if (guidance)
            guidance.textContent = !execution ? '' : execution.ambiguousConnections > 0
                ? 'Some connections are uncertain. Open the details before relying on the highlighted path.'
                : 'Highlights show saved activity, not proof that every connected step finished.';
        for (const group of svg.querySelectorAll('[data-node]')) {
            const item = graph.nodes.find(item => item.id === group.getAttribute('data-node'));
            const node = evidence?.nodes.find(node => node.id === item.id);
            group.setAttribute('data-execution', node?.status ?? 'none');
            const status = node ? `${nodeStatusLabel(node)}${node.count ? ` · ${node.count}` : ''}` : '';
            group.querySelector('[data-execution-label]').textContent = status;
            const breakpoint = breakpointLabel(item.id);
            group.setAttribute('data-breakpoint', breakpoint ? breakpoints?.hit?.nodeId === item.id ? 'hit' : 'marked' : 'none');
            group.querySelector('[data-breakpoint-label]').textContent = breakpoint;
            group.setAttribute('aria-label', `${item.node.title ?? item.id}, ${kinds[item.node.type]}${status ? `, ${status}` : ''}${breakpoint ? `, ${breakpoint}` : ''}`);
        }
        for (const path of svg.querySelectorAll('[data-edge]')) {
            const index = Number(path.getAttribute('data-edge')), edge = graph.edges[index], observed = evidence?.edges[index];
            path.setAttribute('data-execution', observed?.status ?? 'none');
            path.querySelector('title').textContent = `${edge.from} → ${edge.to} · ${edge.port ?? 'default'}${observed
                ? ` · ${observed.selectedCount} recorded port selections · ${observed.count} adjacency observations; not proof of completed target` : ''}`;
        }
        for (const row of get('connections').querySelectorAll('[data-connection]')) {
            const index = Number(row.getAttribute('data-connection')), edge = graph.edges[index], observed = evidence?.edges[index];
            row.textContent = `${edge.from} → ${edge.to} · ${edge.port ?? 'default'}${observed
                ? ` · ${observed.selectedCount} recorded port selections · ${observed.count} adjacency observations (${observed.status})` : ''}`;
        }
        for (const row of get('connections').querySelectorAll('[data-exit-index]')) {
            const index = Number(row.getAttribute('data-exit-index')), exit = graph.exits[index], observed = evidence?.exits[index];
            row.textContent = `${exit.from} → loop return · ${exit.port ?? 'next'} · ${JSON.stringify(exit.result)}${observed
                ? ` · ${observed.selectedCount} recorded port selections; not proof of successful return binding` : ''}`;
        }
        executionDetail();
    };
    let view = { x: 0, y: 0, w: 1000, h: 600 }, bounds = { w: 1000, h: 600 };
    const positions = new Map();
    const initialReadable = options?.initialView === 'readable' || svg.dataset.initialView === 'readable';
    let reading = false, overview = true, readingAnchor = null;
    const updateViewControls = () => {
        const ids = [...positions.keys()], index = ids.indexOf(readingAnchor ?? graph.entry ?? '');
        const earlier = get('graph-earlier'), later = get('graph-later');
        if (earlier)
            earlier.disabled = index <= 0;
        if (later)
            later.disabled = index < 0 || index >= ids.length - 1;
        const status = get('graph-view-status');
        // Describes navigation, not the capabilities or readiness of the host app.
        // Portable HTML stays inspection-only; the live host has separate run controls.
        const navigation = options?.context === 'live-workspace' ? 'exploring does not run steps' : 'diagram only';
        if (status)
            status.textContent = reading ? `Readable view · ${index + 1} of ${ids.length} steps · ${navigation}`
                : `${overview ? 'Whole workflow overview · choose Read steps to read labels' : 'Custom view'} · ${navigation}`;
    };
    const applyView = () => { svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`); updateViewControls(); };
    const fit = () => { reading = false; overview = true; view = { x: -30, y: -30, w: bounds.w + 60, h: bounds.h + 60 }; applyView(); };
    const readSteps = (id = selected ?? readingAnchor ?? graph.entry ?? [...positions.keys()][0]) => {
        const point = id ? positions.get(id) : undefined;
        if (!point) {
            fit();
            return;
        }
        // SVG and viewBox share an aspect ratio: text stays at 90% of its authored
        // size rather than shrinking an entire long workflow into this viewport.
        // Hidden/unmounted hosts use a bounded fallback until ResizeObserver sees it.
        const rect = svg.getBoundingClientRect(), width = rect.width > 0 ? rect.width : 800, height = rect.height > 0 ? rect.height : 560;
        reading = true;
        overview = false;
        readingAnchor = id;
        view = { x: point.x - 30, y: point.y + 70 - height / 1.8, w: width / .9, h: height / .9 };
        applyView();
    };
    const moveReadingView = (offset) => {
        const ids = [...positions.keys()], index = ids.indexOf(readingAnchor ?? graph.entry ?? ids[0] ?? '');
        const next = ids[index + offset];
        if (!next)
            return;
        const control = get(offset < 0 ? 'graph-earlier' : 'graph-later');
        const hadFocus = document.activeElement === control;
        readSteps(next); // Layout inspection, never a chosen workflow route.
        // Reaching an end disables the activated button. Keep keyboard focus in the
        // controls instead of leaving it on a disabled element or the page body.
        if (hadFocus && control.disabled)
            get(offset < 0 ? 'graph-later' : 'graph-earlier').focus({ preventScroll: true });
    };
    const zoom = (factor) => {
        reading = false;
        overview = false;
        const width = Math.max(160, Math.min(bounds.w * 3 + 500, view.w * factor)), ratio = width / view.w;
        view = { x: view.x + view.w * (1 - ratio) / 2, y: view.y + view.h * (1 - ratio) / 2, w: width, h: view.h * ratio };
        applyView();
    };
    // Keyboard focus is view-only: make its step visible without selecting it,
    // opening private data, changing overlays or asking the runtime to do work.
    const revealNode = (id) => {
        const point = positions.get(id);
        if (!point)
            return;
        readingAnchor = id;
        const ratio = Math.max(1, 280 / view.w, 180 / view.h);
        const next = { ...view, w: view.w * ratio, h: view.h * ratio };
        const left = point.x - 20, right = point.x + 240, top = point.y - 20, bottom = point.y + 160;
        if (left < next.x)
            next.x = left;
        else if (right > next.x + next.w)
            next.x = right - next.w;
        if (top < next.y)
            next.y = top;
        else if (bottom > next.y + next.h)
            next.y = bottom - next.h;
        if (next.x !== view.x || next.y !== view.y || next.w !== view.w || next.h !== view.h) {
            overview = false;
            view = next;
            applyView();
        }
        else
            updateViewControls();
    };
    const focusNode = (id) => {
        const node = [...svg.querySelectorAll('[data-node]')].find(node => node.getAttribute('data-node') === id);
        node?.focus({ preventScroll: true });
    };
    const moveFocus = (id, key) => {
        const current = positions.get(id);
        if (!current)
            return;
        const ordered = [...positions.keys()];
        if (key === 'Home' || key === 'End') {
            focusNode(key === 'Home' ? ordered[0] : ordered.at(-1));
            return;
        }
        const horizontal = key === 'ArrowLeft' || key === 'ArrowRight', forward = key === 'ArrowRight' || key === 'ArrowDown';
        const candidates = [...positions.entries()].filter(([, point]) => horizontal
            ? forward ? point.x > current.x : point.x < current.x
            : point.layer === current.layer && (forward ? point.y > current.y : point.y < current.y));
        // Move through the visible layout, not inferred workflow routes or port choices.
        // Prefer the nearest column, then the nearest row; never wrap at a boundary.
        candidates.sort(([, a], [, b]) => horizontal
            ? Math.abs(a.x - current.x) - Math.abs(b.x - current.x) || Math.abs(a.y - current.y) - Math.abs(b.y - current.y) || a.y - b.y
            : Math.abs(a.y - current.y) - Math.abs(b.y - current.y));
        if (candidates[0])
            focusNode(candidates[0][0]);
    };
    const showNode = (item, focus = false) => {
        if (!graph.nodes.includes(item))
            return;
        const generation = ++detailGeneration;
        selected = item.id;
        readingAnchor = item.id;
        svg.querySelectorAll('[data-node]').forEach(node => node.setAttribute('aria-pressed', String(node.getAttribute('data-node') === selected)));
        get('detail-title').textContent = item.node.title ?? item.id;
        get('detail-kind').textContent = `${graph.scope}/${item.id} · ${kinds[item.node.type]}`;
        get('detail-body').textContent = JSON.stringify({ description: item.node.description, config: item.node.config,
            extensions: item.node.extensions }, null, 2);
        const actions = get('detail-actions');
        actions.replaceChildren();
        if (item.bodyScope)
            actions.append(button('Explore loop body', () => {
                if (generation === detailGeneration)
                    switchGraph(item.bodyScope, 'canvas');
            }));
        executionDetail();
        if (focus) {
            reading = false;
            overview = false;
            const point = positions.get(item.id);
            view = { x: point.x - 90, y: point.y - 150, w: 420, h: 400 };
            applyView();
        }
        updateViewControls();
        options?.onSelect?.(item.id);
        options?.onNodeSelect?.({ nodeId: item.id, graphScope: graph.scope });
    };
    const renderList = () => {
        const generation = ++listGeneration;
        const filter = get('search').value.toLocaleLowerCase();
        const list = get('node-list');
        list.replaceChildren();
        const matching = graph.nodes.filter(item => `${item.id} ${item.node.title ?? ''} ${item.node.type}`.toLocaleLowerCase().includes(filter));
        get('search-count').textContent = `${matching.length} of ${graph.nodes.length} nodes`;
        for (const item of matching) {
            const li = document.createElement('li');
            li.append(button(`${item.node.title ?? item.id} · ${kinds[item.node.type]}`, () => {
                if (generation === listGeneration)
                    showNode(item, true);
            }));
            list.append(li);
        }
    };
    const render = () => {
        // Removed elements must never reinterpret their old IDs in a new scope,
        // including revisiting the same graph or sibling bodies with matching IDs.
        const generation = ++renderGeneration;
        svg.replaceChildren();
        positions.clear();
        selected = null;
        // Keep workflow direction consistent in every viewport. Fit, pan and zoom
        // handle narrow panels without changing the ordering users follow.
        const defs = makeSvg('defs'), marker = makeSvg('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
        marker.append(makeSvg('path', { d: 'M 0 0 L 10 5 L 0 10 Z', class: 'arrow' }));
        defs.append(marker);
        svg.append(defs);
        const nodes = new Map(graph.nodes.map(item => [item.id, item]));
        const incoming = new Map(graph.nodes.map(item => [item.id, 0])), layers = new Map(graph.nodes.map(item => [item.id, 0]));
        const validEdges = graph.edges.filter(edge => nodes.has(edge.from) && nodes.has(edge.to));
        for (const edge of validEdges)
            incoming.set(edge.to, incoming.get(edge.to) + 1);
        const queue = graph.nodes.filter(item => incoming.get(item.id) === 0).map(item => item.id);
        const ordered = [];
        for (let cursor = 0; cursor < queue.length; cursor++) {
            const id = queue[cursor];
            ordered.push(id);
            for (const edge of validEdges.filter(edge => edge.from === id)) {
                layers.set(edge.to, Math.max(layers.get(edge.to), layers.get(id) + 1));
                incoming.set(edge.to, incoming.get(edge.to) - 1);
                if (incoming.get(edge.to) === 0)
                    queue.push(edge.to);
            }
        }
        const unresolved = graph.nodes.filter(item => !ordered.includes(item.id));
        const fallbackLayer = Math.max(0, ...layers.values()) + 1;
        for (const [index, item] of unresolved.entries()) {
            layers.set(item.id, fallbackLayer + index);
            ordered.push(item.id);
        }
        const rows = new Map();
        for (const id of ordered) {
            const layer = layers.get(id), row = rows.get(layer) ?? 0;
            positions.set(id, { x: layer * 340 + 30, y: row * 170 + 50, layer });
            rows.set(layer, row + 1);
        }
        const nodeBottom = Math.max(170, ...[...positions.values()].map(p => p.y + 100));
        let channel = 0;
        const connections = get('connections');
        connections.replaceChildren();
        for (const [edgeIndex, edge] of graph.edges.entries()) {
            const li = document.createElement('li');
            li.setAttribute('data-connection', String(edgeIndex));
            li.textContent = `${edge.from} → ${edge.to}${edge.port ? ` · ${edge.port}` : ' · default'}`;
            connections.append(li);
            const from = positions.get(edge.from), to = positions.get(edge.to);
            if (!from || !to)
                continue;
            const outgoing = validEdges.filter(e => e.from === edge.from), arriving = validEdges.filter(e => e.to === edge.to);
            const fromOffset = outgoing.indexOf(edge) * 48 / Math.max(1, outgoing.length - 1) - (outgoing.length > 1 ? 24 : 0);
            const toOffset = arriving.indexOf(edge) * 48 / Math.max(1, arriving.length - 1) - (arriving.length > 1 ? 24 : 0);
            const x1 = from.x + 220, y1 = from.y + 48 + fromOffset, x2 = to.x, y2 = to.y + 48 + toOffset;
            let path, lx, ly;
            if (to.layer === from.layer + 1) {
                const mid = x1 + 60;
                path = `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`;
                lx = mid;
                ly = Math.min(y1, y2) - 10;
            }
            else {
                const bottom = nodeBottom + 50 + channel++ * 28;
                path = `M ${x1} ${y1} H ${x1 + 25} V ${bottom} H ${x2 - 25} V ${y2} H ${x2}`;
                lx = (x1 + x2) / 2;
                ly = bottom - 8;
            }
            const line = makeSvg('path', { d: path, class: 'edge', 'data-edge': edgeIndex, 'marker-end': 'url(#arrow)' });
            line.append(makeSvg('title', {}, li.textContent));
            svg.append(line);
            if (edge.port)
                svg.append(makeSvg('text', { x: lx, y: ly, class: 'edge-label', 'text-anchor': 'middle' }, edge.port));
        }
        for (const [index, exit] of graph.exits.entries()) {
            const li = document.createElement('li');
            li.setAttribute('data-exit-index', String(index));
            li.textContent = `${exit.from} → loop return${exit.port ? ` · ${exit.port}` : ''} · ${JSON.stringify(exit.result)}`;
            connections.append(li);
        }
        for (const id of ordered) {
            const item = nodes.get(id), point = positions.get(id);
            const group = makeSvg('g', { transform: `translate(${point.x} ${point.y})`, class: `node ${item.node.type}`, tabindex: 0,
                role: 'button', 'data-node': id, 'aria-pressed': 'false', 'aria-label': `${item.node.title ?? id}, ${kinds[item.node.type]}` });
            group.append(makeSvg('rect', { width: 220, height: 100, rx: 12 }));
            group.append(makeSvg('path', { d: 'M 10 -8 H 210 Q 228 -8 228 10 V 90 Q 228 108 210 108 H 10 Q -8 108 -8 90 V 10 Q -8 -8 10 -8 Z',
                class: 'node-focus-ring', 'data-focus-ring': '', 'aria-hidden': 'true', 'vector-effect': 'non-scaling-stroke' }));
            group.append(makeSvg('text', { x: 14, y: 25, class: 'kind' }, kinds[item.node.type].split(' · ')[0]));
            const label = item.node.title ?? id;
            group.append(makeSvg('text', { x: 14, y: 53, class: 'node-label' }, compactLabel(label)));
            group.append(makeSvg('text', { x: 14, y: 79, class: 'node-id' }, `${graph.entry === id ? 'ENTRY · ' : ''}${id.length > 23 ? `${id.slice(0, 22)}…` : id}`));
            group.append(makeSvg('text', { x: 0, y: 122, class: 'execution-label', 'data-execution-label': '' }));
            group.append(makeSvg('text', { x: 0, y: 140, class: 'breakpoint-label', 'data-breakpoint-label': '' }));
            group.append(makeSvg('title', {}, `${label}\n${id}\n${kinds[item.node.type]}`));
            group.addEventListener('focus', () => { if (generation === renderGeneration)
                revealNode(id); });
            group.addEventListener('click', () => { if (generation === renderGeneration)
                showNode(item); });
            group.addEventListener('keydown', event => {
                if (generation !== renderGeneration)
                    return;
                const keyboard = event, key = keyboard.key;
                if (keyboard.defaultPrevented || keyboard.isComposing || keyboard.altKey || keyboard.ctrlKey || keyboard.metaKey || keyboard.shiftKey)
                    return;
                if (key === 'Enter' || key === ' ') {
                    event.preventDefault();
                    showNode(item);
                }
                else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) {
                    event.preventDefault();
                    moveFocus(id, key);
                }
                else if (key === 'Escape') {
                    event.preventDefault();
                    svg.focus({ preventScroll: true });
                }
            });
            svg.append(group);
        }
        bounds = { w: Math.max(300, ...[...positions.values()].map(p => p.x + 250)), h: nodeBottom + 60 + channel * 28 };
        get('scope-label').textContent = graph.label;
        const back = get('graph-back');
        back.replaceChildren();
        back.hidden = true;
        const parent = data.graphs.find(candidate => candidate.nodes.some(node => node.bodyScope === graph.scope));
        const parentNode = parent?.nodes.find(node => node.bodyScope === graph.scope);
        if (parent && parentNode) {
            back.hidden = false;
            const returnButton = button('Back to workflow', () => switchGraph(parent.scope, parentNode.id));
            returnButton.setAttribute('aria-label', `Back to workflow: ${parent.label}`);
            back.append(returnButton);
        }
        get('graph-diagnostics').textContent = [...graph.diagnostics, ...(unresolved.length ? ['Cyclic connections cannot be topologically laid out; inspect the exact connection list.'] : [])].join('\n');
        get('detail-title').textContent = 'Inspect a node';
        get('detail-kind').textContent = 'Select a node in the graph or list.';
        get('detail-body').textContent = '';
        get('detail-actions').replaceChildren();
        readingAnchor = graph.entry ?? [...positions.keys()][0] ?? null;
        renderList();
        if (initialReadable)
            readSteps();
        else
            fit();
        applyExecution();
        options?.onSelect?.(null);
        options?.onNodeSelect?.(null);
    };
    const switchGraph = (scope, focus) => {
        const next = data.graphs.find(item => item.scope === scope);
        if (!next)
            return;
        graph = next;
        get('scope').value = scope;
        get('search').value = '';
        render();
        if (focus === 'canvas')
            svg.focus({ preventScroll: true });
        else if (focus)
            focusNode(focus);
    };
    get('workflow-title').textContent = data.name;
    get('identity').textContent = data.revision ? `Revision ${data.revision}` : `Unadmitted draft · source SHA-256 ${data.sourceSha256}`;
    get('validation').textContent = `${data.validation.status === 'valid' ? 'Compilation passed' : 'Invalid draft'} · Runtime not checked · Not run`;
    get('diagnostics').textContent = data.validation.diagnostics.map(item => `${item.code}: ${item.message}`).join('\n') || 'No compilation diagnostics. Provider readiness has not been checked.';
    get('source').textContent = data.source;
    const scope = get('scope');
    for (const item of data.graphs) {
        const option = document.createElement('option');
        option.value = item.scope;
        option.textContent = item.label;
        scope.append(option);
    }
    scope.addEventListener('change', () => switchGraph(scope.value));
    get('search').addEventListener('input', renderList);
    get('fit').addEventListener('click', fit);
    get('read-steps')?.addEventListener('click', () => readSteps());
    get('graph-earlier')?.addEventListener('click', () => moveReadingView(-1));
    get('graph-later')?.addEventListener('click', () => moveReadingView(1));
    get('zoom-in').addEventListener('click', () => zoom(0.8));
    get('zoom-out').addEventListener('click', () => zoom(1.25));
    get('theme').addEventListener('click', () => {
        const dark = document.documentElement.dataset.theme !== 'dark';
        document.documentElement.dataset.theme = dark ? 'dark' : 'light';
        get('theme').textContent = dark ? 'Light theme' : 'Dark theme';
    });
    let drag = null;
    svg.addEventListener('pointerdown', event => {
        if (event.target.closest('[data-node]'))
            return;
        reading = false;
        overview = false;
        drag = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y };
        svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener('pointermove', event => {
        if (!drag)
            return;
        const rect = svg.getBoundingClientRect(), scale = Math.max(view.w / rect.width, view.h / rect.height);
        view.x = drag.viewX - (event.clientX - drag.x) * scale;
        view.y = drag.viewY - (event.clientY - drag.y) * scale;
        applyView();
    });
    svg.addEventListener('pointerup', () => { drag = null; });
    svg.addEventListener('pointercancel', () => { drag = null; });
    svg.addEventListener('keydown', event => {
        if (event.target !== svg)
            return;
        if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || (event.shiftKey && event.key !== '+'))
            return;
        const movement = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const direction = movement[event.key];
        if (direction) {
            event.preventDefault();
            reading = false;
            overview = false;
            view.x += direction[0] * view.w / 10;
            view.y += direction[1] * view.h / 10;
            applyView();
        }
        else if (event.key === '+' || event.key === '=')
            zoom(0.8);
        else if (event.key === '-')
            zoom(1.25);
        else if (event.key === '0')
            fit();
    });
    render();
    if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(() => {
            if (reading && svg.getBoundingClientRect().width > 0)
                readSteps(readingAnchor ?? undefined);
        });
        observer.observe(svg);
    }
    return { setExecution(value) {
            if (value && (value.format !== 'jevable.preview-execution/v1' || !data.revision || value.revision !== data.revision)) {
                execution = null;
                applyExecution();
                throw Error('Execution overlay revision mismatch.');
            }
            execution = value;
            applyExecution();
        }, setBreakpoints(value) {
            const ids = new Set(data.graphs.flatMap(graph => graph.nodes.map(node => node.id)));
            const valid = (list) => Array.isArray(list) && list.length <= 128
                && list.every(id => typeof id === 'string' && ids.has(id)) && new Set(list).size === list.length;
            if (value && (!data.revision || value.revision !== data.revision || !valid(value.enabled)
                || (value.draft !== undefined && !valid(value.draft)) || (value.hit && (!ids.has(value.hit.nodeId)
                || (value.hit.iteration !== undefined && (!Number.isSafeInteger(value.hit.iteration) || value.hit.iteration < 0)))))) {
                breakpoints = null;
                applyExecution();
                throw Error('Breakpoint overlay revision or node mismatch.');
            }
            breakpoints = value ? { revision: value.revision, enabled: [...value.enabled], ...(value.draft === undefined ? {} : { draft: [...value.draft] }),
                ...(value.hit ? { hit: { ...value.hit } } : {}) } : null;
            applyExecution();
        } };
}
