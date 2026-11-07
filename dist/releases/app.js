import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { readBreakpointFile } from "../runtime/control-file.js";
import { parseTriggerMode, triggerMetadata } from "../runtime/trigger.js";
import { ProviderError, reference } from "../providers/config.js";
import { readSecretFile } from "../providers/secret-input.js";
import { readBoundedFile, writeArtifact } from "../files.js";
import { inspectRelease } from "./snapshot.js";
import { runReceipt } from "../runtime/receipts.js";
import { randomBytes } from 'node:crypto';
import { prepareGrantToken } from "../access/grants.js";
import { RuntimeHttpError } from "../http/errors.js";
import { ReleaseSession, parseReleaseNotificationOperation } from "./service-session.js";
import { readTlsPemFile, tlsOptionsFromFlags } from "../http/tls.js";
import { runServiceProcess } from "../http/process.js";
import { JournalError } from "../storage/errors.js";
import { approvalPageSchema } from "../runtime/approval-inbox.js";
import { releaseAppCommands, releaseCommandStrings } from "./commands.js";
import { JobLifetime, JobInterruptedError } from "../process/job-lifetime.js";
import { CliStorageUsageError } from "../cli/usage.js";
import { readHttpRateLimitsFile } from "../http/rate-limits.js";
import { createCliOutput, encodeCliJson, CliOutputError } from "../process/cli-output.js";
/** Safe backend-owned quota startup category; never adopt a driver message or private config. */
export class ReleaseRateCoordinatorStartupError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
/** Bundled release execution surface, intentionally not the authoring CLI. */
export async function runReleaseApp(backend, value, argv, directory, io) {
    const output = createCliOutput(io);
    const lifetime = new JobLifetime(receipt => {
        try {
            output.io.err(encodeCliJson(receipt, 'stderr', false));
        }
        catch (error) {
            if (error instanceof CliOutputError)
                output.record(error);
            else
                throw error;
        }
    });
    let result;
    try {
        try {
            result = await dispatchReleaseApp(backend, value, argv, directory, lifetime, output.io);
        }
        catch (error) {
            if (!(error instanceof CliOutputError))
                throw error;
            output.record(error);
            result = 5;
        }
    }
    finally {
        lifetime.dispose();
        await output.finish();
    }
    return lifetime.exitCode ?? (output.error ? 5 : result);
}
async function dispatchReleaseApp(backend, value, argv, directory, lifetime, io) {
    const emit = (value) => io.out(encodeCliJson(value));
    try {
        const release = inspectRelease(value), [action = 'info', ...tail] = argv;
        if (!Object.hasOwn(releaseAppCommands, action))
            throw new WorkflowRuntimeError('invalid-command');
        const command = releaseAppCommands[action];
        let parsed;
        try {
            parsed = parseArgs({ args: tail, allowPositionals: true, strict: true, options: {
                    ...Object.fromEntries(releaseCommandStrings(action, backend.storage, backend.rateCoordinator).map(name => [name, { type: 'string' }])),
                    ...Object.fromEntries((command.booleans ?? []).map(name => [name, { type: 'boolean' }]))
                } });
        }
        catch {
            throw new WorkflowRuntimeError('invalid-command');
        }
        if (parsed.positionals.length !== (command.positional ? 1 : 0))
            throw new WorkflowRuntimeError('invalid-command');
        const triggerMode = parseTriggerMode(parsed.values['trigger-mode']);
        const required = (name) => { const value = parsed.values[name]; if (typeof value !== 'string' || !value)
            throw new WorkflowRuntimeError('invalid-command'); return value; };
        const generation = () => { const value = required('expected-generation'); if (!/^(0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value)))
            throw new WorkflowRuntimeError('invalid-command'); return Number(value); };
        if (action === 'credentials-clear' && (generation() < 1 || !reference.safeParse(parsed.positionals[0]).success))
            throw new WorkflowRuntimeError('invalid-command');
        if (action === 'info') {
            emit({ schemaVersion: 1, releaseId: release.snapshot.id, version: release.snapshot.version, releaseSha256: release.sha256,
                ...(release.snapshot.notes === undefined ? {} : { notes: release.snapshot.notes }),
                revision: release.snapshot.workflow.revision, runtime: release.snapshot.runtime, execution: 'not-run',
                commands: Object.keys(releaseAppCommands), storage: backend.storage, ...(backend.rateCoordinator ? { rateCoordinator: backend.rateCoordinator } : {}), databaseConfiguration: backend.storage === 'postgres' ? 'explicit-private-file-required' : 'local-data-directory', dockerRequired: false, server: 'authenticated-loopback-http-or-explicit-direct-https; exact-release',
                authoringApi: false, telemetryExport: 'opt-in-otlp-http-protobuf-or-grpc', telemetryProtocols: ['http/protobuf', 'grpc'], telemetrySignals: ['traces', 'metrics', 'logs'] });
            return 0;
        }
        if (action === 'token') {
            const artifact = await writeArtifact(required('output'), randomBytes(32).toString('hex') + '\n');
            emit({ schemaVersion: 1, status: 'created', path: artifact.path, secret: 'not-displayed', permissions: 'owner-only' });
            return 0;
        }
        if (action === 'reviewer-token') {
            const prepared = prepareGrantToken(required('id'));
            const artifact = await writeArtifact(required('output'), prepared.token + '\n');
            emit({ schemaVersion: 1, status: 'prepared-not-issued', id: prepared.id, tokenSha256: prepared.tokenSha256,
                path: artifact.path, secret: 'not-displayed', permissions: 'owner-only' });
            return 0;
        }
        if (action === 'submit' || action === 'observe') {
            for (const name of command.required ?? [])
                required(name);
            // Only selected async commands load their client adapter. Hold admission
            // during this new await, then release before the selected-owner request:
            // its existing independent request lifetime must remain unchanged.
            const releaseLoading = lifetime.hold();
            let adapter;
            try {
                adapter = await import("../cli/async.js");
                lifetime.assertAdmission();
            }
            finally {
                releaseLoading();
            }
            emit(await adapter.asyncRunFromCli(action, parsed.positionals[0], parsed.values, {
                id: release.snapshot.id, sha256: release.sha256, revision: release.snapshot.workflow.revision,
            }));
            return 0;
        }
        if (action === 'status' || action === 'request') {
            for (const name of command.required ?? [])
                required(name);
            const releaseLoading = lifetime.hold();
            let adapter;
            try {
                adapter = await import("./client.js");
                lifetime.assertAdmission();
            }
            finally {
                releaseLoading();
            }
            const timeout = parsed.values['timeout-ms'] === undefined ? 30_000 : Number(required('timeout-ms'));
            const ca = parsed.values['ca-file'] === undefined ? undefined : await readTlsPemFile(required('ca-file'));
            const client = new adapter.ReleaseClient(required('endpoint'), await readSecretFile(required('token-file')), release.sha256, timeout, ca === undefined ? {} : { ca });
            if (action === 'request')
                emit(await client.operation(JSON.parse(await readBoundedFile(parsed.positionals[0], 4_000_000))));
            else {
                const health = await client.health();
                if (health.release?.sha256 !== release.sha256)
                    throw new WorkflowRuntimeError('conflict');
                emit(health);
            }
            return 0;
        }
        if (action === 'serve') {
            const selectedCoordinator = parsed.values['rate-coordinator-file'] !== undefined;
            if (selectedCoordinator && (parsed.values['rate-limits-file'] !== undefined || !backend.prepareRateCoordinator))
                throw new WorkflowRuntimeError('invalid-command');
            const portText = parsed.values.port, port = portText === undefined ? 0 : Number(portText);
            if (portText !== undefined && (typeof portText !== 'string' || !/^(0|[1-9][0-9]*)$/.test(portText)))
                throw new WorkflowRuntimeError('invalid-command');
            const capacityText = parsed.values['async-concurrency'];
            if (capacityText !== undefined && (typeof capacityText !== 'string' || !/^[1-9][0-9]*$/u.test(capacityText)
                || !Number.isSafeInteger(Number(capacityText)) || Number(capacityText) > 64))
                throw new WorkflowRuntimeError('invalid-command');
            const asyncRuns = capacityText === undefined ? undefined : { maxConcurrentRuns: Number(capacityText) };
            if (parsed.values['webhooks-file'] !== undefined && !asyncRuns)
                throw new WorkflowRuntimeError('invalid-command');
            const { readReleaseWebhookFile } = await import("../http/webhook-options.js");
            const webhooks = await readReleaseWebhookFile(parsed.values['webhooks-file']);
            const rateLimits = await readHttpRateLimitsFile(parsed.values['rate-limits-file']);
            const tls = tlsOptionsFromFlags(parsed.values);
            const openCoordinator = selectedCoordinator ? await backend.prepareRateCoordinator(parsed.values) : undefined;
            let coordinator;
            const serve = async () => {
                try {
                    return await runServiceProcess(async () => {
                        const token = await readSecretFile(required('token-file'));
                        if (openCoordinator)
                            coordinator = await openCoordinator();
                        return backend.serve(parsed.values, directory, {
                            token, actor: `local:${userInfo().username}`, port,
                            release: { snapshot: release.snapshot }, ...(coordinator ? { coordinatedRateLimits: coordinator.admission() } : {}),
                            ...(tls ? { tls } : {}), ...(asyncRuns ? { asyncRuns } : {}), ...(webhooks ? { webhooks } : {}), ...(rateLimits ? { rateLimits } : {}),
                            reviewerDecisions: parsed.values['reviewer-decisions'] === true
                        });
                    }, backend.storage, receipt => emit({ ...receipt, ...(receipt.status === 'ready'
                            ? { authoringApi: false, execution: 'not-run-on-startup' } : {}) }));
                }
                finally {
                    await coordinator?.close();
                }
            };
            // Unselected services retain their existing rejection contract. Only the
            // explicitly selected coordinator startup maps its safe backend categories.
            return selectedCoordinator ? await serve() : serve();
        }
        // Only selected event commands load their readers: cold metadata admission
        // stays free of execution-only modules. The reviewed local file is still
        // captured before storage, telemetry or notification configuration opens.
        let localEvent;
        if (action === 'event' || action === 'event-id' || action === 'event-inbox') {
            const eventSha256 = action === 'event' ? required('event-sha256') : undefined;
            const releaseLoading = lifetime.hold();
            let adapter;
            try {
                adapter = await import("./local-event.js");
                lifetime.assertAdmission();
            }
            finally {
                releaseLoading();
            }
            localEvent = await adapter.readReleaseLocalEvent(parsed.positionals[0], release.snapshot, eventSha256);
        }
        if (action === 'event-id') {
            emit({ schemaVersion: 1, format: 'jevable.ai/local-release-event-id', eventSha256: localEvent.sha256,
                runId: localEvent.runId, release: { id: release.snapshot.id, sha256: release.sha256, revision: release.snapshot.workflow.revision },
                execution: 'not-run', authority: 'local-owner-file; sender-not-verified' });
            return 0;
        }
        if (action === 'event-inbox' || action === 'scheduler') {
            const releaseLoading = lifetime.hold();
            let adapter;
            try {
                adapter = await import("./local-inbox.js");
                lifetime.assertAdmission();
            }
            finally {
                releaseLoading();
            }
            if (action === 'event-inbox') {
                const queued = await adapter.queueReleaseLocalEvent(required('inbox'), {
                    eventSha256: localEvent.sha256, runId: localEvent.runId,
                    release: { id: release.snapshot.id, sha256: release.sha256, revision: release.snapshot.workflow.revision },
                    source: localEvent.source, messageId: localEvent.messageId, input: localEvent.input
                }, localEvent.bytes);
                emit({ schemaVersion: 1, status: queued.created ? 'queued' : 'already-queued', eventSha256: queued.record.eventSha256,
                    runId: queued.record.runId, state: queued.record.state, attempts: queued.record.attempts,
                    execution: 'not-started', authority: 'local-owner-file; sender-not-verified' });
                return 0;
            }
            // The scheduler drains the durable inbox through the exact one-shot event command
            // in separate bounded child processes. This process never opens workflow storage,
            // never resumes a run and never decides an approval; identical redelivery observes.
            const inbox = required('inbox');
            const flagNumber = (name, max) => {
                const text = parsed.values[name];
                if (text === undefined)
                    return undefined;
                if (typeof text !== 'string' || !/^[1-9][0-9]*$/u.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) > max)
                    throw new WorkflowRuntimeError('invalid-command');
                return Number(text);
            };
            const timeoutMs = flagNumber('event-timeout-ms', 600_000) ?? 120_000;
            const intervalSeconds = flagNumber('interval-seconds', 86_400);
            const launcher = join(directory, 'app.mjs');
            const launcherInfo = await lstat(launcher).catch(() => { throw new WorkflowRuntimeError('invalid-command'); });
            if (!launcherInfo.isFile())
                throw new WorkflowRuntimeError('invalid-command');
            const storageFlags = backend.storage === 'postgres' ? ['--database-file', required('database-file')]
                : parsed.values['data-dir'] !== undefined ? ['--data-dir', String(parsed.values['data-dir'])] : [];
            const telemetryFlag = parsed.values['telemetry-file'] !== undefined ? ['--telemetry-file', String(parsed.values['telemetry-file'])] : [];
            const deliver = async (entry) => {
                const child = spawn(process.execPath, ['--experimental-transform-types', launcher, 'event',
                    entry.eventPath, '--event-sha256', entry.record.eventSha256, ...storageFlags, ...telemetryFlag], { cwd: directory, env: { PATH: '', TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
                let out = '', err = '';
                child.stdout.on('data', bytes => { out += bytes; });
                child.stderr.on('data', bytes => { err += bytes; });
                const expired = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
                const code = await new Promise(resolveExit => child.on('close', (exitCode, signal) => resolveExit(signal === null ? exitCode : -1)));
                clearTimeout(expired);
                const receiptOf = (text) => { try {
                    return JSON.parse(text.slice(text.indexOf('{')));
                }
                catch {
                    return undefined;
                } };
                const errorOf = (text) => { const line = text.split('\n').find(value => value.startsWith('{')); try {
                    return line ? JSON.parse(line) : undefined;
                }
                catch {
                    return undefined;
                } };
                const receipt = receiptOf(out), error = errorOf(err);
                if (code === -1)
                    return { state: entry.record.state === 'observed' ? 'observed' : 'pending', code: 'timeout-uncertain' };
                if (code === 2)
                    return { state: 'invalid', code: 'invalid-command' };
                if (receipt !== undefined && typeof receipt.status === 'string') {
                    const status = receipt.status;
                    if (status === 'completed' || status === 'failed' || status === 'cancelled')
                        return { state: 'acked', status };
                    if (status === 'waiting' || status === 'paused' || status === 'executing')
                        return { state: 'observed', status };
                }
                if (code === 1 && error !== undefined && typeof error.code === 'string') {
                    if (error.code === 'conflict')
                        return { state: 'conflict', code: 'conflict' };
                    return { state: entry.record.state === 'observed' ? 'observed' : 'pending', code: error.code };
                }
                return { state: entry.record.state === 'observed' ? 'observed' : 'pending', code: 'uncertain' };
            };
            const drain = async () => {
                // Own signals across the whole drain: an arriving SIGINT lets the in-flight
                // child finish and its observation commit, then stops before the next entry.
                const drainAdmission = lifetime.hold();
                try {
                    const releaseLock = await adapter.acquireReleaseLocalInboxLock(inbox);
                    const observed = [];
                    try {
                        const { entries } = await adapter.loadReleaseLocalInbox(inbox);
                        for (const entry of entries) {
                            if (entry.record.state === 'acked' || entry.record.state === 'conflict' || entry.record.state === 'invalid') {
                                observed.push({ eventSha256: entry.record.eventSha256, runId: entry.record.runId, state: entry.record.state, attempts: entry.record.attempts,
                                    ...(entry.record.lastStatus !== undefined ? { status: entry.record.lastStatus } : {}) });
                                continue;
                            }
                            lifetime.assertAdmission();
                            const outcome = await deliver(entry);
                            const record = await adapter.updateReleaseLocalInboxEntry(entry, outcome);
                            observed.push({ eventSha256: record.eventSha256, runId: record.runId, state: record.state, attempts: record.attempts,
                                ...(record.lastStatus !== undefined ? { status: record.lastStatus } : {}), ...(record.lastCode !== undefined ? { code: record.lastCode } : {}) });
                        }
                    }
                    finally {
                        await releaseLock();
                    }
                    return observed;
                }
                finally {
                    drainAdmission();
                }
            };
            if (intervalSeconds === undefined) {
                const entries = await drain();
                emit({ schemaVersion: 1, status: 'drained', inbox: 'private-local-directory', entries,
                    counts: { entries: entries.length, acked: entries.filter(entry => entry.state === 'acked').length,
                        observed: entries.filter(entry => entry.state === 'observed').length,
                        replayable: entries.filter(entry => entry.state === 'pending').length,
                        terminal: entries.filter(entry => entry.state === 'conflict' || entry.state === 'invalid').length },
                    execution: 'delivered-through-exact-event-child-processes', scheduler: 'process exits after this drain; start again (or use --interval-seconds) for another pass' });
                return 0;
            }
            // Interval mode keeps signal ownership across the pause: an interrupt drains the
            // current pass, emits its receipt and exits rather than dying mid-record.
            const pause = async () => {
                const pauseAdmission = lifetime.hold();
                try {
                    const deadline = Date.now() + intervalSeconds * 1000;
                    while (Date.now() < deadline) {
                        await new Promise(resolveTick => setTimeout(resolveTick, Math.min(250, Math.max(1, deadline - Date.now()))));
                        lifetime.assertAdmission();
                    }
                }
                finally {
                    pauseAdmission();
                }
            };
            for (;;) {
                const entries = await drain();
                emit({ schemaVersion: 1, status: 'drained', inbox: 'private-local-directory', entries,
                    counts: { entries: entries.length, acked: entries.filter(entry => entry.state === 'acked').length,
                        observed: entries.filter(entry => entry.state === 'observed').length,
                        replayable: entries.filter(entry => entry.state === 'pending').length,
                        terminal: entries.filter(entry => entry.state === 'conflict' || entry.state === 'invalid').length },
                    execution: 'delivered-through-exact-event-child-processes', scheduler: 'interval mode; explicitly started local infrastructure, not a required Jevable service' });
                await pause();
            }
        }
        const breakpoints = await readBreakpointFile(parsed.values['breakpoints-file']);
        let approvalPage;
        if (action === 'approvals') {
            if (parsed.values.page !== true)
                throw new WorkflowRuntimeError('invalid-command');
            const value = parsed.values, limit = value.limit;
            const checked = approvalPageSchema.safeParse({ ...(value.after === undefined ? {} : { after: value.after }),
                ...(limit === undefined ? {} : { limit: typeof limit === 'string' && /^[1-9][0-9]*$/u.test(limit) ? Number(limit) : NaN }) });
            if (!checked.success)
                throw new WorkflowRuntimeError('invalid-command');
            approvalPage = checked.data;
        }
        let usageAdapter, usageSelection;
        if (action === 'usage') {
            // Report/ZIP schemas are irrelevant to notifications and ordinary jobs. Keep
            // admission and interruption checks ahead of database acquisition when selected.
            const releaseLoading = lifetime.hold();
            try {
                usageAdapter = await import("../evidence/usage.js");
                lifetime.assertAdmission();
            }
            finally {
                releaseLoading();
            }
            usageSelection = usageAdapter.inspectUsageSelection({ schemaVersion: 1,
                runs: [{ id: parsed.positionals[0], revision: release.snapshot.workflow.revision }],
                ...(parsed.values['group-by'] === undefined ? {} : { groupBy: parsed.values['group-by'] }),
                ...(parsed.values.from !== undefined || parsed.values.before !== undefined
                    ? { window: { from: parsed.values.from, before: parsed.values.before } } : {}) }).selection;
        }
        // Invalid notification files cannot acquire storage, telemetry or destination configuration.
        // This is pure command admission, not permission to send or weaken the runtime's release scope.
        let notificationCommand;
        if (action === 'notify') {
            try {
                notificationCommand = parseReleaseNotificationOperation(JSON.parse(await readBoundedFile(parsed.positionals[0], 100_000)));
            }
            catch {
                throw new WorkflowRuntimeError('invalid-command');
            }
            if (notificationCommand.operation.startsWith('notifications.automatic-') && parsed.values['notifications-file'] !== undefined)
                throw new WorkflowRuntimeError('invalid-command');
        }
        const releaseHold = lifetime.hold();
        let runtime;
        try {
            runtime = await backend.open(parsed.values, directory, release);
        }
        catch (error) {
            releaseHold();
            throw error;
        }
        const admission = (work) => { lifetime.assertAdmission(); return work(); };
        try {
            lifetime.assertAdmission();
            const id = parsed.positionals[0], actor = `local:${userInfo().username}`;
            if (action === 'approvals' || action === 'notify') {
                const target = 'listRelease' in runtime ? { storage: 'postgres', runtime } : { storage: 'sqlite', runtime };
                if (target.storage !== backend.storage)
                    throw new WorkflowRuntimeError('invalid-command');
                const session = new ReleaseSession(target, release.snapshot, actor);
                const command = notificationCommand ?? { operation: 'approvals.list', page: approvalPage };
                const result = await admission(() => session.operation({ ...command, releaseSha256: release.sha256 }));
                emit(result);
                if (action === 'notify' && Reflect.get(command, 'operation') === 'notifications.send') {
                    const outcome = result.outcome;
                    return outcome.status === 'pending' || outcome.result?.status === 'uncertain' ? 5 : outcome.result?.status === 'accepted' ? 0 : 4;
                }
                return 0;
            }
            if (action === 'check') {
                const result = await admission(() => runtime.check(release.snapshot.workflow.yaml, triggerMode));
                emit(result);
                return result.runtimeReadiness === 'ready' ? 0 : 2;
            }
            if (action === 'providers-list') {
                emit({ connections: await admission(() => runtime.connections()) });
                return 0;
            }
            if (action === 'providers-set') {
                const connection = JSON.parse(await readBoundedFile(required('file'), 100_000));
                emit(await admission(() => runtime.configureConnection(connection, generation(), actor)));
                return 0;
            }
            if (action === 'credentials-status') {
                emit(await admission(() => runtime.credentialStatus(id)));
                return 0;
            }
            if (action === 'credentials-clear') {
                emit(await admission(() => runtime.clearCredential(id, generation(), actor)));
                return 0;
            }
            if (action === 'credentials-set') {
                const secret = await readSecretFile(required('file'));
                emit(await admission(() => runtime.setCredential(id, secret, generation(), actor)));
                return 0;
            }
            let run;
            if (action === 'event') {
                run = await admission(() => runtime.runRelease(release.snapshot, localEvent.input, { id: localEvent.runId, triggerMode: 'api' }));
            }
            else if (action === 'run') {
                const input = JSON.parse(await readBoundedFile(required('input'), 1_000_000));
                run = await admission(() => runtime.runRelease(release.snapshot, input, { id: required('id'), paused: parsed.values.paused === true, ...triggerMetadata({ triggerMode }) }));
            }
            else {
                run = await admission(() => runtime.show(id));
                if (run.release?.id !== release.snapshot.id || run.release.sha256 !== release.sha256 || run.revision !== release.snapshot.workflow.revision)
                    throw new WorkflowRuntimeError('conflict');
                if (action === 'usage') {
                    emit(await admission(() => usageAdapter.createUsageReport(runtime, usageSelection)));
                    return 0;
                }
                if (action === 'export') {
                    const evidence = await admission(() => runtime.exportRun(id, parsed.values['include-private'] === true));
                    const artifact = await writeArtifact(required('output'), JSON.stringify(evidence), parsed.values.overwrite === true);
                    emit({ schemaVersion: 1, status: 'written', artifact, runId: id, revision: evidence.snapshot.run.revision,
                        workflowStatus: evidence.snapshot.run.status, snapshotSha256: evidence.checksum.value, privacy: evidence.snapshot.privacy,
                        execution: 'not-started-or-resumed-by-export' });
                    return 0;
                }
                if (action === 'events') {
                    const events = await admission(() => runtime.events(id));
                    emit({ schemaVersion: backend.storage === 'postgres' ? 2 : 1, runId: id, release: run.release,
                        sequenceEncoding: backend.storage === 'postgres' ? 'decimal-int64' : 'safe-integer',
                        events: events.map(event => ({ sequence: event.sequence, ...('version' in event ? { version: event.version } : {}), kind: event.kind, at: event.at })) });
                    return 0;
                }
                if (action === 'review') {
                    if (run.state.status !== 'waiting')
                        throw new WorkflowRuntimeError('conflict');
                    emit({ ...runReceipt(run), review: run.state.attempt.prepared });
                    return 0;
                }
                if (action === 'step' || action === 'continue' || action === 'pause' || action === 'recover')
                    run = await admission(() => runtime.advance(id, { requestId: required('request-id'),
                        expectedCheckpointSha256: required('checkpoint-sha256'), mode: action, ...(breakpoints === undefined ? {} : { breakpoints }) }, actor));
                if (action === 'decide')
                    run = await admission(() => runtime.decide(id, required('attempt'), required('action'), actor, { pauseAfter: parsed.values['pause-after'] === true }));
                if (action === 'cancel')
                    run = await admission(() => runtime.cancel(id, required('request-id'), actor));
            }
            emit({ ...runReceipt(run), ...(localEvent ? { eventSha256: localEvent.sha256 } : {}) });
            return action === 'show' || action === 'cancel' || action === 'pause' ? 0 : run.state.status === 'completed' ? 0 : run.state.status === 'cancelled' ? 7 : run.state.status === 'failed' ? 4 : run.state.status === 'executing' ? 5 : 3;
        }
        finally {
            try {
                await runtime.close();
            }
            finally {
                releaseHold();
            }
        }
    }
    catch (error) {
        if (error instanceof CliOutputError)
            throw error;
        if (error instanceof JobInterruptedError)
            return lifetime.exitCode ?? 1;
        const code = error instanceof CliStorageUsageError ? 'invalid-command'
            : error instanceof WorkflowRuntimeError || error instanceof ProviderError || error instanceof RuntimeHttpError || error instanceof JournalError || error instanceof ReleaseRateCoordinatorStartupError ? error.code : 'operation-failed';
        io.err(encodeCliJson({ status: 'error', code, recovery: 'Inspect retained state and reuse the original run UUID; do not retry uncertain work with a new identity.' }, 'stderr', false));
        return code === 'invalid-command' ? 2 : 1;
    }
}
