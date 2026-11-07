import { createHash } from 'node:crypto'
import { readBoundedBytes } from '../files.ts'
import { inspectManagementImageReceipt } from '../images/management.ts'
import { startDockerOwner, inspectDockerOwner, stopDockerOwner, restartDockerOwner, readDockerOwner, DockerLifecycleError } from '../docker/index.ts'
import { CliStorageUsageError, storageSelection, type CliValues } from './runtime.ts'
import { asyncRunPolicySchema } from '../http/async-runs.ts'

export const dockerFlags = {
  start: ['runtime', 'image-receipt', 'receipt-sha256', 'owner-file', 'port', 'token-file', 'tls-cert-file', 'tls-key-file', 'ca-file', 'memory-mb', 'cpus', 'wait-ms', 'telemetry-file', 'telemetry-credential-file', 'telemetry-ca-file', 'notifications-file', 'notifications-ca-file', 'rate-limits-file', 'rate-coordinator-file', 'async-concurrency', 'network', 'network-id', 'storage', 'database-file'],
  inspect: ['runtime', 'owner-file', 'owner-sha256', 'token-file', 'ca-file'],
  stop: ['runtime', 'owner-file', 'owner-sha256', 'container-id', 'wait-ms'],
  restart: ['runtime', 'owner-file', 'owner-sha256', 'container-id', 'token-file', 'ca-file', 'wait-ms'],
}
export async function dockerFromCli(action: keyof typeof dockerFlags, values: CliValues) {
  const required = (key: string) => {
    const value = values[key]
    if (typeof value !== 'string' || !value) throw new CliStorageUsageError(`Provide --${key}.`)
    return value
  }
  if (values.runtime !== 'docker') throw new CliStorageUsageError('This owner operation requires --runtime docker. Local services remain foreground processes; no fallback was attempted.')
  const number = (key: string, fallback?: number) => {
    if (values[key] === undefined && fallback !== undefined) return fallback
    const value = required(key)
    if (!/^(0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new CliStorageUsageError(`Provide an integer --${key}.`)
    return Number(value)
  }
  const client = () => ({ tokenFile: required('token-file'), ...(values['ca-file'] === undefined ? {} : { caFile: required('ca-file') }) })
  if (action === 'start') {
    if (values['rate-limits-file'] !== undefined && values['rate-coordinator-file'] !== undefined)
      throw new CliStorageUsageError('Select one HTTP rate policy.')
    const asyncRuns = values['async-concurrency'] === undefined ? undefined
      : asyncRunPolicySchema.safeParse({ maxConcurrentRuns: number('async-concurrency') })
    if (asyncRuns && !asyncRuns.success) throw new CliStorageUsageError('Provide --async-concurrency as an integer from 1 to 64.')
    const storage = storageSelection(values)
    const network = values.network === undefined && values['network-id'] === undefined ? undefined
      : { name: required('network'), id: required('network-id') }
    const receiptHash = required('receipt-sha256')
    if (!/^[a-f0-9]{64}$/u.test(receiptHash)) throw new DockerLifecycleError('invalid-options')
    const bytes = await readBoundedBytes(required('image-receipt'), 64000)
    if (createHash('sha256').update(bytes).digest('hex') !== receiptHash) throw new DockerLifecycleError('invalid-options')
    let image
    try { image = inspectManagementImageReceipt(JSON.parse(bytes.toString('utf8'))) } catch { throw new DockerLifecycleError('invalid-options') }
    return startDockerOwner({ image, ownerFile: required('owner-file'), hostPort: number('port'), ...client(), storage,
      ...(storage === 'postgres' ? { databaseFile: required('database-file') } : {}),
      certificateFile: required('tls-cert-file'), privateKeyFile: required('tls-key-file'),
      ...(values['telemetry-file'] === undefined ? {} : { telemetryFile: required('telemetry-file') }),
      ...(values['telemetry-credential-file'] === undefined ? {} : { telemetryCredentialFile: required('telemetry-credential-file') }),
      ...(values['telemetry-ca-file'] === undefined ? {} : { telemetryCaFile: required('telemetry-ca-file') }),
      ...(values['notifications-file'] === undefined ? {} : { notificationsFile: required('notifications-file') }),
      ...(values['notifications-ca-file'] === undefined ? {} : { notificationsCaFile: required('notifications-ca-file') }),
      ...(values['rate-limits-file'] === undefined ? {} : { rateLimitsFile: required('rate-limits-file') }),
      ...(values['rate-coordinator-file'] === undefined ? {} : { rateCoordinatorFile: required('rate-coordinator-file') }),
      ...(asyncRuns?.success ? { asyncRuns: asyncRuns.data } : {}),
      ...(network ? { network } : {}),
      memoryMb: number('memory-mb', 512), cpus: number('cpus', 1), waitMs: number('wait-ms', 10000) })
  }
  if (action === 'inspect' && values['ca-file'] !== undefined && values['token-file'] === undefined) throw new CliStorageUsageError('--ca-file requires --token-file for authenticated inspection.')
  const owner = await readDockerOwner(required('owner-file'), required('owner-sha256'))
  if (action === 'inspect') return inspectDockerOwner(owner, values['token-file'] === undefined ? undefined : client())
  if (action === 'stop') return stopDockerOwner(owner, required('container-id'), number('wait-ms', 10000))
  return restartDockerOwner(owner, required('container-id'), client(), number('wait-ms', 10000))
}
