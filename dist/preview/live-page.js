/// <reference lib="dom" />
import { createHash } from 'node:crypto';
import { previewBody, previewCss } from "./index.js";
import { previewViewer } from "./viewer.js";
import { projectPreviewExecution } from "./execution.js";
import { liveTestControls, testControlsHtml } from "./test-controls.js";
import { liveTestCoverageControls, testCoverageHtml } from "./test-coverage-controls.js";
import { projectPreviewTestResult } from "./test-result-view.js";
import { liveModelHistoryControls, modelHistoryHtml } from "./model-history-controls.js";
import { projectPreviewModelHistory } from "./model-history.js";
import { schemaInputTools } from "./input-model.js";
import { liveInputControls, inputControlsHtml } from "./input-controls.js";
import { prepareEvidenceDownload } from "./evidence-download.js";
import { liveEvidenceControls, evidenceControlsHtml } from "./evidence-controls.js";
import { traceNavigationTools } from "../telemetry/navigation.js";
import { liveTraceControls, traceControlsHtml } from "./trace-controls.js";
import { liveBreakpointControls, breakpointControlsHtml } from "./breakpoint-controls.js";
import { previewRecoveryTarget } from "./recovery.js";
import { liveEvidenceBundleControls, evidenceBundleControlsHtml } from "./evidence-bundle-controls.js";
import { prepareEvidenceBundleDownload } from "./evidence-bundle-download.js";
import { liveReleaseControls, releaseControlsHtml } from "./release-controls.js";
import { previewReleaseTools } from "./release-download.js";
import { liveProjectExportControls, projectExportControlsHtml } from "./project-controls.js";
import { prepareProjectDownload } from "./project-download.js";
import { liveNodeInspectionControls, nodeInspectionHtml } from "./node-inspection-controls.js";
import { liveNotificationHistoryControls, notificationHistoryHtml } from "./notification-history-controls.js";
import { projectPreviewNotificationHistory } from "./notification-history.js";
import { liveUsageControls, usageControlsHtml } from "./usage-controls.js";
import { previewUsageTools } from "./usage.js";
import { workspaceScript } from "./workspace.generated.js";
import { workspaceCss } from "./workspace-style.js";
/** Serialized browser controller. Credentials stay in tab-scoped storage, never URLs or portable HTML. */
export function livePreviewBrowser(viewer, instanceId, protocol, setupTests, projectExecution, setupModelHistory, projectModelHistory, setupInput, inputTools, setupEvidence, prepareEvidence, setupTraces, navigationTools, setupBreakpoints, recoveryTarget, setupEvidenceBundle, prepareEvidenceBundle, setupRelease, releaseTools, setupProjectExport, prepareProject, setupNodeInspection, setupNotificationHistory, projectNotifications, setupUsage, usageTools, setupTestCoverage, projectTestResult, autoConnect = false) {
    const el = (id) => document.getElementById(id);
    const key = `jevable.preview.${instanceId}`;
    const disconnectedKey = `${key}.auto-connect-disabled`;
    let session;
    let testControls;
    let testCoverage;
    let modelHistory;
    let notificationHistory;
    let usageControls;
    let notificationProject;
    let nodeInspection;
    let evidenceControls;
    let evidenceBundleControls;
    let releaseControls;
    let projectExportControls;
    let traceControls;
    let breakpointControls;
    let inputControls, inputInitialized = false;
    const inputErrors = new WeakSet();
    let inputFeedback;
    const readInput = () => {
        try {
            return inputControls ? inputControls.read() : JSON.parse(el('live-input').value);
        }
        catch (failure) {
            if (failure !== null && typeof failure === 'object')
                inputErrors.add(failure);
            throw failure;
        }
    };
    let graphController, preview;
    let current, initialized = false, connected = false, mutation = false, timer, polls = 0, readVersion = 0;
    let approvalReview;
    let pauseMutation = false;
    let privateReadVersion = 0, privateReadPending = false, privatePageActive = true;
    let historyReadVersion = 0;
    const clearHistoryFeedback = () => {
        historyReadVersion++;
        el('live-history-status').textContent = '';
        el('run-history').setAttribute('aria-busy', 'false');
    };
    const clearPrivateResults = (notice = '') => {
        privateReadVersion++;
        privateReadPending = false;
        el('live-private-result').textContent = '';
        el('live-private-status').textContent = notice;
    };
    let connectionPending = false;
    const browserWindow = typeof window === 'undefined' ? undefined : window;
    let sessionNeedsConnection = false, expiryTimer;
    // Session visibility is not a live connectivity check. This display-only
    // observation uses existing replies, never polls, persists or grants access.
    // Only the latest dispatch in the current session/page may change it.
    let connectionObservationVersion = 0, connectionClosing = false;
    const connectionObservation = (text) => { el('live-connection-status').textContent = text; };
    const resetConnectionObservation = (text) => { connectionObservationVersion++; connectionObservation(text); };
    const staleSession = Object.freeze({});
    const missingAccessKey = Object.freeze({}), malformedAccessKey = Object.freeze({}), rejectedAccessKey = Object.freeze({});
    let keyFilePending = false;
    let pauseAtMutationStart;
    let recoveryIdentity = '', recoveryConsent = '';
    let entry = { local: false, api: false }, entryReady = false, viewVersion = 0;
    const modeFields = () => session?.triggerMode === 'api' ? { triggerMode: 'api' } : {};
    const canSubmit = () => connected && Boolean(session) && !mutation && !pauseUnresolved() && !session?.pendingControl
        && (!current || ['completed', 'failed', 'cancelled'].includes(current.status));
    const canSetAsideWaiting = () => connected && Boolean(session?.runId) && session?.runId === current?.id
        && current?.status === 'waiting' && !mutation && !pauseUnresolved() && !session?.pendingControl
        && !session?.cancelId && !current?.cancellation;
    const recovery = () => connected && session?.runId === current?.id ? recoveryTarget?.(preview, current) : null;
    const pauseUnresolved = () => pauseMutation || Boolean(session?.pendingPause);
    let noticeTone = 'neutral';
    const message = (text, tone = 'neutral') => {
        inputFeedback = undefined;
        noticeTone = tone;
        const notice = el('live-message');
        notice.setAttribute('data-tone', tone);
        notice.textContent = text;
    };
    const inputEdited = () => {
        // Only an error from our local input reader belongs to this draft. Editing
        // must not dismiss a lost transport response or another retained action.
        if (inputFeedback !== undefined && el('live-message').textContent === inputFeedback)
            message('Input changed. Choose Run workflow to check it; nothing was submitted.');
    };
    const retain = () => sessionStorage.setItem(key, JSON.stringify(session));
    const reconnectMessage = `Your connection expired or was closed. ${autoConnect ? 'Choose Connect' : 'Choose your access-key file, then Connect'} to reopen this workspace. Your saved work is still here; nothing runs again automatically.`;
    const clearExpiryTimer = () => { if (expiryTimer !== undefined)
        browserWindow?.clearTimeout(expiryTimer); expiryTimer = undefined; };
    const requireConnection = (identity) => {
        if (!identity || identity !== session)
            return;
        clearTimeout(timer);
        clearExpiryTimer();
        readVersion++;
        viewVersion++;
        connected = false;
        entryReady = false;
        sessionNeedsConnection = true;
        resetConnectionObservation('Connect to check the runtime again. Nothing runs automatically.');
        clearHistoryFeedback();
        // Keep unresolved identities even when the credential is no longer usable.
        // The persisted flag prevents reload from silently minting another session.
        session.reconnectRequired = true;
        let text = reconnectMessage;
        try {
            retain();
        }
        catch {
            text += ' Tab storage is unavailable; inspect the retained identities through the owner API before any further action.';
        }
        el('live-login').hidden = false;
        el('live-session').hidden = true;
        el('preview-workspace').hidden = true;
        el('live-token').value = '';
        clearPrivateResults();
        el('live-result').textContent = '';
        el('live-approval').hidden = true;
        el('live-review-data').textContent = '';
        el('live-actions').replaceChildren();
        approvalReview = undefined;
        el('live-authorize').checked = false;
        graphController?.setExecution?.(null);
        buttons(); // Clears scoped private displays and fences their in-flight replies.
        el('live-connect-error').textContent = text;
        message(text);
        if (!connectionPending)
            (autoConnect ? el('live-connect') : el('live-token')).focus();
    };
    const scheduleExpiry = () => {
        clearExpiryTimer();
        if (!session || sessionNeedsConnection)
            return;
        const identity = session, remaining = Date.parse(identity.expiresAt) - Date.now();
        if (remaining <= 0) {
            requireConnection(identity);
            return;
        }
        // Native browsers/JSDOM own this timer; minimal controller doubles do not.
        if (typeof browserWindow?.setTimeout !== 'function')
            return;
        expiryTimer = browserWindow.setTimeout(() => { if (session === identity && !sessionNeedsConnection)
            scheduleExpiry(); }, Math.min(remaining, 2_147_483_647));
    };
    const missingReply = (command, timedOut) => {
        // A missing reply is not a failed workflow or proof that a write rolled back.
        // Only fixed guidance and validated UUIDs leave this transport boundary;
        // never expose fetch/decoder errors, request input, headers or credentials.
        const request = command !== null && typeof command === 'object' && !Array.isArray(command)
            ? command : {};
        const reference = (value) => typeof value === 'string'
            && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
            ? ` Request reference: ${value}.` : '';
        const heading = timedOut ? 'The workflow runtime took too long to reply.'
            : "We couldn't get a complete reply from the workflow runtime.";
        const automatic = typeof request.operation === 'string' && ['tests.generate', 'tests.create', 'tests.edit', 'tests.accept', 'tests.archive',
            'run', 'tests.run', 'advance', 'cancel', 'decide', 'release.create'].includes(request.operation)
            ? ' A missing reply does not prove this action failed. Check saved state before taking another action.' : ' This lookup does not start or change a workflow.';
        let guidance, id = request.id;
        switch (request.operation) {
            case 'tests.generate':
                guidance = 'Your test drafts may already be saved. Choose Refresh saved tests to check. While this request is unresolved, Suggest test drafts retries its original request and entry, even if you changed the entry selector. Generating drafts does not accept or run tests.';
                break;
            case 'tests.create':
            case 'tests.edit':
            case 'tests.accept':
            case 'tests.archive':
                guidance = 'Your saved-test change may already be recorded. Choose Refresh saved tests to check the original test and its latest version before saving or accepting again. Do not create another copy while the result is unclear.';
                break;
            case 'tests.list':
            case 'tests.show':
            case 'tests.history':
            case 'tests.generation':
                guidance = 'Your saved tests could not be loaded. Choose Refresh saved tests to try reading them again. This lookup does not create, accept or run tests.';
                break;
            case 'tests.result':
                id = request.runId;
                guidance = 'The saved test result could not be loaded. Choose Show expected and actual results to read it again. This does not rerun the test.';
                break;
            case 'run':
            case 'tests.run':
                if (request.operation === 'tests.run')
                    id = request.runId;
                guidance = "Your workflow may still be running, or its result may already be saved. Choose Refresh status to check this same run. Don't start another run while this one's result is unclear.";
                break;
            case 'advance':
                id = request.requestId;
                switch (request.mode) {
                    case 'pause':
                        guidance = 'Your Pause request may already be recorded. Choose Refresh status to check this run. If needed, Retry retained Pause sends the same request; it does not start another run.';
                        break;
                    case 'step':
                        guidance = 'Your Step may already have moved this run to its next safe stopping point. Choose Refresh status to check the saved checkpoint. If it is still unclear, Retry retained action uses the same Step request and checkpoint; it does not start another run or advance it twice.';
                        break;
                    case 'continue':
                        guidance = 'Your Continue may still be running or may already have stopped. Choose Refresh status to check this run. If it is still unclear, Retry retained action uses the same Continue request and checkpoint; it does not start another run or advance it twice.';
                        break;
                    case 'recover':
                        guidance = 'Your saved-response recovery may already have settled the recorded model result. Choose Refresh status to check this run. If it is still unclear, Retry retained recovery uses the same recovery request and checkpoint; it does not call the model or run the next step.';
                        break;
                    default:
                        guidance = 'This workflow control may already be recorded or still be in progress. Choose Refresh status to inspect the run before retrying its retained request and checkpoint.';
                }
                break;
            case 'cancel':
                id = request.requestId;
                guidance = 'Your cancellation request may already be recorded. Choose Refresh status to check this run before requesting cancellation again. Cancellation does not undo work that already happened.';
                break;
            case 'decide':
                guidance = 'Your approval decision may already be recorded. Choose Refresh status, then review the current approval before deciding again. Do not assume the decision was rejected or send a replacement while the result is unclear.';
                break;
            case 'release.create':
                guidance = 'Your publish version may already be saved. Choose Inspect retained release ID to check this exact request before preparing another version.';
                break;
            case 'view':
                guidance = 'The workflow setup could not be checked. Choose Refresh entry readiness to check it again. Checking readiness does not run the workflow.';
                break;
            case 'show':
            case 'runs':
            case 'inspect':
            case 'approval':
                guidance = 'The saved run information could not be loaded. Choose Refresh status for this run, or Refresh list in Past runs. Reading saved information does not restart a workflow or approve a decision.';
                break;
            default:
                guidance = 'Check that the preview is still running, then inspect your saved work before trying again. A missing reply does not prove that the request failed.';
        }
        return Error(`${heading}\n${guidance}${automatic}${reference(id)}`);
    };
    const api = async (path, command, token = session?.token) => {
        const localBootstrap = autoConnect && path === '/v1/preview/local-bootstrap';
        const identity = session, scoped = path === '/v1/preview/operations' && Boolean(identity) && token === identity?.token;
        if (scoped && (sessionNeedsConnection || Date.parse(identity.expiresAt) <= Date.now())) {
            if (!sessionNeedsConnection)
                requireConnection(identity);
            throw Object.assign(Error(reconnectMessage), { notDispatched: true });
        }
        if (!token && !localBootstrap)
            throw Error('Connect this tab first.');
        const observationVersion = scoped ? ++connectionObservationVersion : undefined, pageAtDispatch = privatePageActive;
        const observe = (text) => {
            if (scoped && observationVersion === connectionObservationVersion && identity === session
                && !sessionNeedsConnection && !connectionClosing && pageAtDispatch && privatePageActive
                && Date.parse(identity.expiresAt) > Date.now())
                connectionObservation(text);
        };
        observe('Waiting for a runtime reply. This is not proof of execution or failure.');
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
        let reader;
        let sessionFailure;
        let replyDecoded = false;
        let replyVerified = false;
        try {
            const response = await fetch(path, { method: 'POST', credentials: 'omit', redirect: 'error', signal: controller.signal,
                headers: { ...(!localBootstrap && token ? { Authorization: `Bearer ${token}` } : {}),
                    ...(localBootstrap ? { 'X-Jevable-Instance': instanceId } : {}),
                    'Content-Type': 'application/json', 'X-Jevable-Protocol': protocol }, body: JSON.stringify(command) });
            if (response.headers.get('x-jevable-protocol') !== protocol || !response.headers.get('content-type')?.startsWith('application/json') || !response.body)
                throw Error('Unexpected runtime response; inspect the retained run identity.');
            reader = response.body.getReader();
            const chunks = [];
            let size = 0;
            for (;;) {
                const part = await reader.read();
                if (part.done)
                    break;
                size += part.value.byteLength;
                if (size > 20_000_000)
                    throw Error('Response limit; inspect the same run through the owner API.');
                chunks.push(part.value);
            }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
            const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            if (value === null || typeof value !== 'object' || Array.isArray(value))
                throw Error('Invalid runtime response.');
            replyDecoded = true;
            // A response from an older credential cannot restore data or disconnect
            // the replacement connection, even if it is a successful response.
            if (scoped && (identity !== session || sessionNeedsConnection))
                throw staleSession;
            replyVerified = value.instanceId === instanceId;
            if (replyVerified)
                observe('Last runtime reply verified. This is not a continuous connection check.');
            if (!response.ok) {
                const code = /^[a-z-]{1,64}$/.test(value.code) ? value.code : 'operation-failed';
                if (path === '/v1/preview/bootstrap' && response.status === 401 && code === 'unauthorized')
                    throw rejectedAccessKey;
                if (scoped && response.status === 401 && code === 'unauthorized') {
                    requireConnection(identity);
                    sessionFailure = Object.assign(Error(reconnectMessage), { code, status: response.status });
                    throw sessionFailure;
                }
                throw Object.assign(Error(`Runtime rejected operation: ${code}. Inspect before retrying.`), { code, status: response.status });
            }
            if (value.instanceId !== instanceId)
                throw Error('Runtime instance changed; reconnect explicitly.');
            return value.result;
        }
        catch (error) {
            if (scoped && (identity !== session || sessionNeedsConnection) && error !== sessionFailure)
                throw staleSession;
            if (!replyVerified)
                observe('Connection unconfirmed. Check that the preview is running, then use a read-only refresh. A missing reply does not mean your work failed.');
            if (controller.signal.aborted)
                throw missingReply(command, true);
            if (!replyDecoded)
                throw missingReply(command, false);
            throw error;
        }
        finally {
            clearTimeout(timeout);
            await reader?.cancel().catch(() => { });
            reader?.releaseLock();
        }
    };
    const request = (command) => api('/v1/preview/operations', command);
    const showError = (error) => {
        if (error === staleSession)
            return;
        const localInput = error !== null && typeof error === 'object' && inputErrors.delete(error);
        const text = error instanceof Error ? error.message : 'Operation failed. Inspect retained state.';
        message(text, 'warning');
        if (localInput)
            inputFeedback = text;
    };
    const showReadError = (error) => {
        // A failed status read must not replace the more important warning that
        // an earlier Run/control mutation may already have been admitted.
        if (noticeTone === 'warning' && (current?.status === 'submitting' || session?.pendingControl || session?.pendingPause))
            return;
        showError(error);
    };
    const buttons = () => {
        el('live-run').disabled = !canSubmit() || !entryReady;
        const setAside = el('live-set-aside');
        setAside.hidden = !canSetAsideWaiting();
        setAside.disabled = !canSetAsideWaiting();
        const runGuidance = !connected ? '' : session?.pendingControl || pauseUnresolved()
            ? 'An earlier action is not confirmed. Open Results to inspect it before starting another run.'
            : current?.status === 'waiting'
                ? 'This run is waiting for a decision. Open Approvals to review it, or set it aside below to try another input. Setting it aside does not approve or cancel it.'
                : current?.status === 'paused'
                    ? 'This run is paused. Open Results to continue it, or choose a finished run in Past runs before trying another input.'
                    : current && ['submitting', 'executing', 'loading'].includes(current.status)
                        ? 'This run does not have a final result yet. Open Results and refresh its saved status before trying another input.'
                        : !entryReady ? 'This entry is not ready. Open Advanced to check the selected entry and its readiness.' : '';
        const guidance = el('live-run-guidance');
        // A read-only status refresh can call buttons() with no state change. Do not
        // reinsert identical text into a polite live region and announce it again.
        if (guidance.textContent !== runGuidance)
            guidance.textContent = runGuidance;
        el('live-trigger-mode').disabled = !canSubmit();
        el('live-refresh-readiness').disabled = !canSubmit();
        el('live-start-paused').disabled = el('live-run').disabled;
        el('live-run').textContent = el('live-start-paused').checked ? 'Start paused' : 'Run workflow';
        const canAdvance = connected && session?.runId === current?.id && current?.status === 'paused'
            && /^[a-f0-9]{64}$/.test(current.checkpointSha256 ?? '') && !current.cancellation && !mutation && !pauseUnresolved() && !session?.pendingControl;
        el('live-step').disabled = !canAdvance;
        el('live-continue').disabled = !canAdvance;
        const candidate = recovery(), identity = candidate?.identity ?? '';
        if (identity !== recoveryIdentity || mutation || pauseUnresolved() || session?.pendingControl) {
            recoveryIdentity = identity;
            recoveryConsent = '';
            el('live-recover-authorize').checked = false;
        }
        const canRecover = Boolean(candidate) && !mutation && !pauseUnresolved() && !session?.pendingControl;
        el('live-recover-authorize').disabled = !canRecover;
        el('live-recover').disabled = !canRecover || recoveryConsent !== identity || !el('live-recover-authorize').checked;
        el('live-recover-status').textContent = candidate
            ? `Unsettled model attempt ${candidate.attemptId} at ${candidate.label}. A saved response is not yet proven. The runtime refuses active, unknown or invalid outcomes; it never redispatches. Checkpoint ${candidate.checkpointSha256}.`
            : 'Select an unsettled LLM or Decision attempt in this workflow. Recovery is unavailable for cancelled, non-model or settled attempts.';
        el('live-retry-control').disabled = !connected || mutation || pauseUnresolved() || !session?.pendingControl;
        el('live-retry-control').textContent = session?.pendingControl?.mode === 'recover' ? 'Retry retained recovery' : 'Retry retained action';
        el('live-control-pending').textContent = session?.pendingControl
            ? `Unresolved ${session.pendingControl.mode} request ${session.pendingControl.requestId}. ${session.pendingControl.mode === 'recover'
                ? 'Recovery settles only verified saved evidence; it neither sends a model request nor continues downstream.' : session.pendingControl.breakpoints === undefined
                ? 'Retains runtime breakpoint configuration.' : `Exact breakpoint list: ${session.pendingControl.breakpoints.length ? session.pendingControl.breakpoints.join(', ') : 'clear all'}.`} Refresh only reads; Retry retained action resubmits this exact identity, checkpoint and list.` : '';
        el('live-pause').disabled = !connected || !session?.runId || pauseUnresolved()
            || current?.id !== session.runId || (!['submitting', 'executing', 'paused'].includes(current?.status) && !(mutation && current?.status === 'waiting'))
            || Boolean(current?.cancellation || (current?.pause && !(mutation && current.pause.requestId === pauseAtMutationStart)));
        el('live-retry-pause').disabled = !connected || pauseMutation || !session?.pendingPause;
        el('live-pause-pending').textContent = session?.pendingPause
            ? `Unresolved Pause request ${session.pendingPause.requestId}. Refresh only reads. Retry retained Pause sends the same identity and checkpoint; it never creates another run.` : '';
        el('live-pause-status').textContent = current?.pause ? current.cancellation
            ? 'Cancellation supersedes Pause. Inspect the actual run status; neither action rolls back effects.'
            : current.status === 'paused' ? 'Pause recorded · safe checkpoint. Explicit Step or Continue is required to resume.'
                : current.status === 'executing' ? 'Pause requested · current attempt may be active or uncertain. No abort or rollback; inspect until a safe checkpoint is recorded.'
                    : current.status === 'waiting' ? 'Pause recorded · waiting for Human Approval. A separately authorized decision leaves downstream execution paused.'
                        : 'Pause recorded · run reached a terminal outcome before another checkpoint. Inspect the actual outcome.' : '';
        el('live-history').disabled = !connected || mutation || pauseUnresolved() || Boolean(session?.pendingControl);
        el('live-cancel').disabled = !connected || !session?.runId || ['completed', 'failed', 'cancelled'].includes(current?.status);
        el('live-inspect').disabled = !connected || !session?.runId;
        el('live-private').disabled = !privatePageActive || !connected || !session?.runId;
        el('live-private-clear').disabled = !privatePageActive || !connected || !session?.runId
            || !privateReadPending && !el('live-private-result').textContent;
        el('live-review').disabled = !connected || mutation || pauseUnresolved() || current?.status !== 'waiting';
        const canDecide = Boolean(approvalReview) && !el('live-approval').hidden && connected && !mutation && !pauseUnresolved()
            && session?.runId === approvalReview?.id && current?.status === 'waiting' && current?.attemptId === approvalReview?.attemptId
            && el('live-authorize').checked;
        for (const action of Array.from(el('live-actions').children))
            action.disabled = !canDecide;
        testControls?.buttons();
        testCoverage?.observe();
        modelHistory?.observe();
        notificationHistory?.observe();
        usageControls?.observe();
        nodeInspection?.observe();
        evidenceControls?.observe();
        evidenceBundleControls?.observe();
        releaseControls?.observe();
        projectExportControls?.observe();
        traceControls?.observe();
        breakpointControls?.observe();
    };
    const display = (run, readOnly = false) => {
        clearPrivateResults();
        if (!session || run.id !== session.runId)
            return; // A late read must not replace a newly selected run.
        if (current?.id === run.id && ['completed', 'failed', 'cancelled'].includes(current.status) && current.status !== run.status)
            return;
        if (readOnly && current?.id === run.id && current.status === 'submitting' && run.status !== 'submitting' && noticeTone === 'warning')
            message('Saved status found for this run. Inspect its current outcome; refreshing did not submit another run.');
        const pending = session.pendingControl;
        breakpointControls?.reconcile(run, pending);
        if (pending && pending.id === run.id && (run.lastControl?.requestId === pending.requestId
            || (/^[a-f0-9]{64}$/.test(run.checkpointSha256 ?? '') && run.checkpointSha256 !== pending.expectedCheckpointSha256))) {
            // A recorded admission or changed checkpoint makes this request non-repeatable. Do not infer its outcome.
            delete session.pendingControl;
            retain();
            message('The retained request is recorded or its original checkpoint changed. Inspect current status; no action was replayed by refresh.');
        }
        const pause = session.pendingPause;
        if (pause && pause.id === run.id && (run.lastControl?.requestId === pause.requestId || run.pause?.requestId === pause.requestId
            || (/^[a-f0-9]{64}$/.test(run.checkpointSha256 ?? '') && run.checkpointSha256 !== pause.expectedCheckpointSha256))) {
            delete session.pendingPause;
            retain();
            message('The retained Pause is recorded or its original checkpoint changed. Inspect actual status; refresh did not execute or replay anything.');
        }
        if (run.cancellation?.id) {
            session.cancelId = run.cancellation.id;
            retain();
        }
        if (run.status !== 'waiting' || current?.id !== run.id || current?.attemptId !== run.attemptId) {
            // A completed or different request must not leave an old decision card
            // looking actionable. Status reads never load a new private request.
            el('live-approval').hidden = true;
            el('live-review-data').textContent = '';
            el('live-authorize').checked = false;
            el('live-actions').replaceChildren();
            approvalReview = undefined;
        }
        current = run;
        el('live-result').textContent = JSON.stringify(run, null, 2);
        if (graphController && preview && projectExecution) {
            graphController.setExecution(null); // Never leave another run's highlights behind while loading or rejecting metadata.
            el('live-overlay-error').textContent = '';
            if (!['submitting', 'loading'].includes(run.status)) {
                try {
                    graphController.setExecution(projectExecution(preview, run));
                }
                catch {
                    el('live-overlay-error').textContent = 'Graph evidence unavailable: this receipt cannot be safely mapped to the admitted graph. Inspect the execution receipt; no workflow action was taken.';
                }
            }
        }
        // Only these fixed, already-recorded outcomes are presentation hints. Keep
        // arbitrary failure codes out of the friendly UI and preserve the exact
        // receipt in the closed technical record.
        el('live-status').setAttribute('data-failure-code', run.status === 'failed'
            && (run.code === 'approval-rejected' || run.code === 'approval-expired') ? run.code : '');
        el('live-status').textContent = `Run ${run.id} · ${run.status}${run.triggerMode === 'api' ? ' · recorded API entry' : ''}${run.cancellation ? ` · cancellation ${run.cancellation.status}` : ''}`;
        testControls?.observe();
        buttons();
    };
    const displayMutation = (run) => { readVersion++; display(run); };
    const unadmitted = (id) => {
        if (session?.runId !== id)
            return;
        session.lastRejectedId = id;
        delete session.runId;
        delete session.cancelId;
        delete session.rejectedRunId;
        retain();
        current = undefined;
        clearHistoryFeedback();
        el('live-status').textContent = `Run ${id} was not admitted. Correct the input or setup, then explicitly submit again.`;
    };
    const inspect = async () => {
        if (!session?.runId)
            return;
        clearPrivateResults();
        const version = ++readVersion, run = await request({ operation: 'show', id: session.runId });
        if (version === readVersion) {
            display(run, true);
            return run;
        }
    };
    // Requests can overlap (execution, Pause, cancellation, polling). A response to an older
    // dispatch is not a fresh snapshot. Re-read instead of regressing newer control evidence.
    const receive = async (run, version) => {
        if (version === readVersion)
            displayMutation(run);
        else
            await inspect();
    };
    const watch = () => {
        clearTimeout(timer);
        if (!connected || !session?.runId || ['completed', 'failed', 'cancelled', 'waiting', 'paused'].includes(current?.status) || polls++ >= 600)
            return;
        timer = setTimeout(() => { void inspect().then(watch, showReadError); }, 1000);
    };
    const history = async () => {
        const version = ++historyReadVersion, identity = session, retainedRun = session?.runId, pageAtDispatch = privatePageActive;
        const active = () => version === historyReadVersion && identity === session && Boolean(identity)
            && session?.runId === retainedRun && !sessionNeedsConnection && !connectionClosing && pageAtDispatch && privatePageActive && Date.parse(identity.expiresAt) > Date.now();
        if (active()) {
            el('live-history-status').textContent = 'Loading past runs…';
            el('run-history').setAttribute('aria-busy', 'true');
        }
        try {
            const result = await request({ operation: 'runs' });
            if (!active())
                return;
            if (!Array.isArray(result?.runs))
                throw Error('Invalid saved-run list.');
            // Assemble before replacing: a failed read must leave the last known list
            // and retained selection intact, never a partially changed control.
            const select = el('live-history'), empty = document.createElement('option');
            empty.value = '';
            empty.textContent = 'Choose a past run';
            const choices = [empty];
            const references = new Map();
            for (const run of result.runs) {
                if (!run || typeof run.id !== 'string' || !run.id || typeof run.status !== 'string' || !run.status)
                    throw Error('Invalid saved-run metadata.');
                const short = run.id.slice(0, 8);
                references.set(short, (references.get(short) ?? 0) + 1);
            }
            const labels = { completed: 'Finished', waiting: 'Needs your decision', paused: 'Paused', executing: 'Result not confirmed', failed: 'Needs attention', cancelled: 'Stopped' };
            for (const run of result.runs) {
                const short = run.id.slice(0, 8), reference = references.get(short) > 1 ? run.id : short;
                const option = document.createElement('option');
                option.value = run.id;
                option.title = `Run ${run.id}`;
                option.textContent = `${Object.hasOwn(labels, run.status) ? labels[run.status] : 'Saved run'}${run.test ? ' · saved test' : ''} · ${reference}`;
                choices.push(option);
            }
            select.replaceChildren(...choices);
            if (session?.runId)
                select.value = session.runId;
            el('live-history-status').textContent = result.runs.length
                ? 'Past runs refreshed. Choose a saved run to view it; nothing runs automatically.'
                : 'No past runs yet. Refreshing this list never runs a workflow.';
        }
        catch (error) {
            if (active())
                el('live-history-status').textContent = 'Could not refresh past runs. Check that the preview is running, then choose Refresh list to try the read again. Your saved work has not been changed.';
            throw error; // Existing connection/submission callers retain their guards.
        }
        finally {
            if (active())
                el('run-history').setAttribute('aria-busy', 'false');
        }
    };
    const applyReadiness = (view) => {
        entry = { local: view.entry?.local === true, api: view.entry?.api === true };
        el('live-entry-local').disabled = !entry.local;
        el('live-entry-api').disabled = !entry.api;
        el('live-trigger-mode').value = session?.triggerMode ?? '';
        entryReady = (session?.triggerMode === 'api' ? entry.api : entry.local)
            && view.readiness.runtimeReadiness === 'ready' && view.readiness.triggerMode === session?.triggerMode;
        el('validation').textContent = `Compilation passed · Runtime ${view.readiness.runtimeReadiness} · Execution is recorded separately below`;
        // Use typed preview nodes, never user-authored titles or diagnostic text.
        // Presentation only: the existing runtime/entry admission still owns Run.
        const customUnavailable = view.readiness.runtimeReadiness === 'unavailable'
            && Array.isArray(view.preview?.graphs) && view.preview.graphs.some((graph) => Array.isArray(graph.nodes) && graph.nodes.some((item) => item.node?.type === 'custom'));
        el('live-readiness').textContent = `Selected entry: ${session?.triggerMode === 'api' ? 'explicit API' : 'default manual/chat'}. Runtime: ${view.readiness.runtimeReadiness}.${customUnavailable ? ' Custom execution unavailable.' : ''} Validation is not execution. Browser qualification pending.`;
    };
    const refreshReadiness = async () => {
        const version = ++viewVersion, identity = session;
        entryReady = false;
        buttons();
        try {
            const view = await request({ operation: 'view', ...modeFields() });
            if (version !== viewVersion || identity !== session || !connected)
                return;
            applyReadiness(view);
            buttons();
        }
        catch (error) {
            if (version !== viewVersion || identity !== session || !connected)
                return;
            el('live-readiness').textContent = 'Selected entry readiness unavailable. Refresh entry readiness explicitly; no workflow was submitted.';
            buttons();
            showError(error);
        }
    };
    const connect = async () => {
        connected = false;
        entryReady = false;
        buttons();
        el('live-trigger-mode').value = session?.triggerMode ?? '';
        const version = ++viewVersion, identity = session;
        const view = await request({ operation: 'view', ...modeFields() });
        if (version !== viewVersion || identity !== session)
            return;
        notificationProject = { ...view.project };
        if (!initialized) {
            preview = view.preview;
            graphController = viewer(view.preview, { initialView: 'readable', context: 'live-workspace', onSelect: id => breakpointControls?.select(id),
                onNodeSelect: node => nodeInspection?.select(node) });
            initialized = true;
        }
        // The shared graph viewer sets a static, offline validation label at mount.
        // Restore the connected runtime state after its first initialization.
        applyReadiness(view);
        if (setupBreakpoints && !breakpointControls) {
            breakpointControls = setupBreakpoints({ preview: view.preview, current: () => connected ? current : undefined,
                canEdit: () => connected && !mutation && !pauseUnresolved() && !session?.pendingControl && current?.id === session?.runId
                    && current?.status === 'paused' && !current.cancellation,
                overlay: value => graphController?.setBreakpoints?.(value) });
            el('live-breakpoints').hidden = false;
        }
        el('preview-workspace').hidden = false;
        el('live-login').hidden = true;
        el('live-session').hidden = false;
        el('live-project').textContent = `Dedicated preview project ${view.project.id} · generation ${view.project.generation} · revision ${view.project.revision}. Project and runs remain after shutdown.`;
        el('live-schema').textContent = JSON.stringify(view.inputSchema, null, 2);
        if (!inputInitialized) {
            el('live-input').value = JSON.stringify(view.sample ?? null, null, 2);
            if (setupInput && inputTools)
                inputControls = setupInput(view.inputSchema, inputTools(), inputEdited);
            else
                el('live-input').addEventListener('input', inputEdited);
            inputInitialized = true;
        }
        if (setupTests && !testControls) {
            testControls = setupTests({ request, state: () => session,
                testRun: () => connected && session?.runId === current?.id && current?.test ? current.test : undefined,
                scope: () => connected && session ? JSON.stringify([instanceId, session.token, notificationProject]) : undefined,
                retain, message, error: showError, readInput,
                revision: () => preview?.revision ?? undefined,
                checkpoint: () => connected && session?.runId === current?.id && /^[a-f0-9]{64}$/.test(current?.checkpointSha256 ?? '')
                    ? current.checkpointSha256 : undefined,
                triggerMode: () => session?.triggerMode, canRun: canSubmit,
                run: test => submitRun({ operation: 'tests.run', test, runId: crypto.randomUUID() }) }, projectTestResult);
            el('live-tests').hidden = false;
        }
        if (setupTestCoverage && !testCoverage) {
            testCoverage = setupTestCoverage({ request,
                scope: () => connected && session ? JSON.stringify([instanceId, session.token, notificationProject]) : undefined,
                project: () => connected ? notificationProject : undefined, preview: () => preview, error: showError });
            el('live-test-coverage').hidden = false;
        }
        if (setupModelHistory && projectModelHistory && !modelHistory) {
            modelHistory = setupModelHistory({ request, current: () => connected && preview?.revision && session?.runId && session.runId === current?.id
                    && !['submitting', 'loading'].includes(current.status) ? { runId: session.runId, preview } : undefined }, projectModelHistory);
            el('model-history').hidden = false;
        }
        if (setupNotificationHistory && projectNotifications && !notificationHistory) {
            notificationHistory = setupNotificationHistory({ request, current: () => connected && session && notificationProject
                    ? { project: notificationProject, session: session.token } : undefined }, projectNotifications);
            el('notification-history').hidden = false;
        }
        if (setupUsage && usageTools && !usageControls) {
            usageControls = setupUsage({ request, current: () => connected && session && preview?.revision && session.runId === current?.id
                    && !['submitting', 'loading'].includes(current?.status) ? { runId: session.runId, revision: preview.revision, session: session.token } : undefined }, usageTools());
            el('live-usage').hidden = false;
        }
        if (setupNodeInspection && projectExecution && !nodeInspection) {
            nodeInspection = setupNodeInspection({ request, current: () => connected && preview?.revision && session?.runId && session.runId === current?.id
                    && !['submitting', 'loading'].includes(current?.status) ? { preview, receipt: current, session: session.token } : undefined }, projectExecution);
            el('node-private').hidden = false;
        }
        if (setupEvidence && prepareEvidence && !evidenceControls) {
            evidenceControls = setupEvidence({ request, current: () => connected && preview?.revision && session?.runId && session.runId === current?.id
                    && !['submitting', 'loading'].includes(current.status) ? { runId: session.runId, revision: preview.revision } : undefined }, prepareEvidence);
            el('live-evidence').hidden = false;
        }
        if (setupEvidenceBundle && prepareEvidenceBundle && !evidenceBundleControls) {
            evidenceBundleControls = setupEvidenceBundle({ request,
                changed: () => { releaseControls?.observe(); projectExportControls?.observe(); },
                scope: () => connected && session ? session.token : undefined,
                current: () => connected && preview?.revision && session?.runId && session.runId === current?.id
                    && !['submitting', 'loading'].includes(current.status) ? { runId: session.runId, revision: preview.revision } : undefined,
            }, prepareEvidenceBundle);
            el('live-evidence-bundle').hidden = false;
        }
        if (setupRelease && releaseTools && !releaseControls) {
            releaseControls = setupRelease({ request, storageKey: `${key}.release`, scope: () => connected && session ? session.token : undefined,
                project: () => ({ ...view.project }), evidence: () => evidenceBundleControls?.prepared() }, releaseTools());
            el('live-release').hidden = false;
        }
        if (setupProjectExport && prepareProject && !projectExportControls) {
            projectExportControls = setupProjectExport({ request, scope: () => connected && session ? session.token : undefined,
                project: () => ({ ...view.project }), evidence: () => evidenceBundleControls?.prepared() }, prepareProject);
            el('live-project-export').hidden = false;
        }
        if (setupTraces && navigationTools && prepareEvidence && !traceControls) {
            traceControls = setupTraces({ request, current: () => connected && preview?.revision && session?.runId && session.runId === current?.id
                    && !['submitting', 'loading'].includes(current.status) ? { runId: session.runId, revision: preview.revision } : undefined,
                ...(view.traceViewer ? { viewer: view.traceViewer } : {}) }, navigationTools(), prepareEvidence);
            el('live-traces').hidden = false;
        }
        await history();
        if (version !== viewVersion || identity !== session)
            return;
        if (session?.runId) {
            try {
                await inspect();
            }
            catch (error) {
                // A saved definitive refusal is not absence proof. Only this fresh
                // scoped read can establish that the original run was not admitted.
                if (error && typeof error === 'object' && 'code' in error && error.code === 'not-found' && session?.runId === session?.rejectedRunId)
                    unadmitted(session.runId);
                else
                    throw error;
            }
        }
        if (version !== viewVersion || identity !== session)
            return;
        connected = true;
        buttons();
        message('Session open. Opening and refreshing never execute a workflow.');
        watch();
        await testControls?.refresh();
    };
    el('live-trigger-mode').addEventListener('change', () => {
        if (!canSubmit()) {
            el('live-trigger-mode').value = session?.triggerMode ?? '';
            return;
        }
        const value = el('live-trigger-mode').value, previous = session.triggerMode;
        if (value !== '' && value !== 'api' || value === 'api' && !entry.api || value === '' && !entry.local) {
            el('live-trigger-mode').value = previous ?? '';
            showError(Error('This entry is not declared by the workflow.'));
            return;
        }
        try {
            if (value === 'api')
                session.triggerMode = 'api';
            else
                delete session.triggerMode;
            retain();
        }
        catch (error) {
            if (previous === 'api')
                session.triggerMode = 'api';
            else
                delete session.triggerMode;
            el('live-trigger-mode').value = previous ?? '';
            showError(error);
            return;
        }
        message('Entry selection saved for new workflow runs and new generation batches only. No workflow executed; saved cases and existing runs are unchanged.');
        void refreshReadiness();
    });
    el('live-refresh-readiness').addEventListener('click', () => { if (canSubmit())
        void refreshReadiness(); });
    const attemptConnection = async (work) => {
        if (connectionPending || keyFilePending)
            return;
        connectionClosing = false;
        resetConnectionObservation('Runtime connection not checked yet.');
        clearHistoryFeedback();
        connectionPending = true;
        const button = el('live-connect'), input = el('live-token');
        const keyFile = el('live-token-file');
        button.disabled = true;
        input.disabled = true;
        keyFile.disabled = true;
        button.textContent = 'Connecting…';
        el('live-login').setAttribute('aria-busy', 'true');
        el('live-connect-error').textContent = '';
        el('live-key-file-status').textContent = '';
        message('Connecting to your private workspace. Connecting does not start a workflow.');
        try {
            await work();
        }
        catch (error) {
            if (error === staleSession && !sessionNeedsConnection)
                return;
            connected = false;
            entryReady = false;
            readVersion++;
            viewVersion++;
            clearTimeout(timer);
            el('live-login').hidden = false;
            el('live-session').hidden = true;
            el('preview-workspace').hidden = true;
            buttons();
            const text = error === missingAccessKey
                ? 'Choose your access-key file or paste its key before connecting. Nothing was submitted.'
                : error === malformedAccessKey
                    ? 'That access key is incomplete or invalid. Please choose its access-key file or paste the key again. Nothing was submitted.'
                    : error === rejectedAccessKey
                        ? 'Could not connect: this access key was not accepted. Choose the key file for this workspace and try again. Your saved work is still here; nothing runs again automatically.'
                        : sessionNeedsConnection ? reconnectMessage : autoConnect
                            ? 'Could not connect. Check that the local preview is still running, then choose Connect to try again. Connecting does not start a workflow.'
                            : 'Could not connect. Check that the preview is still running, then choose its access-key file or paste the key again. Connecting does not start a workflow.';
            el('live-connect-error').textContent = text;
            message(text);
        }
        finally {
            connectionPending = false;
            button.disabled = false;
            input.disabled = false;
            keyFile.disabled = false;
            button.textContent = 'Connect';
            el('live-login').setAttribute('aria-busy', 'false');
            if (!el('live-login').hidden)
                (autoConnect ? button : input).focus();
        }
    };
    el('live-token-file').addEventListener('change', () => {
        void (async () => {
            if (connectionPending || keyFilePending)
                return;
            const picker = el('live-token-file'), files = picker.files, count = files?.length ?? 0;
            const file = count === 1 ? files[0] : undefined;
            picker.value = ''; // Do not retain or display the selected filename/path.
            if (!count)
                return; // Cancelling the picker leaves manually entered text untouched.
            const input = el('live-token'), button = el('live-connect');
            const status = el('live-key-file-status'), error = el('live-connect-error');
            input.value = '';
            status.textContent = '';
            error.textContent = '';
            keyFilePending = true;
            picker.disabled = true;
            input.disabled = true;
            button.disabled = true;
            el('live-login').setAttribute('aria-busy', 'true');
            let loaded = false;
            try {
                // Read only a tiny user-selected blob, never upload the file or discover another key.
                if (!file || !Number.isSafeInteger(file.size) || file.size < 64 || file.size > 256)
                    throw Error('invalid-key-file');
                status.textContent = 'Reading your access-key file…';
                const token = (await file.slice(0, 257).text()).trim();
                if (!/^[a-f0-9]{64}$/.test(token))
                    throw Error('invalid-key-file');
                input.value = token;
                loaded = true;
                status.textContent = 'Key loaded. Choose Connect to open your workflow.';
            }
            catch {
                status.textContent = '';
                input.value = '';
                error.textContent = 'That file could not be used as an access key. Choose the small private key file created for this preview, or paste its key below.';
            }
            finally {
                keyFilePending = false;
                picker.disabled = false;
                input.disabled = false;
                button.disabled = false;
                el('live-login').setAttribute('aria-busy', 'false');
                if (!el('live-login').hidden)
                    (loaded ? button : input).focus();
            }
        })();
    });
    const establishSession = async () => {
        const input = el('live-token'), token = input.value.trim();
        input.value = '';
        if (!autoConnect && token === '')
            throw missingAccessKey;
        if (!autoConnect && !/^[a-f0-9]{64}$/.test(token))
            throw malformedAccessKey;
        const result = await api(autoConnect ? '/v1/preview/local-bootstrap' : '/v1/preview/bootstrap', {}, autoConnect ? undefined : token);
        if (!/^[a-f0-9]{64}$/.test(result?.token ?? '') || !Number.isFinite(Date.parse(result?.expiresAt)) || Date.parse(result.expiresAt) <= Date.now())
            throw Error('Invalid connection credential response; inspect retained state.');
        session = { ...session, token: result.token, expiresAt: result.expiresAt };
        delete session.reconnectRequired;
        sessionNeedsConnection = false;
        retain();
        scheduleExpiry();
        sessionStorage.removeItem(disconnectedKey);
        await connect();
    };
    el('live-connect').addEventListener('click', () => { void attemptConnection(establishSession); });
    el('live-token').addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.isComposing)
            return;
        event.preventDefault();
        el('live-connect').click();
    });
    el('live-logout').addEventListener('click', () => {
        void (async () => {
            // Preserve explicit disconnect across refresh; reconnect requires a new click.
            if (autoConnect)
                sessionStorage.setItem(disconnectedKey, 'true');
            clearTimeout(timer);
            clearExpiryTimer();
            viewVersion++;
            connected = false;
            entryReady = false;
            clearPrivateResults();
            buttons();
            connectionClosing = true;
            resetConnectionObservation('Session closing. Nothing runs automatically.');
            clearHistoryFeedback();
            try {
                await api('/v1/preview/logout', {});
            }
            finally {
                try {
                    releaseControls?.disconnect();
                }
                finally {
                    sessionStorage.removeItem(key);
                    session = undefined;
                    location.reload();
                }
            }
        })().catch(showError);
    });
    const submitRun = async (command) => {
        // Accepted cases use their reviewed mode, independent of new-run selector readiness.
        if (!session || !canSubmit() || command.operation === 'run' && !entryReady)
            throw Error('Inspect the active run and selected entry readiness before submitting another.');
        if (Date.parse(session.expiresAt) <= Date.now()) {
            requireConnection(session);
            throw Error(reconnectMessage);
        }
        const id = command.operation === 'run' ? command.id : command.runId;
        session.runId = id;
        delete session.cancelId;
        delete session.rejectedRunId;
        retain(); // Retain identity before dispatch; never auto-replay on refresh.
        clearHistoryFeedback();
        message(''); // Earlier input errors or another test's assessment do not describe this new run.
        current = { id, status: 'submitting' };
        pauseAtMutationStart = undefined;
        mutation = true;
        polls = 0;
        displayMutation(current);
        watch();
        clearPrivateResults();
        el('live-approval').hidden = true;
        const version = readVersion;
        try {
            const result = await request(command);
            await receive(command.operation === 'tests.run' ? result.run : result, version);
            await history();
            return result;
        }
        catch (error) {
            if (error && typeof error === 'object' && 'notDispatched' in error && error.notDispatched === true)
                unadmitted(id);
            // Only a definitive server response followed by a missing record proves no run was admitted.
            if (error && typeof error === 'object' && 'status' in error) {
                if (session?.runId === id) {
                    session.rejectedRunId = id;
                    retain();
                }
                try {
                    await inspect();
                }
                catch (inspection) {
                    if (inspection && typeof inspection === 'object' && 'code' in inspection && inspection.code === 'not-found' && session?.runId === id) {
                        unadmitted(id);
                    }
                }
            }
            throw error;
        }
        finally {
            mutation = false;
            pauseAtMutationStart = undefined;
            buttons();
            watch();
        }
    };
    el('live-run').addEventListener('click', () => {
        void (async () => {
            if (!session || mutation || el('live-run').disabled)
                return;
            await submitRun({ operation: 'run', input: readInput(), id: crypto.randomUUID(),
                paused: el('live-start-paused').checked, ...modeFields() });
        })().catch(showError);
    });
    el('live-start-paused').addEventListener('change', buttons);
    const advance = async (mode) => {
        if (!session || !connected || mutation || pauseUnresolved())
            return;
        if (mode && el(`live-${mode}`).disabled)
            return;
        if (mode === 'recover' && (!recovery() || recoveryConsent !== recovery().identity || !el('live-recover-authorize').checked))
            return;
        if (!mode && !session.pendingControl)
            return;
        const command = mode ? { id: session.runId, requestId: crypto.randomUUID(), expectedCheckpointSha256: current.checkpointSha256, mode,
            ...(mode === 'recover' ? {} : breakpointControls?.fields()) }
            : { ...session.pendingControl };
        if (command.id !== session.runId)
            throw Error('Inspect the retained action’s original run before retrying.');
        if (command.breakpoints !== undefined) {
            if (!breakpointControls)
                throw Error('Breakpoint controls unavailable; inspect this retained action through the owner API.');
            command.breakpoints = breakpointControls.validate(command.breakpoints);
        }
        pauseAtMutationStart = current?.pause?.requestId;
        mutation = true;
        const version = ++readVersion;
        clearTimeout(timer);
        try {
            session.pendingControl = command;
            retain();
            buttons(); // No dispatch if identity retention fails.
            el('live-approval').hidden = true;
            clearPrivateResults();
            const result = await request({ operation: 'advance', ...command });
            await receive(result, version);
            if (session?.pendingControl?.requestId === command.requestId) {
                delete session.pendingControl;
                retain();
            }
            await history();
        }
        catch (error) {
            // A definitive rejection plus a fresh unchanged checkpoint proves this request was not admitted.
            // Transport failures retain the exact identity; neither path retries or changes its guard.
            if (command.mode === 'recover' && error && typeof error === 'object' && 'status' in error
                && typeof error.status === 'number' && error.status >= 400 && error.status < 500) {
                try {
                    const observed = await inspect();
                    if (observed?.id === command.id && observed.checkpointSha256 === command.expectedCheckpointSha256
                        && session?.pendingControl?.requestId === command.requestId && current?.id === command.id
                        && current.checkpointSha256 === command.expectedCheckpointSha256) {
                        delete session.pendingControl;
                        retain();
                    }
                }
                catch { /* Uncertain inspection keeps the retained request available for explicit retry. */ }
            }
            throw error;
        }
        finally {
            mutation = false;
            pauseAtMutationStart = undefined;
            buttons();
            polls = 0;
            watch();
        }
    };
    el('live-step').addEventListener('click', () => { void advance('step').catch(showError); });
    el('live-continue').addEventListener('click', () => { void advance('continue').catch(showError); });
    el('live-recover-authorize').addEventListener('change', () => {
        recoveryConsent = !el('live-recover-authorize').disabled && el('live-recover-authorize').checked
            ? recovery()?.identity ?? '' : '';
        buttons();
    });
    el('live-recover').addEventListener('click', () => { void advance('recover').catch(showError); });
    el('live-retry-control').addEventListener('click', () => { void advance().catch(showError); });
    const pause = async (retry = false) => {
        if (!session || !connected || pauseMutation || el(retry ? 'live-retry-pause' : 'live-pause').disabled)
            return;
        const id = session.runId;
        pauseMutation = true;
        readVersion++;
        clearTimeout(timer);
        buttons();
        try {
            let command = session.pendingPause;
            if (!retry) {
                // Explicit Pause intent allows a status read, not a guessed or automatically refreshed guard.
                const observedVersion = ++readVersion, observed = await request({ operation: 'show', id });
                if (!connected || session?.runId !== id)
                    return;
                if (observedVersion === readVersion)
                    display(observed);
                if (observed.id !== id || !['paused', 'executing'].includes(observed.status) || observed.cancellation || observed.pause) {
                    await inspect();
                    message('Pause was not submitted. Inspect the current run status; it may already be waiting, stopped or terminal.');
                    return;
                }
                if (!/^[a-f0-9]{64}$/.test(observed.checkpointSha256 ?? ''))
                    throw Error('Pause requires a valid retained checkpoint. Inspect through the owner API.');
                command = { id, requestId: crypto.randomUUID(), expectedCheckpointSha256: observed.checkpointSha256, mode: 'pause' };
            }
            if (!command || command.id !== id)
                throw Error('Inspect the retained Pause’s original run before retrying.');
            session.pendingPause = { ...command };
            retain();
            buttons(); // Separate from an in-flight Step/Continue; save before dispatch.
            const version = ++readVersion;
            const result = await request({ operation: 'advance', ...command });
            await receive(result, version);
        }
        finally {
            pauseMutation = false;
            buttons();
            polls = 0;
            watch();
        }
    };
    el('live-pause').addEventListener('click', () => { void pause().catch(showError); });
    el('live-retry-pause').addEventListener('click', () => { void pause(true).catch(showError); });
    el('live-inspect').addEventListener('click', () => { void inspect().then(() => { polls = 0; watch(); }, showReadError); });
    el('live-private').addEventListener('click', () => {
        void (async () => {
            const id = session?.runId, version = readVersion;
            if (!privatePageActive || !connected || !id)
                return;
            const privateVersion = ++privateReadVersion;
            privateReadPending = true;
            el('live-private-status').textContent = 'Loading saved values…';
            buttons();
            const active = () => privatePageActive && connected && session?.runId === id
                && version === readVersion && privateVersion === privateReadVersion;
            try {
                const result = await request({ operation: 'inspect', id });
                if (!active())
                    return;
                el('live-private-result').textContent = JSON.stringify(result, null, 2);
                el('live-private-status').textContent = 'Saved values loaded. Hide them before sharing your screen.';
            }
            catch {
                if (active())
                    el('live-private-status').textContent = 'Saved values unavailable. Refresh status, then choose Show inputs and output to try again. Nothing was run or deleted.';
            }
            finally {
                if (privateVersion === privateReadVersion) {
                    privateReadPending = false;
                    buttons();
                }
            }
        })();
    });
    el('live-private-clear').addEventListener('click', () => {
        clearPrivateResults('Values hidden. Your saved results have not been deleted.');
        buttons();
    });
    browserWindow?.addEventListener('pagehide', () => {
        privatePageActive = false;
        resetConnectionObservation('Connection not checked since leaving this page. Use a read-only refresh to check again.');
        clearHistoryFeedback();
        clearPrivateResults();
        buttons();
    });
    browserWindow?.addEventListener('pageshow', () => { privatePageActive = true; buttons(); });
    el('live-cancel').addEventListener('click', () => {
        void (async () => {
            if (!session?.runId)
                return;
            session.cancelId ??= crypto.randomUUID();
            retain();
            message('');
            const version = ++readVersion;
            await receive(await request({ operation: 'cancel', id: session.runId, requestId: session.cancelId }), version);
            polls = 0;
            watch();
        })().catch(showError);
    });
    el('live-review').addEventListener('click', () => {
        void (async () => {
            if (!session?.runId || !connected || mutation || pauseUnresolved() || current?.status !== 'waiting')
                return;
            const review = await request({ operation: 'approval', id: session.runId });
            if (review.id !== session?.runId || current?.status !== 'waiting' || current?.attemptId !== review.attemptId)
                return;
            if (review.deadlineStatus !== 'open-at-observation' && review.deadlineStatus !== 'expired-at-observation')
                throw Error('Request deadline status is unavailable. Refresh and review the saved request before acting.');
            if (review.timeoutOutcome !== 'expired' && review.timeoutOutcome !== 'branch')
                throw Error('Request timeout route is unavailable. Refresh and review the saved request before acting.');
            const expireOnly = review.deadlineStatus === 'expired-at-observation';
            const timeoutBranch = review.timeoutOutcome === 'branch';
            el('live-approval').hidden = false;
            el('live-review-data').textContent = JSON.stringify(review.review, null, 2);
            approvalReview = { id: review.id, attemptId: review.attemptId, expireOnly };
            el('live-approval-title').textContent = expireOnly ? 'Review time ended' : 'Make your decision';
            el('live-approval-confirmation').textContent = expireOnly
                ? timeoutBranch ? 'I have read this request and want to record its timeout, then review the next step.'
                    : 'I have read this request and want to close it as expired.' : "I've read this request and am ready to decide.";
            el('live-approval-help').textContent = expireOnly
                ? timeoutBranch
                    ? 'The deadline had passed when the runtime checked. This records the timeout and pauses before the next step. Continuing the timeout path later is a separate action that may run more steps. It never approves this request; if the deadline is no longer past, the runtime refuses.'
                    : 'The deadline had passed when the runtime checked. Closing this request records expiry, not approval, and runs no later steps. If the deadline is no longer past, the runtime refuses this action.'
                : 'Approve continues only if the deadline is still open. If it passes before your action reaches the runtime, the request expires instead. Reject follows its configured path.';
            el('live-authorize').checked = false;
            el('live-pause-after').checked = current?.startedPaused === true;
            el('live-approval-options').hidden = expireOnly;
            el('live-approval-options').open = !expireOnly && current?.startedPaused === true;
            const actions = el('live-actions');
            actions.replaceChildren();
            for (const action of expireOnly ? review.actions.slice(0, 1) : review.actions) {
                const button = document.createElement('button');
                button.textContent = expireOnly
                    ? timeoutBranch ? 'Record timeout and pause' : 'Close as expired'
                    : action === 'approve' ? 'Approve' : action === 'reject' ? 'Reject' : action;
                button.addEventListener('click', () => {
                    void (async () => {
                        if (!connected || mutation || pauseUnresolved() || session?.runId !== review.id || current?.status !== 'waiting' || current?.attemptId !== review.attemptId)
                            throw Error('Refresh and review the current waiting attempt before deciding.');
                        if (!el('live-authorize').checked)
                            throw Error('Tick the review confirmation before choosing a decision.');
                        const pauseAfter = expireOnly ? timeoutBranch : el('live-pause-after').checked;
                        button.disabled = true;
                        el('live-authorize').checked = false;
                        pauseAtMutationStart = current?.pause?.requestId;
                        mutation = true;
                        const version = ++readVersion;
                        buttons();
                        message('');
                        try {
                            await receive(await request({ operation: 'decide', id: review.id, attemptId: review.attemptId, action, pauseAfter,
                                ...(expireOnly ? { expireOnly: true } : {}) }), version);
                            el('live-approval').hidden = true;
                            approvalReview = undefined;
                            polls = 0;
                            watch();
                        }
                        finally {
                            mutation = false;
                            pauseAtMutationStart = undefined;
                            button.disabled = false;
                            buttons();
                        }
                    })().catch(showError);
                });
                actions.append(button);
            }
            buttons();
        })().catch(showError);
    });
    el('live-authorize').addEventListener('change', buttons);
    el('live-set-aside').addEventListener('click', () => {
        if (!canSetAsideWaiting() || !session)
            return;
        const waitingRunId = session.runId;
        delete session.runId;
        try {
            retain();
        }
        catch (error) {
            session.runId = waitingRunId;
            showError(error);
            return;
        }
        clearTimeout(timer);
        readVersion++;
        clearHistoryFeedback();
        current = undefined;
        approvalReview = undefined;
        clearPrivateResults();
        el('live-approval').hidden = true;
        el('live-review-data').textContent = '';
        el('live-actions').replaceChildren();
        el('live-authorize').checked = false;
        el('live-pause-after').checked = false;
        el('live-history').value = '';
        el('live-result').textContent = 'No execution selected.';
        el('live-status').setAttribute('data-failure-code', '');
        el('live-status').textContent = 'No run selected.';
        el('live-overlay-error').textContent = '';
        graphController?.setExecution?.(null);
        testControls?.observe();
        message('The request is still waiting in Past runs. Nothing was approved, cancelled or started. Review your input before a separate Run action.');
        buttons();
    });
    // This explicit read owns its local feedback. It must not replace or dismiss
    // a global unresolved run/control/approval warning, even after succeeding.
    el('live-refresh-history').addEventListener('click', () => { void history().catch(() => { }); });
    el('live-history').addEventListener('change', () => {
        void (async () => {
            const id = el('live-history').value;
            if (!session || !id || mutation || pauseUnresolved() || session.pendingControl)
                return;
            clearTimeout(timer);
            readVersion++;
            session.runId = id;
            delete session.cancelId;
            retain();
            clearHistoryFeedback();
            message(''); // Selection is read-only; discard feedback belonging to the previous operation.
            current = { id, status: 'loading' };
            displayMutation(current);
            clearPrivateResults();
            el('live-approval').hidden = true;
            await inspect();
        })().catch(showError);
    });
    try {
        const retained = JSON.parse(sessionStorage.getItem(key) ?? 'null');
        if (retained) {
            if (!/^[a-f0-9]{64}$/.test(retained.token) || !Number.isFinite(Date.parse(retained.expiresAt)))
                throw Error('Invalid retained connection identity.');
            if (retained.reconnectRequired !== undefined && retained.reconnectRequired !== true)
                throw Error('Invalid retained connection state.');
            if (retained.rejectedRunId !== undefined && (retained.rejectedRunId !== retained.runId
                || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(retained.rejectedRunId)))
                throw Error('Invalid retained rejection identity.');
            if ((retained.triggerMode !== undefined && retained.triggerMode !== 'api')
                || (retained.batchTriggerMode !== undefined && retained.batchTriggerMode !== 'api'))
                throw Error('Invalid retained entry mode.');
            if (retained.pendingPause && (retained.pendingPause.id !== retained.runId
                || Object.keys(retained.pendingPause).some(name => !['id', 'requestId', 'expectedCheckpointSha256', 'mode'].includes(name))
                || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(retained.pendingPause.id ?? '')
                || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(retained.pendingPause.requestId ?? '')
                || !/^[a-f0-9]{64}$/.test(retained.pendingPause.expectedCheckpointSha256 ?? '')
                || retained.pendingPause.mode !== 'pause'))
                throw Error('Invalid retained Pause identity.');
            if (retained.pendingControl && (retained.pendingControl.id !== retained.runId
                || Object.keys(retained.pendingControl).some(name => !['id', 'requestId', 'expectedCheckpointSha256', 'mode', 'breakpoints'].includes(name))
                || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(retained.pendingControl.requestId ?? '')
                || !/^[a-f0-9]{64}$/.test(retained.pendingControl.expectedCheckpointSha256 ?? '')
                || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(retained.pendingControl.id ?? '')
                || !['step', 'continue', 'recover'].includes(retained.pendingControl.mode)
                || (retained.pendingControl.mode === 'recover' && retained.pendingControl.breakpoints !== undefined)
                || (retained.pendingControl.breakpoints !== undefined && (!Array.isArray(retained.pendingControl.breakpoints)
                    || retained.pendingControl.breakpoints.length > 128 || retained.pendingControl.breakpoints.some((id) => typeof id !== 'string' || !id || id.length > 128)
                    || new Set(retained.pendingControl.breakpoints).size !== retained.pendingControl.breakpoints.length))))
                throw Error('Invalid retained control identity.');
            session = retained;
            if (retained.reconnectRequired || Date.parse(retained.expiresAt) <= Date.now())
                requireConnection(session);
            else {
                scheduleExpiry();
                void attemptConnection(connect);
            }
        }
        else if (autoConnect && sessionStorage.getItem(disconnectedKey) !== 'true')
            void attemptConnection(establishSession);
    }
    catch {
        message('Tab storage unavailable or retained entry/control identity invalid. Inspect through the owner API; identity retention is required before execution.');
    }
    browserWindow?.addEventListener('pagehide', clearExpiryTimer);
    browserWindow?.addEventListener('pageshow', scheduleExpiry);
    browserWindow?.addEventListener('focus', scheduleExpiry);
    buttons();
}
export function renderLivePage(instanceId, protocol, credential = 'owner', autoConnect = false) {
    const style = previewCss + `
[hidden]{display:none!important}.live{margin:18px 30px}.live textarea{display:block;width:100%;min-height:110px;font:13px/1.5 ui-monospace,monospace;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:12px}.live-controls{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}.live-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.live-grid>*{min-width:0}#live-status,#live-project{overflow-wrap:anywhere}#live-message{white-space:pre-wrap}@media(max-width:900px){.live-grid{grid-template-columns:1fr}.live{margin:14px 18px}}
#model-history-summary,#model-history-calls{overflow-wrap:anywhere}#model-history-calls details{border-top:1px solid var(--line);padding:14px 0}#model-history-calls summary{cursor:pointer;font-weight:600}.model-history-scroll{overflow-x:auto}.model-history-scroll:focus-visible{outline:2px solid var(--accent)}.model-history-scroll table{border-collapse:collapse;width:100%;min-width:850px}.model-history-scroll caption{text-align:left;padding:8px 0}.model-history-scroll th,.model-history-scroll td{text-align:left;vertical-align:top;padding:10px;border:1px solid var(--line);white-space:pre-wrap;font-size:12px}.model-history-scroll th{font-weight:600}
.schema-field{min-width:0;border:1px solid var(--line);border-radius:8px;margin:10px 0;padding:12px}.schema-field legend,.schema-field p,.schema-field label{overflow-wrap:anywhere}.schema-field legend{font-weight:600}.schema-field>label{display:block;margin:6px 0}.schema-field>input[type=checkbox]+label{display:inline;margin-left:8px}.schema-field textarea{min-height:70px}.schema-field p,#input-message{color:var(--muted)}#input-modes button[aria-pressed=true]{border-color:var(--accent);font-weight:700}
#notification-history-summary,#notification-history-records{overflow-wrap:anywhere}
#notification-history fieldset{min-width:0;border:1px solid var(--line);border-radius:8px;padding:12px;margin:12px 0}#notification-history .live-grid label{display:grid;gap:6px}#notification-history input,#notification-history select{width:100%}
#live-usage{overflow-wrap:anywhere}#live-usage fieldset{min-width:0;border:1px solid var(--line);border-radius:8px;padding:12px;margin:12px 0}#live-usage .live-grid label{display:grid;gap:6px}#live-usage input,#live-usage select{width:100%}
#bundle-review,#bundle-full-review{margin:16px 0;padding:18px;border:1px solid var(--line);border-radius:12px;background:var(--soft);overflow-wrap:anywhere}#bundle-review h3,#bundle-full-review h3{font-size:16px;margin:0 0 8px}#bundle-review p,#bundle-full-review p{font-size:12px;line-height:1.6;margin:0 0 12px;color:var(--muted)}#bundle-review-list{margin:0;padding-left:22px}#bundle-review-list li{padding:8px 0;line-height:1.5}#bundle-review-list li+li{border-top:1px solid var(--line)}#bundle-full-list details{border-top:1px solid var(--line);padding:10px 0}#bundle-full-list details details{margin:8px 0 0 18px;border-top:0}#bundle-full-list summary{cursor:pointer;font-weight:600}#bundle-full-list ol{margin:8px 0;padding-left:24px}#bundle-full-list li{padding:3px 0}#bundle-full-list pre{max-height:420px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}#bundle-technical{margin:12px 0}#bundle-technical pre{max-height:240px}
#live-breakpoints{border-top:1px solid var(--line);margin-top:16px;padding-top:12px;overflow-wrap:anywhere}#breakpoint-node{max-width:100%;width:100%}#breakpoint-hit{font-weight:600}.breakpoint-label{font:11px system-ui;fill:var(--ink);paint-order:stroke;stroke:var(--panel);stroke-width:3px}.node[data-breakpoint=hit] rect{stroke:#b77914;stroke-width:4;stroke-dasharray:2 3}
` + workspaceCss;
    const literal = (value) => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
    const script = `(${livePreviewBrowser.toString()})(${previewViewer.toString()},${literal(instanceId)},${literal(protocol)},${liveTestControls.toString()},${projectPreviewExecution.toString()},${liveModelHistoryControls.toString()},${projectPreviewModelHistory.toString()},${liveInputControls.toString()},${schemaInputTools.toString()},${liveEvidenceControls.toString()},${prepareEvidenceDownload.toString()},${liveTraceControls.toString()},${traceNavigationTools.toString()},${liveBreakpointControls.toString()},${previewRecoveryTarget.toString()},${liveEvidenceBundleControls.toString()},${prepareEvidenceBundleDownload.toString()},${liveReleaseControls.toString()},${previewReleaseTools.toString()},${liveProjectExportControls.toString()},${prepareProjectDownload.toString()},${liveNodeInspectionControls.toString()},${liveNotificationHistoryControls.toString()},${projectPreviewNotificationHistory.toString()},${liveUsageControls.toString()},${previewUsageTools.toString()},${liveTestCoverageControls.toString()},${projectPreviewTestResult.toString()},${autoConnect === true});`;
    const hash = (value) => createHash('sha256').update(value).digest('base64');
    // React/Motion are bundled, never loaded from a CDN. Keep strict hash-based CSP.
    const workspace = workspaceScript.replaceAll('</script', '<\\/script');
    const csp = `default-src 'none'; script-src 'sha256-${hash(script)}' 'sha256-${hash(workspace)}'; style-src 'sha256-${hash(style)}'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Jevable · Live workflow preview</title><style>${style}</style></head><body>
<div id="workspace-root"></div><div id="workspace-original">
<div id="app-heading"><h1 id="workflow-title">Your workflow</h1></div>
<section class="panel live" id="live-login" aria-busy="false" data-auto-connect="${autoConnect === true}"><h2>Open your private workflow</h2><p>${autoConnect ? 'Automatic local connection is enabled for this workflow. No access key needs to be entered in the browser. This mode trusts other processes on this computer.' : credential === 'preview' ? 'Choose the private preview key file provided when this workspace started, never the management token.' : 'Choose the private access-key file provided when this workspace started.'}</p><div id="live-key-fields"${autoConnect ? ' hidden' : ''}><label for="live-token-file">Choose access-key file</label><input id="live-token-file" type="file" aria-describedby="live-key-file-status live-connect-help live-connect-error"><p id="live-key-file-status" role="status"></p><label for="live-token">${credential === 'preview' ? 'Or paste your preview access key' : 'Or paste your owner access key'}</label><input id="live-token" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your access key" aria-describedby="live-connect-help live-connect-error"></div><p id="live-connect-error" role="alert"></p><button id="live-connect" type="button">Connect</button><p class="connection-help" id="live-connect-help">${autoConnect ? 'After disconnecting, choose Connect to open this workflow again. Opening or refreshing never runs it.' : 'Your selected file is read only in this tab, not uploaded. Choose Connect or press Enter to open the workflow. Connecting does not run it.'}</p></section>
<section id="live-notices" aria-live="polite"><p id="live-connection-status" role="status">Runtime connection not checked yet.</p><p id="live-message">Connect to view your workflow.</p><p id="live-status">No run selected.</p><p id="live-overlay-error"></p></section>
<section class="panel live" id="live-session" hidden>
<div id="session-details"><h2>Connection and workflow</h2><p id="live-project"></p><p id="identity"></p><p id="validation"></p><p id="live-readiness"></p><button id="live-logout">Disconnect and clear this tab</button><details><summary>Input contract</summary><pre id="live-schema"></pre></details>
<label for="live-trigger-mode">Entry for new workflow runs and candidate generation</label><select id="live-trigger-mode" aria-describedby="live-entry-help" disabled><option id="live-entry-local" value="">Default manual/chat</option><option id="live-entry-api" value="api" disabled>Explicit API</option></select>
<button id="live-refresh-readiness" disabled>Refresh entry readiness</button>
<p id="live-entry-help">Choose a declared entry explicitly. Selection refreshes readiness only; it does not execute, change an existing run or edit saved cases. API selection does not create public ingress or grant approval authority.</p></div>
<div id="run-input" tabindex="-1" role="region" aria-label="Workflow input">${inputControlsHtml}<details class="advanced-fold"><summary>Run options</summary>
<label><input type="checkbox" id="live-start-paused">Start this new workflow paused before its first node (saved tests are unaffected).</label>
</details><p class="run-safety">Running may use paid services or make changes outside this app.</p><p id="live-run-guidance" class="run-guidance" role="status"></p><div class="live-controls run-actions"><button id="live-run" aria-describedby="live-run-guidance" disabled>Run workflow</button><button id="live-set-aside" type="button" hidden disabled>Set this waiting request aside</button></div></div>
<div id="run-debug">
<h3>Checkpoint controls · real execution</h3><p>Step executes at most one transition; Continue runs until a breakpoint, wait, terminal result or limit. Either action applies a reviewed breakpoint draft if present. Neither approves a gate. Loop deadlines continue during pauses.</p>
<div class="live-controls"><button id="live-step" disabled>Step once</button><button id="live-continue" disabled>Continue</button><button id="live-retry-control" disabled>Retry retained action</button></div><p id="live-control-pending"></p>
<p>Pause requests a stop before the next node; the current node may finish, fail, or remain uncertain. It does not abort or roll back work. Refresh never resumes execution.</p>
<div class="live-controls"><button id="live-pause" disabled>Request Pause</button><button id="live-retry-pause" disabled>Retry retained Pause</button></div><p id="live-pause-pending"></p><p id="live-pause-status" role="status"></p>
<section aria-label="Recover a saved model response"><h3>Recover saved response · no model redispatch</h3>
<p>If a model reply was saved but its node result was not, recovery verifies that evidence and settles this attempt only. It does not resolve an unknown provider outcome, repair storage ownership, approve a gate or run downstream nodes. Inspect the result before a separate Step or Continue.</p>
<p id="live-recover-status" role="status"></p><label><input id="live-recover-authorize" type="checkbox" disabled>I authorize settlement from verified saved evidence for the displayed checkpoint only.</label>
<div class="live-controls"><button id="live-recover" disabled>Recover saved response</button></div></section>
${breakpointControlsHtml}</div>
<div id="run-history"><h2>Past runs</h2><label for="live-history">Choose a saved run</label><select id="live-history"></select><button id="live-refresh-history">Refresh list</button><p id="live-history-status" role="status" aria-live="polite"></p></div>
<div id="run-results" tabindex="-1" role="region" aria-labelledby="live-results-title"><h2 id="live-results-title">Your results</h2><p id="run-result-guidance"></p><div class="live-controls"><button id="live-inspect" disabled>Refresh status</button><button id="live-private" disabled>Show inputs and output</button><button id="live-private-clear" disabled>Hide values</button><button id="live-review" disabled>View request</button><button id="live-cancel" disabled>Request cancellation</button></div><p id="live-private-status" role="status" aria-live="polite"></p><div id="live-private-summary"></div><details class="exact-values"><summary>Exact private run record (JSON)</summary><pre id="live-private-result"></pre></details><details><summary>Technical run receipt</summary><pre id="live-result">No execution submitted.</pre></details></div>
<section id="live-approval" hidden aria-label="Request to approve"><h2 id="live-approval-title">Make your decision</h2><div id="live-review-summary"></div><label class="approval-confirmation"><input type="checkbox" id="live-authorize"><span id="live-approval-confirmation">I've read this request and am ready to decide.</span></label><div class="live-controls" id="live-actions"></div><p class="approval-action-help" id="live-approval-help">Approve continues only if the deadline is still open. Reject follows its configured path.</p><details id="live-approval-options" class="advanced-fold"><summary>More options</summary><label><input type="checkbox" id="live-pause-after">Pause after my decision so I can check the next step.</label></details><details class="exact-values"><summary>Technical request details (JSON)</summary><pre id="live-review-data"></pre></details></section></section>
${traceControlsHtml}${usageControlsHtml}${evidenceControlsHtml}${evidenceBundleControlsHtml}${releaseControlsHtml}${projectExportControlsHtml}${modelHistoryHtml}${notificationHistoryHtml}${nodeInspectionHtml}${testControlsHtml}${testCoverageHtml}<div id="preview-workspace" hidden>${previewBody.replace(/<p class="notice">[^<]*<\/p>/, '<div class="notice graph-help"><p>Select a step to see what it does. Exploring the graph never runs it.</p><details><summary>Debugging and privacy</summary><p>Breakpoint edits stay local until you choose Step or Continue. Those controls can run workflow steps, but never approve a human decision. Use Review approval for that. Workflow source and inspected evidence are private; review them before sharing.</p></details></div>').replace('class="panel inspector"', 'class="panel inspector" id="step-inspector"').replace('<pre id="detail-body"></pre>', '<details><summary>Technical step settings</summary><pre id="detail-body"></pre></details>').replace('<pre id="detail-execution-body"></pre>', '<div id="step-execution-summary"></div><details class="exact-values"><summary>Exact execution metadata</summary><pre id="detail-execution-body"></pre></details>').replace('<section class="panel lower"><details><summary>Workflow source', '<section class="panel lower" id="workflow-source"><details><summary>Workflow source')}</div></div><noscript>This live preview requires JavaScript. Use the standalone CLI to inspect or operate the runtime.</noscript><script>${script}</script><script>${workspace}</script></body></html>`;
    return { html, csp };
}
