import { isDeepStrictEqual as same } from 'node:util';
import { z } from 'zod';
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { reference } from "../providers/config.js";
import { approvalLifecycleNotification } from "./schema.js";
import { parseAutomaticApprovalPolicy, planAutomaticApprovalNotifications } from "./automatic-policy.js";
/** Internal post-commit bridge only. No transport, credentials, durable admission or public automatic-delivery feature. */
export class CommittedApprovalCapture {
    maxCandidates;
    policy;
    destinations;
    candidates = new Map();
    fault;
    constructor(policy, destinations, maxCandidates = 64) {
        this.maxCandidates = maxCandidates;
        this.policy = parseAutomaticApprovalPolicy(policy);
        const parsed = z.array(z.strictObject({ id: reference, endpointSha256: z.string().regex(/^[a-f0-9]{64}$/u) }))
            .max(32).refine(values => new Set(values.map(value => value.id)).size === values.length).safeParse(destinations);
        if (!parsed.success || !Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 100000)
            throw new WorkflowRuntimeError('invalid-command');
        this.destinations = parsed.data;
    }
    /** Synchronous and nonthrowing: a diagnostic must never turn an acknowledged workflow commit into a failure. */
    committed(run, events, transition, data) {
        if (this.fault || !['approval-requested', 'approval-decided', 'run-cancelled'].includes(transition))
            return;
        try {
            const tail = events.at(-1);
            if (!tail || tail.kind !== transition || tail.at !== run.updatedAt || !same(tail.data, data))
                throw new WorkflowRuntimeError('corrupt');
            const fields = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {};
            // A non-waiting cancellation is not an approval lifecycle event.
            if (transition === 'run-cancelled' && fields.previousStatus !== 'waiting')
                return;
            const attempt = z.uuid().safeParse(fields.attemptId);
            if (!attempt.success)
                throw new WorkflowRuntimeError('corrupt');
            const decision = fields.decision !== null && typeof fields.decision === 'object'
                ? fields.decision : {};
            const eventKind = transition === 'approval-requested' ? 'requested' : transition === 'run-cancelled' ? 'cancelled'
                : decision.kind === 'expired' ? 'expired' : 'decided';
            const event = approvalLifecycleNotification(run, events, { runId: run.id, revision: run.revision,
                attemptId: attempt.data, eventKind });
            const plan = planAutomaticApprovalNotifications(this.policy, event, this.destinations);
            if (!plan.requests.length || this.candidates.has(event.id))
                return;
            if (this.candidates.size >= this.maxCandidates)
                throw new WorkflowRuntimeError('limit');
            // Projections contain thin metadata only; neither snapshots nor review values are retained here.
            this.candidates.set(event.id, structuredClone({ event, plan }));
        }
        catch (error) {
            const code = error instanceof WorkflowRuntimeError && ['corrupt', 'conflict', 'invalid-command', 'limit'].includes(error.code)
                ? error.code : 'corrupt';
            this.refused(run.id, transition, code);
        }
    }
    /** Storage observation failed after commit. Retain only safe diagnostics; never repair or undo the run. */
    refused(runId, transition, code = 'corrupt') {
        this.fault ??= { code, runId, transition };
    }
    /** Read-only, detached and explicitly not a durable delivery receipt. A fault latches admission closed. */
    snapshot() {
        return structuredClone({ candidates: [...this.candidates.values()], ...(this.fault ? { fault: this.fault } : {}),
            semantics: 'process-local-candidates; no-durable-admission; no-dispatch' });
    }
}
