import { createHash } from 'node:crypto';
import { PROTOCOL_VERSION } from "../capabilities.js";
import { releaseMark } from "./page.js";
/** The reviewer page is inert until a grant is entered. No owner credentials,
 * release source, review data, or bearer are included in the HTML or URL.
 */
export function renderReleaseReviewerPage(instanceId) {
    const css = `:root{color-scheme:light dark;--bg:#f4f7fa;--card:#fff;--ink:#1b2633;--muted:#566677;--line:#d8e2ea;--blue:#265dba;--blue-bg:#e9f0fc;--red:#aa3d43;--green:#23724f;--disabled-bg:#4d688c;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}@media(prefers-color-scheme:dark){:root{--bg:#141b23;--card:#202a34;--ink:#eff5f9;--muted:#bfccd6;--line:#3d4b57;--blue:#a4c4ff;--blue-bg:#263b55;--red:#f3a2a7;--green:#87d0ac;--disabled-bg:#385678}}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--ink)}main{max-width:720px;margin:0 auto;padding:clamp(22px,5vw,54px) 20px 70px}.brand{display:flex;align-items:center;gap:10px;font-size:1.25rem;font-weight:750;letter-spacing:-.04em}.mark{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:#192536;color:white;font-size:1.3rem}h1{font-size:clamp(1.75rem,5vw,2.5rem);line-height:1.15;letter-spacing:-.04em;margin:32px 0 12px}h2{font-size:1.17rem;margin:0 0 10px}p{color:var(--muted);margin:0 0 18px}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:clamp(20px,4vw,30px);box-shadow:0 8px 28px #15273b0b;margin-top:24px}.field{display:grid;gap:7px;margin:18px 0}.field label{font-weight:650}input[type=password]{width:100%;padding:12px 13px;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--ink);font:inherit}button{font:inherit;min-height:44px;border:1px solid var(--line);border-radius:9px;padding:8px 16px;background:var(--card);color:var(--ink);cursor:pointer}button.primary{background:#265dba;border-color:#265dba;color:#fff}button:disabled{cursor:not-allowed;border-style:dashed}button.primary:disabled{background:var(--disabled-bg);border-color:var(--blue);color:#fff}:focus-visible{outline:3px solid var(--blue);outline-offset:3px}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}.eyebrow{font-size:.76rem;font-weight:750;letter-spacing:.09em;text-transform:uppercase;color:var(--blue);margin:0 0 9px}.review-value{border:1px solid var(--line);border-radius:11px;padding:18px;margin:18px 0;background:var(--card)}.review-value dl{margin:0;display:grid;gap:11px}.review-value dt{font-weight:650}.review-value dd{margin:3px 0 0;overflow-wrap:anywhere}.review-value ol{margin:4px 0;padding-left:22px}.review-value li{margin:5px 0;overflow-wrap:anywhere}.review-value details{margin-top:14px;color:var(--muted)}.review-value pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto;font-size:.78rem}.confirm{display:flex;gap:11px;align-items:flex-start;margin:20px 0}.confirm input{width:20px;height:20px;flex:none;margin-top:3px}.confirm span{font-weight:600}.callout{background:var(--blue-bg);border-left:3px solid var(--blue);padding:12px 14px;border-radius:3px;margin:18px 0;font-size:.9rem}.status{min-height:24px;margin:15px 0;color:var(--muted)}.status[data-tone=error]{color:var(--red)}.status[data-tone=success]{color:var(--green)}.details{font-size:.8rem;color:var(--muted);overflow-wrap:anywhere;margin-top:22px}.signout{margin-left:auto}header{display:flex;align-items:center;gap:15px}footer{font-size:.8rem;color:var(--muted);margin-top:35px}@media(max-width:450px){.actions button{flex:1}.card{padding:20px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}@media(forced-colors:active){button:disabled{border-color:GrayText}:focus-visible{outline-color:Highlight}}`;
    const browser = (expectedInstance, protocol) => {
        const $ = (id) => document.getElementById(id);
        const make = (tag, content) => { const el = document.createElement(tag); if (content !== undefined)
            el.textContent = content; return el; };
        let token = '', review = null, pending = null, busy = false, epoch = 0;
        const status = (message, tone = '') => { $('status').textContent = message; $('status').dataset.tone = tone; };
        const clearSession = () => {
            epoch++;
            token = '';
            review = null;
            pending = null;
            busy = false;
            $('login').hidden = false;
            $('review').hidden = true;
            $('complete').hidden = true;
            $('signout').hidden = true;
            $('retry').hidden = true;
            $('review-content').replaceChildren();
            $('decision-actions').replaceChildren();
            $('review-title').textContent = '';
            $('review-version').textContent = '';
            $('review-ids').textContent = '';
            $('outcome').textContent = '';
            $('outcome-note').textContent = '';
            const confirmation = $('confirm'), tokenInput = $('reviewer-token');
            confirmation.checked = false;
            tokenInput.value = '';
            tokenInput.focus();
        };
        const field = (key) => key.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/[_-]+/gu, ' ').replace(/^./u, c => c.toUpperCase());
        function readable(value, depth = 0) {
            if (value === null)
                return make('span', 'No value');
            if (typeof value === 'string')
                return make('span', value || '(empty text)');
            if (typeof value === 'number' || typeof value === 'boolean')
                return make('span', String(value));
            if (depth > 3)
                return make('span', 'See exact JSON below');
            if (Array.isArray(value)) {
                if (!value.length)
                    return make('span', 'No items');
                const list = make('ol');
                for (const item of value.slice(0, 25)) {
                    const row = make('li');
                    row.append(readable(item, depth + 1));
                    list.append(row);
                }
                if (value.length > 25)
                    list.append(make('li', `${value.length - 25} more items in exact JSON`));
                return list;
            }
            const entries = Object.entries(value), list = make('dl');
            if (!entries.length)
                return make('span', 'No fields');
            for (const [key, child] of entries.slice(0, 25)) {
                const row = make('div');
                row.append(make('dt', field(key)));
                const answer = make('dd');
                answer.append(readable(child, depth + 1));
                row.append(answer);
                list.append(row);
            }
            if (entries.length > 25)
                list.append(make('div', `${entries.length - 25} more fields in exact JSON`));
            return list;
        }
        async function post(path, value) {
            const current = epoch;
            const response = await fetch(path, { method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-jevable-protocol': protocol, 'x-jevable-instance': expectedInstance },
                body: JSON.stringify(value) });
            const body = await response.json().catch(() => null);
            if (current !== epoch)
                throw Error('This session changed. Reopen your request.');
            if (!response.ok || !body || body.instanceId !== expectedInstance) {
                if ((response.status === 409 && body?.code === 'instance-mismatch') || (body?.instanceId && body.instanceId !== expectedInstance))
                    throw Object.assign(Error('This review page is out of date because the workflow service restarted. Ask the workflow owner for the current review link.'), { code: 'service-changed' });
                if (response.status === 429 || response.status >= 500)
                    throw Error('The workflow is temporarily unavailable. Try again in a moment.');
                if (response.status === 401 || response.status === 403 || response.status === 404 || body?.code === 'not-found')
                    throw Object.assign(Error('This review token or request is no longer available. Ask the workflow owner for a new token.'), { code: 'access-ended' });
                throw Error('The connection could not be verified. Ask the workflow owner for help.');
            }
            return body.result;
        }
        function show(view) {
            review = view;
            pending = null;
            $('login').hidden = true;
            $('review').hidden = false;
            $('signout').hidden = false;
            $('review-title').textContent = String(view.review?.title ?? 'Decision requested');
            $('review-version').textContent = `Workflow version ${view.release.version} · reply before ${new Date(view.expiresAt).toLocaleString()}`;
            const content = $('review-content');
            content.replaceChildren(readable(view.review?.input));
            if (view.review?.input !== null && typeof view.review?.input === 'object') {
                const exact = make('details'), summary = make('summary', 'Show exact JSON');
                exact.append(summary, make('pre', JSON.stringify(view.review.input, null, 2)));
                content.append(exact);
            }
            $('review-ids').textContent = `Run ${view.runId} · request ${view.attemptId}`;
            const confirmation = $('confirm');
            confirmation.checked = false;
            const actions = $('decision-actions');
            actions.replaceChildren();
            for (const name of view.actions) {
                const button = make('button', name === 'approve' ? 'Approve and continue' : name === 'reject' ? 'Reject' : field(name));
                button.type = 'button';
                button.className = name === 'approve' ? 'primary' : '';
                button.disabled = true;
                confirmation.addEventListener('change', () => { button.disabled = !confirmation.checked || busy; });
                button.addEventListener('click', () => {
                    if (busy || !confirmation.checked)
                        return;
                    pending = { requestId: crypto.randomUUID(), action: name, pauseAfter: false };
                    void decide();
                });
                actions.append(button);
            }
            $('review').focus();
        }
        async function decide() {
            if (!pending || busy)
                return;
            const current = epoch;
            busy = true;
            for (const button of $('decision-actions').querySelectorAll('button'))
                button.disabled = true;
            $('retry').hidden = true;
            status('Recording your decision…');
            try {
                const result = await post('/v1/reviewer/decisions', pending);
                if (current !== epoch || !pending || !review)
                    return;
                if (result.requestId !== pending.requestId || result.runId !== review.runId || result.attemptId !== review.attemptId || result.action !== pending.action)
                    throw Error('The response did not match this request.');
                $('review').hidden = true;
                $('complete').hidden = false;
                $('outcome').textContent = result.action === 'approve' ? 'Your approval was recorded.'
                    : result.action === 'reject' ? 'Your rejection was recorded.' : `Your decision “${field(result.action)}” was recorded.`;
                $('outcome-note').textContent = result.status === 'completed' ? 'The workflow finished.'
                    : result.status === 'failed' && result.action === 'reject' ? 'The workflow stopped because this request was rejected.'
                        : result.status === 'failed' ? 'The workflow stopped with an error. Tell the owner.'
                            : result.status === 'cancelled' ? 'The workflow was cancelled.'
                                : result.status === 'waiting' ? 'The workflow is waiting for another decision.'
                                    : result.status === 'paused' ? 'The workflow is paused. The owner can review and continue it.'
                                        : 'The workflow may still be running. The owner can check its saved result.';
                status('Decision recorded.', 'success');
                pending = null;
                $('complete').focus();
            }
            catch (error) {
                if (current !== epoch)
                    return;
                if (error instanceof Error && error.code === 'service-changed') {
                    clearSession();
                    status('Review service restarted. This page cannot safely check whether your decision was saved. Ask the workflow owner to check the saved run. If it still needs a decision, open a fresh review page.', 'error');
                    return;
                }
                if (error instanceof Error && error.code === 'access-ended') {
                    clearSession();
                    status('Review access ended. This page cannot verify whether your decision was saved. Ask the workflow owner to check the run and send a new token if it still needs a decision.', 'error');
                    return;
                }
                status(`${error instanceof Error ? error.message : 'Connection failed.'} The outcome may be uncertain. Use “Check same decision” or ask the owner; do not submit a new decision.`, 'error');
                $('retry').hidden = false;
                $('retry').focus();
            }
            finally {
                if (current === epoch)
                    busy = false;
            }
        }
        $('connect-form').addEventListener('submit', event => {
            event.preventDefault();
            if (busy)
                return;
            const input = $('reviewer-token');
            token = input.value.trim();
            input.value = '';
            busy = true;
            status('Opening your request…');
            void post('/v1/reviewer/request', {}).then(show).then(() => status('Read the request before deciding.'))
                .catch(error => { token = ''; status(error instanceof Error ? error.message : 'Unable to open this request.', 'error'); })
                .finally(() => { busy = false; });
        });
        $('retry').addEventListener('click', () => { void decide(); });
        $('signout').addEventListener('click', () => { clearSession(); status('Signed out. This page does not save your token.'); });
    };
    const script = `(${browser.toString()})(${JSON.stringify(instanceId)},${JSON.stringify(PROTOCOL_VERSION)})`;
    const hash = (value) => createHash('sha256').update(value).digest('base64');
    const csp = `default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(css)}'; connect-src 'self'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Review a request · Jevable</title><style>${css}</style></head><body><main><header><div class="brand">${releaseMark}<span>jevable</span></div><button id="signout" class="signout" type="button" hidden>Sign out</button></header><p id="status" class="status" role="status" aria-live="polite" aria-atomic="true"></p><section id="login" class="card"><p class="eyebrow">One request, one decision</p><h1>Review a request</h1><p>Enter the private review token from the workflow owner. You will see only the request assigned to you, not other runs or settings.</p><form id="connect-form"><div class="field"><label for="reviewer-token">Review token</label><input id="reviewer-token" type="password" autocomplete="off" required><small>Use this only on a trusted device. The token stays in this browser tab and is not saved.</small></div><button class="primary" type="submit">Open my request</button></form></section><section id="review" class="card" tabindex="-1" aria-labelledby="review-title" hidden><p class="eyebrow">Your decision</p><h1 id="review-title"></h1><p id="review-version"></p><h2>What you are reviewing</h2><div id="review-content" class="review-value"></div><div class="callout">Choosing an action records your decision. It may continue the workflow and contact configured services; it does not undo earlier effects.</div><label class="confirm"><input id="confirm" type="checkbox"><span>I have read this request and am ready to decide.</span></label><div id="decision-actions" class="actions"></div><button id="retry" type="button" hidden>Check same decision</button><details class="details"><summary>Technical reference</summary><p id="review-ids"></p></details></section><section id="complete" class="card" tabindex="-1" aria-labelledby="outcome" hidden><p class="eyebrow">Saved decision</p><h1 id="outcome"></h1><p id="outcome-note"></p><p>Close this tab when finished. The owner can inspect the saved run.</p></section><footer>Jevable published workflow · Opening a request never approves it.</footer></main><script>${script}</script></body></html>`;
    return { html, csp };
}
