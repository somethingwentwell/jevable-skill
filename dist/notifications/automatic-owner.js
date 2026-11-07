import { WorkflowRuntimeError } from "../runtime/errors.js";
import { JournalError } from "../storage/errors.js";
import { CommittedApprovalCapture } from "./committed-approvals.js";
import { parseAutomaticApprovalPolicy } from "./automatic-policy.js";
import { automaticAdmissionFailed, automaticDeliveryRecorded, prepareAutomaticAdmission } from "./automatic-admission.js";
function code(error) {
    if (error instanceof JournalError)
        return error.code === 'conflict' ? 'conflict' : 'uncertain';
    if (error instanceof WorkflowRuntimeError && ['busy', 'conflict', 'closed', 'invalid-command', 'not-found', 'limit', 'corrupt'].includes(error.code))
        return error.code;
    return 'uncertain';
}
const asynchronous = (value) => value instanceof Promise;
/** Internal live-commit owner, not a recovered outbox. Only acknowledged *new* reservations can launch a send. */
export class AutomaticApprovalOwner {
    persistence;
    dispatcher;
    maxPending;
    policy;
    destinations;
    tasks = new Set();
    admissions = new Set();
    reservations = 0;
    sealed = false;
    fault;
    constructor(policy, persistence, dispatcher, maxPending = 16) {
        this.persistence = persistence;
        this.dispatcher = dispatcher;
        this.maxPending = maxPending;
        this.policy = parseAutomaticApprovalPolicy(policy);
        this.destinations = dispatcher.destinations();
        if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 64)
            throw new WorkflowRuntimeError('invalid-command');
        // Validate destination descriptors now; matching/provenance remain live-commit checks.
        new CommittedApprovalCapture(this.policy, this.destinations, 1);
    }
    busy() { return this.reservations !== 0 || this.tasks.size !== 0 || this.admissions.size !== 0; }
    snapshot() {
        return structuredClone({ pending: this.reservations, admitting: this.admissions.size, active: this.tasks.size, sealed: this.sealed,
            ...(this.fault ? { fault: this.fault } : {}), semantics: 'live-commits-only; no-replay; failure-is-not-proof-of-no-effect' });
    }
    refused(runId, transition, failure = 'corrupt') {
        this.fault ??= { code: failure, runId, transition };
    }
    failed(error, requestId) { this.fault ??= { code: code(error), requestId }; }
    committed(run, events, transition, data) {
        if (this.sealed || this.fault)
            return;
        // One ephemeral projector: no growing process-local candidate buffer or retained run/private values.
        const capture = new CommittedApprovalCapture(this.policy, this.destinations, 1);
        capture.committed(run, events, transition, data);
        const projection = capture.snapshot();
        if (projection.fault) {
            this.refused(run.id, transition, projection.fault.code);
            return;
        }
        const admissions = [];
        for (const candidate of projection.candidates)
            for (const request of candidate.plan.requests) {
                try {
                    const saturated = this.reservations >= this.maxPending;
                    const record = prepareAutomaticAdmission(this.policy, candidate.event, this.destinations, request, new Date().toISOString(), saturated ? 'busy' : undefined);
                    if (!saturated)
                        this.reservations++;
                    const release = () => { if (!saturated)
                        this.reservations--; };
                    try {
                        const created = this.persistence.create(record);
                        const admitted = (changed) => {
                            if (!changed || saturated) {
                                release();
                                return;
                            }
                            this.launch(record, candidate.plan.actor, release);
                        };
                        if (asynchronous(created)) {
                            const task = created.then(admitted, error => { release(); this.failed(error, request.requestId); })
                                .finally(() => this.admissions.delete(task));
                            this.admissions.add(task);
                            admissions.push(task);
                        }
                        else
                            admitted(created);
                    }
                    catch (error) {
                        release();
                        this.failed(error, request.requestId);
                    }
                }
                catch (error) {
                    this.failed(error, request.requestId);
                }
            }
        // PostgreSQL awaits reservation acknowledgement *outside* its domain gate, never the HTTP send.
        if (admissions.length)
            return Promise.all(admissions).then(() => { });
    }
    launch(record, actor, release) {
        const task = Promise.resolve().then(async () => {
            let terminal;
            try {
                terminal = automaticDeliveryRecorded(record, await this.dispatcher.send(record.request, actor), new Date().toISOString());
            }
            catch (error) {
                terminal = automaticAdmissionFailed(record, code(error), new Date().toISOString());
            }
            try {
                await this.persistence.settle(terminal);
            }
            catch (error) {
                this.failed(error, record.request.requestId);
            }
        }).catch(error => this.failed(error, record.request.requestId)).finally(() => { release(); this.tasks.delete(task); });
        this.tasks.add(task);
    }
    /** Caller seals workflow admission first. Do not abort an accepted external effect or close owned credentials early. */
    async drain() {
        this.sealed = true;
        await Promise.all([...this.admissions]);
        await Promise.all([...this.tasks]);
        if (this.reservations)
            throw new WorkflowRuntimeError('busy');
    }
}
