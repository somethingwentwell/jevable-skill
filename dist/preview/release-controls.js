/** Explicit packaging, never deployment or execution. Retain creation identity before sending it. */
export function liveReleaseControls(ctx, tools) {
    const el = (id) => document.getElementById(id);
    let pending, receipt, scope = '', evidenceKey = '', url;
    let version = 0, busy = false, loaded = false, storageFailed = false;
    let savedPage, listVersion = 0, listBusy = false, pageActive = true;
    const message = (text) => { el('release-message').textContent = text; };
    const clearDownload = () => {
        if (url)
            URL.revokeObjectURL(url);
        url = undefined;
        const link = el('release-download');
        link.hidden = true;
        link.removeAttribute('href');
        link.removeAttribute('download');
        el('release-file').textContent = '';
        el('release-next-steps').hidden = true;
        el('release-agent-handoff').value = '';
        el('release-start-prerequisites').textContent = '';
        // A revoked download must not leave a stale "ZIP ready" announcement.
        message('');
    };
    const invalidate = () => { version++; busy = false; clearDownload(); el('release-private').checked = false; };
    const clearList = () => {
        listVersion++;
        listBusy = false;
        savedPage = undefined;
        const select = el('release-saved-choice');
        select.replaceChildren();
        select.value = '';
        el('release-saved-message').textContent = 'Load saved versions explicitly. Opening this page never lists or packages them.';
    };
    const buttons = () => {
        const evidence = ctx.evidence(), attach = el('release-attach').checked;
        const choice = el('release-saved-choice').value;
        const inactive = !scope || !pageActive || busy || listBusy;
        el('release-saved-load').disabled = inactive;
        el('release-saved-next').disabled = inactive || !savedPage?.nextCursor;
        el('release-saved-choice').disabled = inactive || !savedPage?.releases.length;
        el('release-saved-open').disabled = inactive || !savedPage?.releases.some(r => r.id === choice && r.storage !== null) || Boolean(pending && !receipt);
        el('release-create').disabled = inactive || Boolean(pending) || storageFailed;
        el('release-inspect').disabled = inactive || !pending;
        el('release-new').disabled = inactive || !receipt;
        el('release-prepare').disabled = inactive || !receipt || Boolean(choice && choice !== receipt.id) || attach && !evidence;
        el('release-version').disabled = busy || Boolean(pending);
        el('release-storage').disabled = busy || Boolean(pending);
        el('release-notes').disabled = busy || Boolean(pending);
        el('release-notes-size').textContent = `${new TextEncoder().encode(el('release-notes').value).byteLength} / 16,384 UTF-8 bytes`;
        el('release-attach').disabled = busy || !scope;
        el('release-private').disabled = busy || !scope || !attach || evidence?.privacy !== 'private-execution-data';
        el('release-evidence').textContent = evidence ? `Reviewed evidence: ${evidence.sha256} · ${evidence.privacy}` : 'No prepared evidence ZIP. Export without evidence, or prepare selected evidence above first.';
        el('release-identity').textContent = pending ? `Retained release request ${pending.id}\n${pending.version} · ${pending.storage}\nProject ${pending.project.id} · generation ${pending.project.generation} · ${pending.project.revision}` : 'No release requested.';
        el('release-receipt').textContent = receipt ? JSON.stringify(receipt, null, 2) : '';
        // Human summary is derived only from the admitted receipt, never the raw response.
        el('release-summary').textContent = receipt
            ? `Version ${receipt.version} saved · ${receipt.storage === 'sqlite' ? 'Local SQLite' : 'PostgreSQL'} · ${url ? 'ZIP ready to download' : 'Ready to package'}. Nothing has been run or deployed.`
            : pending ? `Version ${pending.version} requested. Check saved release to verify it before packaging.`
                : 'No release yet. Choose a version, then create a saved copy of this workflow.';
    };
    const observe = () => {
        const next = ctx.scope() ?? '', evidence = ctx.evidence(), nextEvidence = evidence ? `${evidence.sha256}:${evidence.privacy}:${evidence.selectionSha256}` : '';
        if (next !== scope) {
            scope = next;
            invalidate();
            receipt = undefined;
            clearList();
        }
        if (nextEvidence !== evidenceKey) {
            evidenceKey = nextEvidence;
            invalidate();
        }
        if (scope && !loaded) {
            loaded = true;
            try {
                const value = JSON.parse(sessionStorage.getItem(ctx.storageKey) ?? 'null');
                if (value) {
                    const hasNotes = Object.hasOwn(value, 'notes');
                    const hasHash = Object.hasOwn(value, 'releaseSha256');
                    if (hasNotes)
                        tools.noteText(value.notes);
                    const keys = ['id', 'project', 'storage', 'version', ...(hasNotes ? ['notes'] : []), ...(hasHash ? ['releaseSha256'] : [])];
                    if (Object.keys(value).sort().join(',') !== keys.sort().join(',')
                        || hasHash && !/^[a-f0-9]{64}$/.test(value.releaseSha256 ?? '')
                        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.id ?? '')
                        || typeof value.version !== 'string' || value.version.length > 128 || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(value.version)
                        || !['sqlite', 'postgres'].includes(value.storage) || JSON.stringify(value.project) !== JSON.stringify(ctx.project()))
                        throw Error();
                    pending = value;
                    el('release-version').value = value.version;
                    el('release-storage').value = value.storage;
                    el('release-notes').value = value.notes ?? '';
                    message('Retained request restored. Inspect its status; no creation or export was retried.');
                }
            }
            catch {
                storageFailed = true;
                message('Release identity storage unavailable or invalid. Use the CLI; no creation request will be sent.');
            }
        }
        buttons();
    };
    const resolve = (value, saved) => {
        const result = tools.receipt(value, saved.project, saved.id);
        if (result.version !== saved.version || result.storage !== saved.storage || result.notes !== saved.notes
            || saved.releaseSha256 !== undefined && result.releaseSha256 !== saved.releaseSha256)
            throw Error();
        return result;
    };
    const readOrCreate = async (create) => {
        observe();
        if (!scope || !pageActive || busy || listBusy || storageFailed || create && pending || !create && !pending)
            return;
        if (create) {
            const releaseVersion = el('release-version').value, storage = el('release-storage').value;
            if (releaseVersion.length > 128 || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(releaseVersion) || !['sqlite', 'postgres'].includes(storage)) {
                message('Choose a version such as 1.0.0 and an explicit runtime backend.');
                return;
            }
            const text = el('release-notes').value;
            let notes;
            try {
                if (text !== '')
                    notes = tools.noteText(text);
            }
            catch {
                message('Notes must be nonblank UTF-8 text, at most 16,384 bytes, without control characters except tab, CR and LF. Nothing was created.');
                return;
            }
            const request = { id: crypto.randomUUID(), version: releaseVersion, storage: storage, project: { ...ctx.project() },
                ...(notes === undefined ? {} : { notes }) };
            try {
                sessionStorage.setItem(ctx.storageKey, JSON.stringify(request));
                pending = request;
            }
            catch {
                storageFailed = true;
                message('Cannot retain the request identity. Nothing was created.');
                buttons();
                return;
            }
        }
        const saved = pending, expectedScope = scope;
        invalidate();
        const token = version;
        busy = true;
        buttons();
        message(create ? 'Creating this immutable release only. No workflow execution or image build.' : 'Reading the retained release request only.');
        try {
            const value = await ctx.request(create ? { operation: 'release.create', id: saved.id, version: saved.version, storage: saved.storage,
                ...(saved.notes === undefined ? {} : { notes: saved.notes }) }
                : { operation: 'release.show', id: saved.id });
            observe();
            if (token !== version || scope !== expectedScope)
                return;
            receipt = resolve(value, saved);
            message('Release identity verified. Review it, then explicitly prepare the runnable ZIP.');
        }
        catch {
            observe();
            if (token !== version || scope !== expectedScope)
                return;
            receipt = undefined;
            message('Release result unavailable. The request ID is retained; Inspect reads its status without creating again. A missing result is not proof of failure. Use CLI inspection if unresolved.');
        }
        finally {
            if (token === version) {
                busy = false;
                buttons();
            }
        }
    };
    el('release-create').addEventListener('click', () => { void readOrCreate(true); });
    el('release-inspect').addEventListener('click', () => { void readOrCreate(false); });
    const readVersions = async (next) => {
        observe();
        if (!scope || !pageActive || busy || listBusy || next && !savedPage?.nextCursor)
            return;
        const cursor = next ? savedPage.nextCursor : undefined, expectedScope = scope, pin = { ...ctx.project() };
        clearList();
        const token = listVersion;
        listBusy = true;
        buttons();
        el('release-saved-message').textContent = 'Reading saved versions only; nothing is being created or run.';
        try {
            const raw = await ctx.request({ operation: 'release.list', ...(cursor === undefined ? {} : { cursor }) });
            observe();
            if (!pageActive || token !== listVersion || scope !== expectedScope)
                return;
            const page = tools.page(raw, pin), select = el('release-saved-choice');
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = 'Choose a saved version';
            select.replaceChildren(placeholder);
            for (const row of page.releases) {
                const option = document.createElement('option');
                option.value = row.id;
                option.textContent = `${row.version} · ${row.storage === null ? 'Original runtime required' : row.storage === 'sqlite' ? 'Local SQLite' : 'PostgreSQL'} · ${row.id.slice(0, 8)}`;
                option.disabled = row.storage === null;
                select.append(option);
            }
            select.value = '';
            savedPage = page;
            el('release-saved-message').textContent = page.releases.length
                ? `${page.releases.length} saved version(s) on this page. Choose one, then Open selected version.${page.releases.some(r => r.storage === null) ? ' Versions labelled Original runtime required need their original distribution; no runtime is substituted.' : ''}${page.nextCursor ? ' More pages are available.' : ' End of list.'}`
                : `No matching versions on this page.${page.nextCursor ? ' Choose Read next page to keep looking.' : ' End of list.'}`;
        }
        catch {
            observe();
            if (!pageActive || token !== listVersion || scope !== expectedScope)
                return;
            clearList();
            el('release-saved-message').textContent = 'Saved versions unavailable or the page expired. Load saved versions again explicitly; nothing was created or retried.';
            buttons();
        }
        finally {
            if (token === listVersion) {
                listBusy = false;
                buttons();
            }
        }
    };
    el('release-saved-load').addEventListener('click', () => { void readVersions(false); });
    el('release-saved-next').addEventListener('click', () => { void readVersions(true); });
    el('release-saved-choice').addEventListener('change', () => { invalidate(); buttons(); });
    el('release-saved-open').addEventListener('click', () => {
        void (async () => {
            observe();
            if (!scope || !pageActive || busy || listBusy)
                return;
            if (pending && !receipt) {
                message('Check the retained release request before switching versions. Nothing was created.');
                return;
            }
            const selected = savedPage?.releases.find(r => r.id === el('release-saved-choice').value);
            if (!selected || selected.storage === null)
                return;
            const expected = JSON.parse(JSON.stringify(selected)), expectedScope = scope;
            invalidate();
            const token = version;
            busy = true;
            buttons();
            message('Opening the selected saved version only. No creation, packaging or execution.');
            try {
                const raw = await ctx.request({ operation: 'release.show', id: expected.id });
                observe();
                if (!pageActive || token !== version || scope !== expectedScope)
                    return;
                const result = tools.receipt(raw, expected.project, expected.id);
                if (result.releaseSha256 !== expected.releaseSha256 || result.version !== expected.version || result.storage !== expected.storage
                    || result.runtime.version !== expected.runtime.version || result.runtime.sha256 !== expected.runtime.sha256)
                    throw Error();
                const retained = { id: result.id, version: result.version, storage: result.storage, project: { ...result.project },
                    releaseSha256: result.releaseSha256, ...(result.notes === undefined ? {} : { notes: result.notes }) };
                try {
                    sessionStorage.setItem(ctx.storageKey, JSON.stringify(retained));
                }
                catch {
                    storageFailed = true;
                    throw Error();
                }
                pending = retained;
                receipt = result;
                el('release-version').value = result.version;
                el('release-storage').value = result.storage;
                el('release-notes').value = result.notes ?? '';
                message('Saved version opened. Review its details, then choose Prepare app ZIP. Nothing was created or run.');
            }
            catch {
                observe();
                if (!pageActive || token !== version || scope !== expectedScope)
                    return;
                receipt = undefined;
                message('Saved version unavailable or changed. Inspect the retained request or reload versions explicitly; nothing was created, packaged or retried.');
            }
            finally {
                if (token === version) {
                    busy = false;
                    buttons();
                }
            }
        })();
    });
    el('release-notes').addEventListener('input', buttons);
    el('release-new').addEventListener('click', () => {
        observe();
        if (!scope || !pageActive || busy || listBusy || !receipt)
            return;
        try {
            sessionStorage.removeItem(ctx.storageKey);
        }
        catch {
            message('Cannot clear retained identity; no new request prepared.');
            return;
        }
        invalidate();
        receipt = undefined;
        pending = undefined;
        buttons();
        message('Choose a new version. The previous release remains in runtime storage.');
    });
    el('release-attach').addEventListener('change', () => { invalidate(); buttons(); });
    el('release-prepare').addEventListener('click', () => {
        void (async () => {
            observe();
            if (!scope || !pageActive || busy || listBusy || !receipt)
                return;
            const choice = el('release-saved-choice').value;
            if (choice && choice !== receipt.id) {
                message('Open the selected saved version before packaging. Nothing was packaged.');
                return;
            }
            const attach = el('release-attach').checked, evidence = attach ? ctx.evidence() : undefined;
            if (attach && !evidence) {
                message('Prepare and review the selected evidence ZIP first.');
                return;
            }
            if (evidence?.privacy === 'private-execution-data' && !el('release-private').checked) {
                message('Private evidence needs separate consent for this release ZIP and any image built from it.');
                return;
            }
            const saved = receipt, expectedScope = scope;
            invalidate();
            const token = version;
            busy = true;
            buttons();
            message('Preparing the pinned runnable app. No execution, image build, deployment or approval occurs.');
            try {
                const response = await ctx.request({ operation: 'release.export', id: saved.id, releaseSha256: saved.releaseSha256,
                    ...(evidence ? { evidence: { selection: evidence.selection, sha256: evidence.sha256, includePrivate: evidence.privacy === 'private-execution-data' } } : {}) });
                observe();
                if (token !== version || scope !== expectedScope)
                    return;
                const artifact = await tools.download(saved, response, evidence ? { sha256: evidence.sha256, selectionSha256: evidence.selectionSha256, privacy: evidence.privacy } : null);
                observe();
                if (token !== version || scope !== expectedScope)
                    return;
                url = URL.createObjectURL(new Blob([artifact.bytes], { type: 'application/zip' }));
                const link = el('release-download');
                link.href = url;
                link.download = artifact.filename;
                link.hidden = false;
                el('release-file').textContent = `${artifact.filename}\n${artifact.bytes.length} bytes\nZIP SHA-256: ${artifact.sha256}`;
                // Read-only handoff, derived only from the verified artifact/receipt. It is
                // not a download acknowledgment, execution request or stored input draft.
                el('release-start-prerequisites').textContent = saved.storage === 'sqlite'
                    ? 'Use Node 22.19 or newer. SQLite saves state locally; no npm install, Docker or authoring agent is needed to run the app. Configure any model providers separately.'
                    : 'Use Node 22.19 or newer and configure a PostgreSQL database before running. No npm install or authoring agent is needed; configure any model providers separately.';
                el('release-agent-handoff').value = [
                    'Help me prepare this Jevable workflow app locally. Ask me to select the downloaded ZIP; do not assume it was saved.',
                    `Expected filename: ${artifact.filename}`,
                    `Expected ZIP SHA-256: ${artifact.sha256}`,
                    `Expected release ID: ${saved.id}`,
                    `Expected release SHA-256: ${saved.releaseSha256}`,
                    `Storage: ${saved.storage}. Requires Node 22.19 or newer.`,
                    'Verify the ZIP against these pins and extract it into a fresh folder. Inspect its manifest and prerequisites before using its executable code.',
                    'After I confirm that I trust this app, use its own app.mjs info and app.mjs check commands. Do not install dependencies or connect to Jevable desktop, Jarness or a harness.',
                    'Ask me to confirm the input, provider costs and external effects before running. Do not copy preview state or credentials, approve anything, start Docker, deploy or publish automatically.',
                ].join('\n');
                el('release-next-steps').hidden = false;
                message('Runnable ZIP ready; click Download to save. Verify prerequisites and configure secrets independently before running. This is not proof of browser saving or target readiness.');
            }
            catch {
                observe();
                if (token !== version || scope !== expectedScope)
                    return;
                clearDownload();
                message('Export unavailable, evidence changed, too large or verification failed. Review a fresh evidence ZIP if needed, or use the CLI. Nothing was executed or retried.');
            }
            finally {
                if (token === version) {
                    busy = false;
                    buttons();
                }
            }
        })();
    });
    window.addEventListener('pagehide', () => { pageActive = false; invalidate(); receipt = undefined; clearList(); buttons(); });
    window.addEventListener('pageshow', () => { pageActive = true; observe(); });
    const disconnect = () => { invalidate(); receipt = undefined; pending = undefined; clearList(); sessionStorage.removeItem(ctx.storageKey); buttons(); };
    observe();
    return { observe, disconnect };
}
export const releaseControlsHtml = `<section class="panel live publish-release" id="live-release" hidden aria-label="Package a runnable workflow app">
<header class="publish-heading"><p class="publish-step">1 · Save a version</p><h2>Your workflow, ready to take with you.</h2>
<p>The ZIP contains your workflow and the Jevable workflow runtime: an entire runnable app, not just YAML or HTML. Run it with Node 22.19+; Docker is optional.</p></header>
<section class="publish-saved" aria-label="Saved workflow versions"><h3>Already saved a version?</h3><p>Open its existing copy before packaging. Only versions of this exact workflow snapshot are shown; opening never creates, runs or downloads anything.</p>
<div class="live-controls"><button id="release-saved-load" disabled>Load saved versions</button><button id="release-saved-next" disabled>Read next page</button></div>
<label for="release-saved-choice">Saved version</label><select id="release-saved-choice" disabled><option value="">Load saved versions first</option></select><button id="release-saved-open" disabled>Open selected version</button>
<p id="release-saved-message" role="status" aria-live="polite">Load saved versions explicitly. Opening this page never lists or packages them.</p></section>
<div class="publish-fields"><div><label for="release-version">Release version</label><input id="release-version" value="1.0.0" maxlength="128" aria-describedby="release-version-help"><p id="release-version-help">Use 1.0.0 for your first release.</p></div>
<div><label for="release-storage">Where the app saves its data</label><select id="release-storage"><option value="sqlite">Local SQLite</option><option value="postgres">PostgreSQL (configure independently)</option></select><p>SQLite keeps data locally. PostgreSQL needs a database you configure.</p></div></div>
<label for="release-notes">Release notes (optional plain text)</label><textarea id="release-notes" rows="2" maxlength="16384" aria-describedby="release-notes-help release-notes-size" placeholder="What changed in this version?"></textarea>
<p id="release-notes-help">Notes are fixed once saved and shared in the ZIP or image. Leave out secrets and private run data.</p><output id="release-notes-size" aria-live="polite"></output>
<div class="live-controls"><button id="release-create" disabled>Create release</button><button id="release-inspect" disabled>Check saved release</button><button id="release-new" disabled>Prepare another version</button></div>
<p id="release-summary" class="publish-summary">No release yet. Choose a version, then create a saved copy of this workflow.</p>
<details class="publish-details" id="release-details"><summary>Release identity and verification details</summary><pre id="release-identity"></pre><pre id="release-receipt"></pre>
<p>The request ID is retained before creation. After a lost response, Check saved release only reads—no automatic creation retry. Copy the ID before disconnecting; disconnect clears this tab's request identity, not the stored release. Notes are immutable and hashed; checking never submits new text.</p></details>
<div class="publish-package"><p class="publish-step">2 · Package and download</p><h3>Take the app with you</h3>
<p>Review your workflow for inline secrets before sharing. Provider credentials, configuration and active run state are not transferred.</p>
<details class="publish-details" id="release-evidence-options"><summary>Optional: include reviewed execution evidence</summary>
<label><input id="release-attach" type="checkbox">Attach exactly the prepared selected evidence ZIP</label><p id="release-evidence"></p>
<label><input id="release-private" type="checkbox" disabled>I authorize private evidence in this release ZIP and understand that building its Dockerfile includes that evidence in the image. Inline secrets may be included. This consent is for one preparation.</label>
<p>Prepare evidence in Workflow → Traces &amp; usage first. Evidence is review-only, never restored as runs or approvals. A changed checksum requires fresh review.</p></details>
<div class="live-controls"><button id="release-prepare" disabled>Prepare app ZIP</button><a id="release-download" hidden rel="noopener">Download app ZIP</a></div>
<p id="release-message" role="status" aria-live="polite"></p>
<details class="publish-details" id="release-file-details"><summary>ZIP checksum and running requirements</summary><pre id="release-file"></pre>
<p>Preparing does not build or publish images, deploy, execute or grant approval. Configure secrets independently before running. Preview ZIPs are limited to 12 MB; use CLI export for larger files or protected file permissions. A prepared ZIP does not prove browser saving or target readiness.</p></details></div>
<section class="publish-start" id="release-next-steps" hidden aria-labelledby="release-start-title"><p class="publish-step">3 · After downloading</p><h3 id="release-start-title">Start your app, not the editor.</h3>
<p id="release-start-prerequisites"></p>
<ol class="publish-start-steps"><li><strong>Save and verify the ZIP.</strong> Find it in your downloads and compare its checksum with the ZIP details above. Only run an app from a source you trust.</li>
<li><strong>Unzip into a fresh folder.</strong> The app carries its own Jevable workflow runtime. Your active preview runs and credentials stay here.</li>
<li><strong>Review setup, then choose what to run.</strong> Check the app's input and any required providers. Opening, downloading and checking never run the workflow.</li></ol>
<label for="release-agent-handoff">Ask your desktop agent to help</label><p id="release-agent-handoff-help">Select and copy this message into your agent conversation. It identifies this exact ZIP and asks before execution; it contains no workflow inputs or credentials.</p>
<textarea id="release-agent-handoff" readonly rows="7" spellcheck="false" aria-describedby="release-agent-handoff-help"></textarea>
<details class="publish-details"><summary>Prefer a terminal? Start with read-only checks</summary><p>After verifying and trusting the app, open a terminal in its extracted folder:</p><pre>node app.mjs info\nnode app.mjs check</pre><p>These commands inspect the release and readiness, not execution. Configure any requirements they report before choosing an input and running. Docker and Kubernetes are separate deployment choices, never started from this panel.</p></details></section></section>`;
