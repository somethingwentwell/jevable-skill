import { WorkflowRuntimeError } from '../runtime/errors.ts'
import type { NotificationRuntimePolicy } from './config.ts'
import { inspectRelease, type Release } from '../releases/snapshot.ts'

type Automatic = NonNullable<NotificationRuntimePolicy['automatic']>
/** Trusted startup import, not execution or approval authority. Exact-release hosts
 * cannot use their notification file to select a project or another release.
 * Packaged entries separately verify actual embedded runtime bytes before this call.
 */
export function prepareAutomaticStartupRelease(value: unknown, config: Automatic | undefined): Release | undefined {
  if (value === undefined) return undefined
  if (!config || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'snapshot') || !Object.hasOwn(value, 'sha256'))
    throw new WorkflowRuntimeError('invalid-command')
  const supplied = value as Release, release = inspectRelease(supplied.snapshot)
  if (supplied.sha256 !== release.sha256) throw new WorkflowRuntimeError('conflict')
  for (const { scope } of config.policy.routes) {
    if (scope.kind !== 'release' || scope.id !== release.snapshot.id || scope.sha256 !== release.sha256
      || scope.revision !== release.snapshot.workflow.revision) throw new WorkflowRuntimeError('conflict')
  }
  return release
}

/** Read retained state first. Only absence of this exact reviewed startup release
 * permits the candidate; corrupt or conflicting existing state is never replaced.
 */
export async function automaticStartupReleaseRead<T>(id: string, read: () => T | Promise<T>, startup: Release | undefined): Promise<T | Release> {
  try { return await read() }
  catch (error) {
    if (startup?.snapshot.id === id && error instanceof WorkflowRuntimeError && error.code === 'not-found') return startup
    throw error
  }
}
/** Existing sole owner's verified reads only. Never send, recover a reservation, alter a scope or resolve credentials. */
export async function verifyAutomaticStartupScopes(config: Automatic, host: {
  project(id: string, generation?: number): { generation: number; acceptedRevision: string } | Promise<{ generation: number; acceptedRevision: string }>
  release(id: string): { sha256: string; snapshot: { workflow: { revision: string } } } | Promise<{ sha256: string; snapshot: { workflow: { revision: string } } }>
}) {
  for (const { scope } of config.policy.routes) {
    if (scope.kind === 'project') {
      const current = await host.project(scope.id)
      if (scope.generation > current.generation) throw new WorkflowRuntimeError('conflict')
      const selected = await host.project(scope.id, scope.generation)
      if (selected.generation !== scope.generation || selected.acceptedRevision !== scope.revision) throw new WorkflowRuntimeError('conflict')
    } else {
      const selected = await host.release(scope.id)
      if (selected.sha256 !== scope.sha256 || selected.snapshot.workflow.revision !== scope.revision) throw new WorkflowRuntimeError('conflict')
    }
  }
}
