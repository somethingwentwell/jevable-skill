/** Serialized explicit-read controller. Private values live only in text nodes, never storage or exported HTML. */
export function liveNodeInspectionControls(ctx, project) {
    const el = (id) => document.getElementById(id);
    let selected = null;
    let identity = '\u0000', version = 0, busy = false, choices = [];
    const clear = () => { el('node-private-input').textContent = ''; el('node-private-output').textContent = ''; el('node-private-receipt').textContent = ''; };
    const buttons = () => {
        el('node-private-picker').hidden = choices.length <= 1;
        el('node-private-record').disabled = busy || !choices.length;
        el('node-private-load').disabled = busy || !choices.length;
        el('node-private-clear').disabled = false;
    };
    const observe = () => {
        const current = ctx.current(), run = current?.receipt;
        const valid = current && selected && run?.id && run.revision === current.preview.revision
            && /^[a-f0-9]{64}$/.test(run.checkpointSha256 ?? '');
        const next = valid ? JSON.stringify([current.session, run.id, run.revision, run.checkpointSha256, selected]) : '';
        if (next !== identity) {
            identity = next;
            version++;
            busy = false;
            choices = [];
            clear();
            const list = el('node-private-record');
            list.replaceChildren();
            list.value = '';
            let omitted = 0;
            if (valid) {
                try {
                    const overlay = project(current.preview, run), graph = overlay.graphs.find(graph => graph.scope === selected.graphScope);
                    const node = graph?.nodes.find(node => node.id === selected.nodeId);
                    if (!node)
                        throw Error('Selection');
                    omitted = node.omittedRecords;
                    const add = (record, label) => {
                        choices.push({ ...selected, record });
                        const option = document.createElement('option');
                        option.value = String(choices.length - 1);
                        option.textContent = label;
                        list.append(option);
                    };
                    const checkpointScope = run.scope ? current.preview.graphs[0].nodes.find(node => node.id === run.scope.loop)?.bodyScope
                        : current.preview.graphs[0].scope;
                    if (run.status !== 'completed' && run.nodeId === node.id && checkpointScope === graph.scope) {
                        const status = { waiting: 'Waiting for approval', paused: 'Paused here', executing: 'In progress', failed: 'Needs attention', cancelled: 'Stopped' }[run.status] ?? run.status;
                        add({ kind: 'checkpoint' }, `${status}${node.currentIteration === undefined ? '' : ` · round ${node.currentIteration + 1}`}`);
                    }
                    for (const [position, record] of [...node.records].reverse().entries())
                        add({ kind: 'step', index: record.index }, `${position === 0 ? 'Latest saved result' : `Earlier result ${position}`}${record.iteration === undefined ? '' : ` · round ${record.iteration + 1}`}`);
                    list.value = choices.length ? '0' : '';
                }
                catch {
                    choices = [];
                    list.replaceChildren();
                }
            }
            el('node-private-message').textContent = !valid ? 'Choose a run and a step to see its saved results. Selecting a step does not run it.'
                : !choices.length ? 'This step has no saved values to show yet.'
                    : `Choose Show saved values to read this result.${omitted ? ` ${omitted} older results are not shown here; use the CLI or API to inspect them.` : ''}`;
        }
        buttons();
        return current;
    };
    el('node-private-record').addEventListener('change', () => {
        version++;
        busy = false;
        clear();
        buttons();
        el('node-private-message').textContent = 'Choose Show saved values to read the selected result.';
    });
    el('node-private-clear').addEventListener('click', () => { version++; busy = false; clear(); buttons(); el('node-private-message').textContent = 'Values hidden. Your saved results have not been deleted.'; });
    el('node-private-load').addEventListener('click', () => {
        void (async () => {
            const current = observe(), selection = choices[Number(el('node-private-record').value)];
            if (!current || busy || !identity || !selection)
                return;
            const expected = identity, token = ++version, id = current.receipt.id, revision = current.receipt.revision;
            const checkpoint = current.receipt.checkpointSha256, captured = JSON.parse(JSON.stringify(selection));
            busy = true;
            clear();
            buttons();
            el('node-private-message').textContent = 'Reading this record only; no workflow action is being taken.';
            try {
                const raw = await ctx.request({ operation: 'node.inspect', id, expectedCheckpointSha256: checkpoint, selection: captured });
                observe();
                if (version !== token || identity !== expected)
                    return;
                const result = raw;
                if (!result || result.schemaVersion !== 1 || result.format !== 'jevable.preview-node-inspection/v1' || result.privateInspection !== true
                    || result.runId !== id || result.revision !== revision || result.checkpointSha256 !== checkpoint
                    || !result.selection || Object.keys(result.selection).length !== 3
                    || result.selection.graphScope !== captured.graphScope || result.selection.nodeId !== captured.nodeId
                    || !result.selection.record || result.selection.record.kind !== captured.record.kind
                    || (captured.record.kind === 'step' ? Object.keys(result.selection.record).length !== 2 || result.selection.record.index !== captured.record.index
                        : Object.keys(result.selection.record).length !== 1)
                    || !['node-result', 'loop-iteration-result', 'loop-aggregate', 'checkpoint'].includes(result.kind)
                    || !['settled', 'paused', 'waiting', 'executing', 'failed', 'cancelled'].includes(result.status)
                    || new TextEncoder().encode(JSON.stringify(result)).byteLength > 16_000_000)
                    throw Error('Invalid record');
                const display = (field) => {
                    if (!field || typeof field !== 'object' || Array.isArray(field))
                        throw Error('Invalid field');
                    if (field.status === 'recorded' && Object.keys(field).length === 2 && Object.hasOwn(field, 'value'))
                        return JSON.stringify(field.value, null, 2);
                    if (Object.keys(field).length === 1 && field.status === 'unavailable')
                        return 'Unavailable: this record has no saved value. Nothing was reconstructed.';
                    if (Object.keys(field).length === 1 && field.status === 'unsettled')
                        return 'Unsettled: no output is recorded. This does not prove provider activity, termination or rollback.';
                    throw Error('Invalid field');
                };
                const input = display(result.input), output = display(result.output);
                el('node-private-input').textContent = input;
                el('node-private-output').textContent = output;
                el('node-private-receipt').textContent = JSON.stringify({ runId: id, revision, checkpointSha256: checkpoint,
                    selection: captured, kind: result.kind, status: result.status }, null, 2);
                el('node-private-message').textContent = 'Saved values loaded. Showing them does not run this step again.';
            }
            catch {
                observe();
                if (version !== token || identity !== expected)
                    return;
                clear();
                el('node-private-message').textContent = 'Private record unavailable, stale or invalid. Refresh status and review the same run; nothing was executed or retried.';
            }
            finally {
                if (version === token) {
                    busy = false;
                    buttons();
                }
            }
        })();
    });
    window.addEventListener('pagehide', () => { version++; identity = ''; choices = []; clear(); buttons(); });
    observe();
    return { observe, select: (node) => { selected = node ? { ...node } : null; observe(); } };
}
export const nodeInspectionHtml = `<section class="panel live" id="node-private" hidden aria-label="Selected node private inspection"><h2>This step's saved values</h2>
<p>See what this step received and returned. Values stay private; hide them before sharing your screen.</p>
<div id="node-private-picker"><label for="node-private-record">Result to view</label><select id="node-private-record" disabled></select></div>
<div class="live-controls"><button id="node-private-load" disabled>Show saved values</button><button id="node-private-clear">Hide values</button></div>
<div id="node-private-summary"></div><p id="node-private-message" role="status" aria-live="polite"></p><details class="exact-values"><summary>Exact recorded inputs and outputs</summary><div class="live-grid"><section><h3>Recorded input</h3><pre id="node-private-input"></pre></section><section><h3>Recorded output</h3><pre id="node-private-output"></pre></section></div></details><details class="exact-values"><summary>Exact record identity</summary><pre id="node-private-receipt"></pre></details><details class="exact-values"><summary>Privacy and record details</summary><p>Private data is loaded only on request. Selecting a node, changing records or refreshing status never executes or reconstructs values. Values are excluded from portable HTML and tab storage. Result indices are global; loop iterations start at zero.</p></details></section>`;
