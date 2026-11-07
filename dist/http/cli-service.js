import { userInfo } from 'node:os';
import { localRuntimeOptions } from "../telemetry/options.js";
import { storageSelection, postgresRuntimeOptions } from "../cli/runtime.js";
import { tlsOptionsFromFlags } from "./tls.js";
import { runServiceProcess } from "./process.js";
import { readBoundedFile } from "../files.js";
import { inspectRelease } from "../releases/snapshot.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { readHttpRateLimitsFile } from "./rate-limits.js";
import { readReleaseWebhookFile } from "./webhook-options.js";
import { readCliRateCoordinator } from "./cli-rate-coordinator.js";
export class RuntimeStartupError extends Error {
    code;
    constructor(code) {
        super(`Jevable PostgreSQL startup failed: ${code}. Check the selected private configuration and retained state. No fallback was attempted.`);
        this.code = code;
    }
}
export class RuntimeServiceUsageError extends Error {
    constructor() { super('Invalid runtime service options. Select sqlite with --data-dir or postgres with --database-file; see jevable --help for limits.'); }
}
export async function serveFromCli(values, token, emit) {
    const storage = storageSelection(values);
    const integer = (value, fallback, min, max) => {
        if (value === undefined)
            return fallback;
        if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))
            || Number(value) < min || Number(value) > max)
            throw new RuntimeServiceUsageError();
        return Number(value);
    };
    const port = integer(values.port, 0, 0, 65535), drainWaitMs = integer(values['drain-wait-ms'], 5000, 1, 60000);
    const asyncRuns = values['async-concurrency'] === undefined ? undefined
        : { maxConcurrentRuns: integer(values['async-concurrency'], 1, 1, 64) };
    const coordinatorOptions = await readCliRateCoordinator(values);
    const rateLimits = await readHttpRateLimitsFile(values['rate-limits-file']);
    const tls = tlsOptionsFromFlags(values), actor = `local:${userInfo().username}`;
    const releaseFile = values['release-file'], releaseHash = values['release-sha256'];
    if ((values['reviewer-decisions'] || values['caller-operations']) && releaseFile !== undefined)
        throw new RuntimeServiceUsageError();
    if ((releaseFile !== undefined || releaseHash !== undefined) && (typeof releaseFile !== 'string' || !releaseFile
        || typeof releaseHash !== 'string' || !/^[a-f0-9]{64}$/u.test(releaseHash)))
        throw new RuntimeServiceUsageError();
    if (values['webhooks-file'] !== undefined && (releaseFile === undefined || !asyncRuns))
        throw new RuntimeServiceUsageError();
    const webhooks = await readReleaseWebhookFile(values['webhooks-file']);
    let coordinator;
    try {
        return await runServiceProcess(async () => {
            let release;
            if (typeof releaseFile === 'string') {
                const text = await readBoundedFile(releaseFile, 4_000_000);
                let value;
                try {
                    value = JSON.parse(text);
                }
                catch {
                    throw new WorkflowRuntimeError('invalid-command');
                }
                const inspected = inspectRelease(value);
                if (inspected.sha256 !== releaseHash)
                    throw new WorkflowRuntimeError('conflict');
                release = { snapshot: inspected.snapshot };
            }
            const selected = storage === 'postgres' ? { storage: 'postgres', runtime: await postgresRuntimeOptions(values) }
                : { storage: 'sqlite', runtime: await localRuntimeOptions(values) };
            if (coordinatorOptions) {
                const { PostgresHttpRateCoordinator, PostgresHttpRateCoordinatorError } = await import("./postgres-rate-limits.js");
                try {
                    coordinator = await PostgresHttpRateCoordinator.open(coordinatorOptions);
                }
                catch (error) {
                    throw new RuntimeStartupError(error instanceof PostgresHttpRateCoordinatorError ? error.code : 'unavailable');
                }
            }
            const admission = coordinator ? { coordinatedRateLimits: coordinator.admission() } : {};
            if (selected.storage === 'postgres') {
                // Strict runtime validation still occurs before connecting. The file is not an ambient PG configuration source.
                const { startPostgresRuntimeService } = await import("./postgres.js");
                const { JournalError } = await import("../storage/postgres.js");
                try {
                    return await startPostgresRuntimeService({ runtime: selected.runtime,
                        token, actor, port, ...admission, ...(tls ? { tls } : {}), ...(release ? { release } : {}), ...(asyncRuns ? { asyncRuns } : {}), ...(webhooks ? { webhooks } : {}), ...(rateLimits ? { rateLimits } : {}), reviewerDecisions: values['reviewer-decisions'] === true, callerOperations: values['caller-operations'] === true });
                }
                catch (error) {
                    if (error instanceof JournalError)
                        throw new RuntimeStartupError(error.code);
                    throw error;
                }
            }
            const { startRuntimeService } = await import("./service.js");
            return startRuntimeService({ runtime: selected.runtime, token, actor, port, ...admission, ...(tls ? { tls } : {}), ...(release ? { release } : {}), ...(asyncRuns ? { asyncRuns } : {}), ...(webhooks ? { webhooks } : {}), ...(rateLimits ? { rateLimits } : {}), reviewerDecisions: values['reviewer-decisions'] === true, callerOperations: values['caller-operations'] === true });
        }, storage, emit, drainWaitMs);
    }
    finally {
        await coordinator?.close();
    }
}
