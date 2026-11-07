import { z } from 'zod'
import { WorkflowRuntimeError } from './errors.ts'
import { apiTriggerModeSchema } from './trigger.ts'
import type { RunStartOptions } from './control.ts'
import type { LocalRun } from './run-types.ts'

/** Retain this UUID before submission; admission can commit even if its acknowledgement is lost. */
export interface AsyncRunOptions extends RunStartOptions { id: string }
export interface AsyncRun {
  /** A new durable checkpoint, or an observation of an identical retained submission. */
  observation: 'created' | 'retained'
  /** Detached admission-time snapshot, not a promise that the workflow is still paused. Private owner data. */
  run: LocalRun
  /** This invocation's execution/observation. A resolved approval wait is not workflow completion. */
  completion: Promise<LocalRun>
}

const optionsSchema = z.strictObject({ id: z.uuid(), paused: z.boolean().optional(), triggerMode: apiTriggerModeSchema.optional() })
export function parseAsyncRunOptions(value: AsyncRunOptions): AsyncRunOptions {
  const parsed = optionsSchema.safeParse(value)
  if (!parsed.success) throw new WorkflowRuntimeError('invalid-command')
  return { id: parsed.data.id, ...(parsed.data.paused === undefined ? {} : { paused: parsed.data.paused }),
    ...(parsed.data.triggerMode === undefined ? {} : { triggerMode: parsed.data.triggerMode }) }
}

/** Internal callback is reached only after acknowledged durable creation, before first dispatch.
 * No queue, detached owner, timer, automatic resume or error-to-success conversion is introduced.
 */
export function admitAsyncRun(start: (created: (run: LocalRun) => void) => Promise<LocalRun>): Promise<AsyncRun> {
  let resolve!: (value: AsyncRun) => void, reject!: (reason: unknown) => void
  const admission = new Promise<AsyncRun>((yes, no) => { resolve = yes; reject = no })
  let completion: Promise<LocalRun> | undefined, snapshot: Pick<AsyncRun, 'observation' | 'run'> | undefined
  const publish = (run: LocalRun, observation: AsyncRun['observation']) => {
    if (snapshot) return
    snapshot = { observation, run: structuredClone(run) }
    if (completion) resolve({ ...snapshot, completion })
  }
  // Start immediately to preserve operation/run reservation before another caller can close the owner.
  try { completion = start(run => publish(run, 'created')) }
  catch (error) { completion = Promise.reject(error) }
  if (snapshot) resolve({ ...snapshot, completion })
  // Observe rejection even if the consumer only retains admission. The original completion still rejects.
  void completion.then(run => publish(run, 'retained'), error => reject(error))
  return admission
}
