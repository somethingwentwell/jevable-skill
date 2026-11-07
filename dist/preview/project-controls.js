/** Explicit authoring export. No tab storage, import, acceptance or execution. */
export function liveProjectExportControls(ctx, prepare) {
    const el = (id) => document.getElementById(id);
    let scope = '', evidenceKey = '', version = 0, busy = false, url;
    const message = (value) => { el('project-export-message').textContent = value; };
    const clearDownload = () => {
        if (url)
            URL.revokeObjectURL(url);
        url = undefined;
        el('project-export-receipt').textContent = '';
        const link = el('project-export-download');
        link.hidden = true;
        link.removeAttribute('href');
        link.removeAttribute('download');
    };
    const invalidate = () => { version++; busy = false; clearDownload(); message(''); el('project-export-private').checked = false; };
    const buttons = () => {
        const evidence = ctx.evidence(), attach = el('project-export-attach').checked;
        for (const name of ['history', 'tests', 'attach'])
            el(`project-export-${name}`).disabled = !scope || busy;
        el('project-export-private').disabled = !scope || busy || !attach || evidence?.privacy !== 'private-execution-data';
        el('project-export-prepare').disabled = !scope || busy || attach && !evidence;
        el('project-export-evidence').textContent = evidence ? `Reviewed evidence: ${evidence.sha256} · ${evidence.privacy}` : 'No prepared evidence ZIP. Prepare one above to attach it, or export without evidence.';
    };
    const observe = () => {
        const next = ctx.scope() ?? '', evidence = ctx.evidence(), key = evidence ? `${evidence.sha256}:${evidence.selectionSha256}:${evidence.privacy}` : '';
        if (scope !== next) {
            scope = next;
            invalidate();
            for (const name of ['history', 'tests', 'attach'])
                el(`project-export-${name}`).checked = false;
        }
        if (evidenceKey !== key) {
            evidenceKey = key;
            invalidate();
        }
        buttons();
    };
    for (const name of ['history', 'tests', 'attach'])
        el(`project-export-${name}`).addEventListener('change', () => {
            invalidate();
            message('Export options changed. Review them, then prepare a new editable project ZIP.');
            buttons();
        });
    el('project-export-prepare').addEventListener('click', () => {
        void (async () => {
            observe();
            if (!scope || busy)
                return;
            const options = { history: el('project-export-history').checked, tests: el('project-export-tests').checked };
            const attach = el('project-export-attach').checked, evidence = attach ? ctx.evidence() : undefined;
            if (attach && !evidence) {
                message('Prepare and review the selected evidence ZIP first.');
                return;
            }
            if (evidence?.privacy === 'private-execution-data' && !el('project-export-private').checked) {
                message('Private evidence requires separate consent for this project ZIP.');
                return;
            }
            const expected = { project: { ...ctx.project() }, options }, expectedScope = scope;
            invalidate();
            const token = version;
            busy = true;
            buttons();
            message('Preparing editable authoring content only. No import, test acceptance, execution or deployment.');
            try {
                const result = await ctx.request({ operation: 'project.export', ...options,
                    ...(evidence ? { evidence: { selection: evidence.selection, sha256: evidence.sha256, includePrivate: evidence.privacy === 'private-execution-data' } } : {}) });
                observe();
                if (token !== version || scope !== expectedScope)
                    return;
                const artifact = await prepare(expected, result, evidence ? { sha256: evidence.sha256, selectionSha256: evidence.selectionSha256, privacy: evidence.privacy } : null);
                observe();
                if (token !== version || scope !== expectedScope)
                    return;
                url = URL.createObjectURL(new Blob([artifact.bytes], { type: 'application/zip' }));
                const link = el('project-export-download');
                link.href = url;
                link.download = artifact.filename;
                link.hidden = false;
                el('project-export-receipt').textContent = `${artifact.filename}\nZIP SHA-256: ${artifact.sha256}\nProject JSON SHA-256: ${artifact.bundleSha256}\n${artifact.bytes.length} bytes · ${artifact.tests.count} test definition(s) · ${artifact.tests.excludedOtherRevisions} other-revision cases excluded`;
                message('Editable project ZIP ready; click Download to save. Not a runnable app. Any included test definitions become drafts on import, not accepted tests or passing results. Saving and target import are not performed here.');
            }
            catch {
                observe();
                if (token !== version || scope !== expectedScope)
                    return;
                clearDownload();
                message('Project export unavailable, stale, too large or verification failed. Review current project/evidence through the owner or use the CLI. No workflow action was retried.');
            }
            finally {
                if (token === version) {
                    busy = false;
                    buttons();
                }
            }
        })();
    });
    window.addEventListener('pagehide', () => { invalidate(); buttons(); });
    observe();
    return { observe };
}
export const projectExportControlsHtml = `<section class="panel live" id="live-project-export" hidden aria-label="Download an editable project"><h2>Transfer an editable project · not a runnable app</h2>
<p>Export this preview's pinned project as source, inspection-only HTML and a checksum manifest. Use the runnable release panel above for an executable workflow app. Source itself may contain inline secrets.</p>
<label><input id="project-export-history" type="checkbox" disabled>Include private authoring history and recorded actors (external claims, not new approval authority)</label>
<label><input id="project-export-tests" type="checkbox" disabled>Include latest test definitions for this accepted revision, including private inputs and expected values (import as drafts requiring review)</label>
<label><input id="project-export-attach" type="checkbox" disabled>Attach exactly the prepared selected evidence ZIP</label><p id="project-export-evidence"></p>
<label><input id="project-export-private" type="checkbox" disabled>I authorize private evidence in this one project ZIP, including retained inputs, outputs, actors and historical test values. Inline secrets may be included.</label>
<div class="live-controls"><button id="project-export-prepare" disabled>Prepare editable project ZIP</button><a id="project-export-download" hidden rel="noopener">Download editable project ZIP</a></div>
<p id="project-export-message" role="status" aria-live="polite"></p><pre id="project-export-receipt"></pre>
<p>No import or execution occurs here. Test definitions and attached historical results are distinct. Import never restores attached runs, results, credentials or approvals. A changed evidence checksum requires fresh review. Preview downloads are limited to 12 MB; browser saving and permissions remain unqualified. Use the CLI for controlled file permissions and larger archives.</p></section>`;
