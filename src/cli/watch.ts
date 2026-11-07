import { z } from 'zod'
import { RuntimeClient } from '../http/client.ts'
import { ReleaseClient } from '../releases/client.ts'
import { watchRun } from '../http/watch.ts'
import { readSecretFile } from '../providers/secret-input.ts'
import { readTlsPemFile } from '../http/tls.ts'
import { CliStorageUsageError, type CliValues } from './runtime.ts'

export async function watchFromCli(id: string, values: CliValues, out: (line: string) => void,
  signals: { on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown; removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown } = process): Promise<number> {
  const required = (key: string) => {
    const value = values[key]
    if (typeof value !== 'string' || !value) throw new CliStorageUsageError(`Watch requires --${key}.`)
    return value
  }
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = values[key], value = raw === undefined ? fallback : Number(raw)
    if ((raw !== undefined && (typeof raw !== 'string' || !/^[1-9][0-9]*$/u.test(raw))) || !Number.isInteger(value) || value < min || value > max) {
      throw new CliStorageUsageError(`Watch --${key} must be ${min}–${max}.`)
    }
    return value
  }
  if (!z.uuid().safeParse(id).success) throw new CliStorageUsageError('Watch requires a retained run UUID.')
  const endpoint = required('endpoint'), tokenFile = required('token-file')
  const intervalMs = integer('interval-ms', 1000, 100, 60000), durationMs = integer('duration-ms', 60000, 1, 3600000)
  const releaseHash = values['release-sha256']
  if (releaseHash !== undefined && (typeof releaseHash !== 'string' || !/^[a-f0-9]{64}$/u.test(releaseHash))) throw new CliStorageUsageError('Provide the reviewed --release-sha256 for a release service.')
  const token = await readSecretFile(tokenFile), ca = values['ca-file'] === undefined ? undefined : await readTlsPemFile(required('ca-file'))
  // No database owner, ambient endpoint, retry or runtime process is created.
  const timeout = Math.min(3000, durationMs), tls = ca === undefined ? {} : { ca }
  const client = typeof releaseHash === 'string' ? new ReleaseClient(endpoint, token, releaseHash, timeout, tls)
    : new RuntimeClient(endpoint, token, timeout, 20_000_000, tls)
  const controller = new AbortController()
  let interrupted = 130
  const int = () => { interrupted = 130; controller.abort() }, term = () => { interrupted = 143; controller.abort() }
  signals.on('SIGINT', int); signals.on('SIGTERM', term)
  try {
    for await (const event of watchRun(client, id, { intervalMs, durationMs, follow: values.follow === true, signal: controller.signal })) {
      out(JSON.stringify(event) + '\n')
      if (event.type === 'stopped') return { completed: 0, failed: 4, cancelled: 7, attention: 3, deadline: 8, interrupted }[event.reason]
    }
    return 1
  } finally { signals.removeListener('SIGINT', int); signals.removeListener('SIGTERM', term) }
}
