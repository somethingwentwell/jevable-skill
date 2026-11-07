import type { LocalRun } from '../runtime/run-types.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { JournalError } from '../storage/errors.ts'
import { CommittedApprovalCapture, type ApprovalCaptureFault } from './committed-approvals.ts'
import { parseAutomaticApprovalPolicy } from './automatic-policy.ts'
import { automaticAdmissionFailed, automaticDeliveryRecorded, prepareAutomaticAdmission,
  type AutomaticAdmissionRecord, type AutomaticFailureCode } from './automatic-admission.ts'
import type { ApprovalNotificationDispatcher } from './dispatcher.ts'

export interface CommittedApprovalObserver {
  committed(run: LocalRun, events: readonly { kind: string; at: string; data: unknown }[], transition: string, data: unknown): void | Promise<void>
  refused(runId: string, transition: string, code?: ApprovalCaptureFault['code']): void
}
interface AdmissionPersistence {
  create(record: AutomaticAdmissionRecord): boolean | Promise<boolean>
  settle(record: AutomaticAdmissionRecord): void | Promise<void>
}
function code(error: unknown): AutomaticFailureCode {
  if (error instanceof JournalError) return error.code === 'conflict' ? 'conflict' : 'uncertain'
  if (error instanceof WorkflowRuntimeError && ['busy', 'conflict', 'closed', 'invalid-command', 'not-found', 'limit', 'corrupt'].includes(error.code))
    return error.code as AutomaticFailureCode
  return 'uncertain'
}
const asynchronous = <T>(value: T | Promise<T>): value is Promise<T> => value instanceof Promise

/** Internal live-commit owner, not a recovered outbox. Only acknowledged *new* reservations can launch a send. */
export class AutomaticApprovalOwner implements CommittedApprovalObserver {
  private readonly policy: ReturnType<typeof parseAutomaticApprovalPolicy>
  private readonly destinations: ReturnType<ApprovalNotificationDispatcher['destinations']>
  private readonly tasks = new Set<Promise<void>>()
  private readonly admissions = new Set<Promise<void>>()
  private reservations = 0
  private sealed = false
  private fault: { code: AutomaticFailureCode; requestId?: string; runId?: string; transition?: string } | undefined
  constructor(policy: unknown, private readonly persistence: AdmissionPersistence,
    private readonly dispatcher: Pick<ApprovalNotificationDispatcher, 'destinations' | 'send'>, private readonly maxPending = 16) {
    this.policy = parseAutomaticApprovalPolicy(policy)
    this.destinations = dispatcher.destinations()
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 64) throw new WorkflowRuntimeError('invalid-command')
    // Validate destination descriptors now; matching/provenance remain live-commit checks.
    new CommittedApprovalCapture(this.policy, this.destinations, 1)
  }
  busy() { return this.reservations !== 0 || this.tasks.size !== 0 || this.admissions.size !== 0 }
  snapshot() {
    return structuredClone({ pending: this.reservations, admitting: this.admissions.size, active: this.tasks.size, sealed: this.sealed,
      ...(this.fault ? { fault: this.fault } : {}), semantics: 'live-commits-only; no-replay; failure-is-not-proof-of-no-effect' as const })
  }
  refused(runId: string, transition: string, failure: ApprovalCaptureFault['code'] = 'corrupt') {
    this.fault ??= { code: failure, runId, transition }
  }
  private failed(error: unknown, requestId: string) { this.fault ??= { code: code(error), requestId } }
  committed(run: LocalRun, events: readonly { kind: string; at: string; data: unknown }[], transition: string, data: unknown): void | Promise<void> {
    if (this.sealed || this.fault) return
    // One ephemeral projector: no growing process-local candidate buffer or retained run/private values.
    const capture = new CommittedApprovalCapture(this.policy, this.destinations, 1)
    capture.committed(run, events, transition, data)
    const projection = capture.snapshot()
    if (projection.fault) { this.refused(run.id, transition, projection.fault.code); return }
    const admissions: Promise<void>[] = []
    for (const candidate of projection.candidates) for (const request of candidate.plan.requests) {
      try {
        const saturated = this.reservations >= this.maxPending
        const record = prepareAutomaticAdmission(this.policy, candidate.event, this.destinations, request,
          new Date().toISOString(), saturated ? 'busy' : undefined)
        if (!saturated) this.reservations++
        const release = () => { if (!saturated) this.reservations-- }
        try {
          const created = this.persistence.create(record)
          const admitted = (changed: boolean) => {
            if (!changed || saturated) { release(); return }
            this.launch(record, candidate.plan.actor, release)
          }
          if (asynchronous(created)) {
            const task = created.then(admitted, error => { release(); this.failed(error, request.requestId) })
              .finally(() => this.admissions.delete(task))
            this.admissions.add(task)
            admissions.push(task)
          }
          else admitted(created)
        } catch (error) { release(); this.failed(error, request.requestId) }
      } catch (error) { this.failed(error, request.requestId) }
    }
    // PostgreSQL awaits reservation acknowledgement *outside* its domain gate, never the HTTP send.
    if (admissions.length) return Promise.all(admissions).then(() => {})
  }
  private launch(record: AutomaticAdmissionRecord, actor: string, release: () => void) {
    const task = Promise.resolve().then(async () => {
      let terminal: AutomaticAdmissionRecord
      try { terminal = automaticDeliveryRecorded(record, await this.dispatcher.send(record.request, actor), new Date().toISOString()) }
      catch (error) { terminal = automaticAdmissionFailed(record, code(error), new Date().toISOString()) }
      try { await this.persistence.settle(terminal) }
      catch (error) { this.failed(error, record.request.requestId) }
    }).catch(error => this.failed(error, record.request.requestId)).finally(() => { release(); this.tasks.delete(task) })
    this.tasks.add(task)
  }
  /** Caller seals workflow admission first. Do not abort an accepted external effect or close owned credentials early. */
  async drain() {
    this.sealed = true
    await Promise.all([...this.admissions])
    await Promise.all([...this.tasks])
    if (this.reservations) throw new WorkflowRuntimeError('busy')
  }
}
