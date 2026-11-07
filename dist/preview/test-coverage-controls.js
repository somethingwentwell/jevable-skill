/** Serialized standalone controller. Selections live only in this page, never in storage.
 * Loading, choosing and reading retained tests cannot run or approve a workflow. */
export function liveTestCoverageControls(ctx) {
    const el = (id) => document.getElementById(id);
    const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
    const count = (value, max = 100000) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
    const test = (value) => value && uuid(value.id) && count(value.generation, Number.MAX_SAFE_INTEGER)
        && value.generation > 0 && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256);
    const sameTest = (a, b) => test(a) && test(b) && a.id === b.id && a.generation === b.generation && a.sha256 === b.sha256;
    const matches = (value) => {
        const pin = ctx.project();
        return pin && value && value.id === pin.id && value.generation === pin.generation && value.revision === pin.revision;
    };
    let identity = ctx.scope(), version = 0, busy = false, hidden = false;
    let runs = [], selection = new Set();
    const report = () => {
        el('test-coverage-summary').textContent = '';
        el('test-coverage-gaps').replaceChildren();
    };
    const clear = () => {
        version++;
        busy = false;
        runs = [];
        selection = new Set();
        report();
        el('test-coverage-runs').replaceChildren();
        el('test-coverage-status').textContent = '';
    };
    const observe = () => {
        const next = hidden ? undefined : ctx.scope();
        if (identity !== next) {
            identity = next;
            clear();
        }
        el('test-coverage-load').disabled = busy || !identity;
        el('test-coverage-show').disabled = busy || !identity || !selection.size;
        for (const input of el('test-coverage-runs').querySelectorAll('input'))
            input.disabled = busy || !identity;
    };
    const current = (ticket) => { observe(); return Boolean(identity) && ticket === version; };
    const fail = (ticket, error) => {
        if (!current(ticket))
            return;
        report();
        el('test-coverage-status').textContent = 'Could not read coverage. Load past test runs again when the connection is ready.';
        ctx.error(error);
    };
    const begin = () => { observe(); if (!identity || busy)
        return undefined; busy = true; const ticket = ++version; observe(); return ticket; };
    const finish = (ticket) => { if (current(ticket)) {
        busy = false;
        observe();
    } };
    el('test-coverage-load').addEventListener('click', () => {
        observe();
        if (!identity || busy)
            return;
        clear();
        const ticket = begin();
        if (ticket === undefined)
            return;
        el('test-coverage-status').textContent = 'Loading past test runs…';
        void ctx.request({ operation: 'tests.coverage-runs' }).then(value => {
            if (!current(ticket))
                return;
            if (!matches(value?.project) || value.execution !== 'not-requested' || !Array.isArray(value.runs)
                || value.runs.length > 100 || !count(value.totalRuns, 10000) || value.totalRuns < value.runs.length
                || value.runs.some((run) => !uuid(run.id) || !test(run.test)
                    || !['executing', 'paused', 'waiting', 'completed', 'failed', 'cancelled'].includes(run.status)
                    || typeof run.updatedAt !== 'string' || !Number.isFinite(Date.parse(run.updatedAt)))
                || new Set(value.runs.map((run) => run.id)).size !== value.runs.length)
                throw Error('Past test runs did not match this workflow connection.');
            // Keep only admitted metadata; never display host-supplied private titles or values.
            runs = value.runs.map((run) => ({ id: run.id, test: { id: run.test.id, generation: run.test.generation, sha256: run.test.sha256 },
                status: run.status, updatedAt: run.updatedAt }));
            for (const run of runs) {
                const label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span');
                input.type = 'checkbox';
                input.value = run.id;
                text.textContent = `Test ${run.test.id.slice(0, 8)} · v${run.test.generation} · ${run.status} · ${new Date(run.updatedAt).toLocaleString()} · run ${run.id.slice(0, 8)}`;
                label.append(input, text);
                el('test-coverage-runs').append(label);
                input.addEventListener('change', () => {
                    observe();
                    if (!identity || busy || !runs.includes(run))
                        return;
                    version++;
                    report();
                    if (input.checked)
                        selection.add(run.id);
                    else
                        selection.delete(run.id);
                    el('test-coverage-status').textContent = selection.size ? `${selection.size} past test runs selected. Choose “Show coverage” to read their results.` : 'Choose the past test runs to check.';
                    observe();
                });
            }
            el('test-coverage-status').textContent = runs.length
                ? `Choose the past test runs to check.${value.totalRuns > runs.length ? ' Showing the most recently updated 100. Use the CLI for older runs.' : ''}`
                : 'No past test runs yet. Save and review a test, then choose Run accepted case. Come back here after it has run.';
        }).catch(error => fail(ticket, error)).finally(() => finish(ticket));
    });
    el('test-coverage-show').addEventListener('click', () => {
        observe();
        if (!selection.size)
            return;
        const ticket = begin();
        if (ticket === undefined)
            return;
        const chosen = runs.filter(run => selection.has(run.id)), runIds = chosen.map(run => run.id);
        report();
        el('test-coverage-status').textContent = 'Reading results. No workflow is being started.';
        void ctx.request({ operation: 'tests.coverage', runIds }).then(value => {
            if (!current(ticket))
                return;
            const preview = ctx.preview(), summary = value?.summary;
            const nodes = preview?.graphs.flatMap(graph => graph.nodes.map(node => JSON.stringify([graph.scope, node.id]))) ?? [];
            if (!matches(value?.project) || value.schemaVersion !== 1 || value.kind !== 'JevableTestSuiteCoverage'
                || typeof value.suiteSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.suiteSha256)
                || value.revision !== ctx.project()?.revision || value.execution !== 'not-requested'
                || value.consistency !== 'per-run-observations; not-an-atomic-snapshot'
                || value.semantics !== 'settled-results-and-recorded-port-selections; not-path-or-condition-coverage'
                || !['complete', 'partial', 'interrupted'].includes(value.observationStatus)
                || !Array.isArray(value.entries) || value.entries.length !== chosen.length
                || value.entries.some((entry, index) => entry.runId !== chosen[index].id || !sameTest(entry.test, chosen[index].test)
                    || entry.index !== index || !['not-observed', 'retained'].includes(entry.observation)
                    || (entry.observation === 'retained' ? !entry.result || entry.result.revision !== value.revision : entry.result !== undefined))
                || (value.observationStatus === 'complete' && value.entries.some((entry) => entry.observation !== 'retained'))
                || (value.observationStatus === 'partial' && value.entries.every((entry) => entry.observation === 'retained'))
                || !summary || summary.selectedRuns !== chosen.length || !count(summary.observedRuns, chosen.length)
                || summary.observedRuns !== value.entries.filter((entry) => entry.observation === 'retained').length
                || !count(summary.resultsWithoutRecordedPort) || !Array.isArray(value.nodes) || value.nodes.length !== nodes.length
                || new Set(value.nodes.map((node) => JSON.stringify([node.scope, node.nodeId]))).size !== nodes.length
                || value.nodes.some((node) => !nodes.includes(JSON.stringify([node.scope, node.nodeId])) || !count(node.settledResults)
                    || !count(node.runs, chosen.length) || node.runs > node.settledResults || (node.runs === 0) !== (node.settledResults === 0))
                || !Array.isArray(value.routes) || value.routes.length > 4000
                || new Set(value.routes.map((route) => JSON.stringify([route.scope, route.from, route.port]))).size !== value.routes.length
                || value.routes.some((route) => !nodes.includes(JSON.stringify([route.scope, route.from]))
                    || (route.to !== undefined && !nodes.includes(JSON.stringify([route.scope, route.to])))
                    || typeof route.port !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(route.port)
                    || !['continuation', 'loop-return'].includes(route.kind) || !count(route.selections) || !count(route.runs, chosen.length)
                    || route.runs > route.selections || (route.runs === 0) !== (route.selections === 0)
                    || (route.kind === 'continuation') !== (route.to !== undefined))
                || summary.totalNodes !== value.nodes.length || summary.nodesWithResults !== value.nodes.filter((node) => node.settledResults > 0).length
                || summary.totalRoutes !== value.routes.length || summary.routesWithSelections !== value.routes.filter((route) => route.selections > 0).length)
                throw Error('Coverage did not match the selected tests and workflow revision.');
            el('test-coverage-summary').textContent = `${summary.nodesWithResults} of ${summary.totalNodes} steps reached · ${summary.routesWithSelections} of ${summary.totalRoutes} branches recorded`;
            el('test-coverage-status').textContent = `Read ${summary.observedRuns} of ${summary.selectedRuns} selected test runs.${value.observationStatus !== 'complete' ? ' Some results are unavailable; this report is incomplete.' : ''}${summary.resultsWithoutRecordedPort ? ` ${summary.resultsWithoutRecordedPort} step results have no recorded branch. Their route is unknown.` : ''} Reached steps and recorded branches do not prove correct results, full paths or every condition. Waiting approvals are not completed steps.`;
            const gaps = [...value.nodes.filter((node) => node.settledResults === 0).map((node) => `Step not reached: ${node.scope} / ${node.nodeId}`),
                ...value.routes.filter((route) => route.selections === 0).map((route) => `Branch not recorded: ${route.scope} / ${route.from} [${route.port}] → ${route.to ?? 'return from loop'}`)];
            for (const text of gaps) {
                const item = document.createElement('li');
                item.textContent = text;
                el('test-coverage-gaps').append(item);
            }
            if (!gaps.length) {
                const item = document.createElement('li');
                item.textContent = 'Every step and branch has a retained observation in these tests. Check the expected and actual results separately.';
                el('test-coverage-gaps').append(item);
            }
        }).catch(error => fail(ticket, error)).finally(() => finish(ticket));
    });
    el('test-coverage-clear').addEventListener('click', () => { clear(); observe(); });
    window.addEventListener('pagehide', () => { hidden = true; clear(); observe(); });
    window.addEventListener('pageshow', () => { hidden = false; observe(); });
    observe();
    return { observe };
}
export const testCoverageHtml = `<section class="panel live" id="live-test-coverage" hidden aria-labelledby="test-coverage-title">
<h2 id="test-coverage-title">What have your tests reached?</h2>
<p>Choose past test runs to see which steps and branches they reached. This only reads saved results. It never runs a workflow or approves a decision.</p>
<button id="test-coverage-load" type="button" disabled>Load past test runs</button>
<fieldset class="test-coverage-picker"><legend>Choose past test runs</legend><div id="test-coverage-runs"></div></fieldset>
<div class="live-controls"><button id="test-coverage-show" type="button" disabled>Show coverage</button><button id="test-coverage-clear" type="button">Clear selection and report</button></div>
<p id="test-coverage-status" role="status" aria-live="polite"></p><p id="test-coverage-summary" class="test-coverage-summary"></p>
<details><summary>Steps and branches not observed</summary><ul id="test-coverage-gaps"></ul></details>
<p>Clear, disconnect and closing the page discard this display, not saved tests or evidence. To check newer results, load and select the runs again.</p></section>`;
