import { CallerClient, RuntimeHttpError } from '../http/client.ts'
import { callerReleasePinSchema, callerStartRequestSchema, callerCancellationRequestSchema } from '../access/caller.ts'
import { callerControlRequestSchema } from '../access/caller-control.ts'
import { grantIdSchema } from '../access/grants.ts'
import { admitWorkflowData } from '../workflow/index.ts'
import { readBoundedFile } from '../files.ts'
import { readSecretFile } from '../providers/secret-input.ts'
import { readTlsPemFile } from '../http/tls.ts'
import { CliStorageUsageError, type CliValues } from './runtime.ts'
import { reviewerSelection } from './reviewer.ts'
import { callerStreamOptionsSchema } from '../http/caller-stream.ts'
import { readCliTraceContext } from './trace-context.ts'

/** Explicit grant transport selector. No state/backend/Docker or owner discovery. */
export function callerSelection(values: CliValues) {
  reviewerSelection(values, 'Caller operations')
  if (typeof values['release-pin-file'] !== 'string' || !values['release-pin-file'])
    throw new CliStorageUsageError('Caller operations require a reviewed release pin JSON file.')
}

/** NDJSON observation from one grant-authorized SSE connection; stopping it never cancels the run. */
export async function callerStreamFromCli(value: string, values: CliValues, out: (line: string) => void,
  signals: { on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown; removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown } = process): Promise<number> {
  callerSelection(values)
  if (values['trace-context-file'] !== undefined) throw new CliStorageUsageError('Trace context files are not supported by SSE observation.')
  let id, settings, pin
  try {
    id = grantIdSchema.parse(value).toLowerCase()
    settings = callerStreamOptionsSchema.parse({ intervalMs: Number(values['interval-ms'] ?? 1000),
      durationMs: Number(values['duration-ms'] ?? 15000), follow: values.follow === true })
    pin = callerReleasePinSchema.parse(JSON.parse(await readBoundedFile(values['release-pin-file'] as string, 4096)))
  } catch { throw new RuntimeHttpError('invalid-command') }
  const token = await readSecretFile(values['token-file'] as string)
  const ca = values['ca-file'] === undefined ? undefined : await readTlsPemFile(values['ca-file'] as string)
  const client = new CallerClient(values.endpoint as string, token, values['instance-id'] as string, pin,
    Number(values['timeout-ms'] ?? 30000), 20_000_000, ca === undefined ? {} : { ca })
  const controller = new AbortController()
  let interrupted = 130
  const int = () => { interrupted = 130; controller.abort() }, term = () => { interrupted = 143; controller.abort() }
  signals.on('SIGINT', int); signals.on('SIGTERM', term)
  try {
    for await (const event of client.stream(id, { ...settings, signal: controller.signal })) {
      out(JSON.stringify(event) + '\n')
      if (event.type === 'stopped') return { completed: 0, failed: 4, cancelled: 7, attention: 3, deadline: 8,
        interrupted, draining: 9, 'read-refused': 9 }[event.reason]
    }
    return 1
  } finally { signals.removeListener('SIGINT', int); signals.removeListener('SIGTERM', term) }
}
export async function callerFromCli(action: 'start' | 'read' | 'cancel' | 'checkpoint' | 'control', value: string, values: CliValues) {
  callerSelection(values)
  let pin, request, cancellation, control, id
  try {
    pin = callerReleasePinSchema.parse(JSON.parse(await readBoundedFile(values['release-pin-file'] as string, 4096)))
    if (action === 'start') request = callerStartRequestSchema.parse(admitWorkflowData(JSON.parse(await readBoundedFile(value, 4_000_000)),
      { maxBytes: 4_000_000, maxDepth: 64, maxValues: 100_000 }))
    else {
      id = grantIdSchema.parse(value)
      if (action === 'cancel') cancellation = callerCancellationRequestSchema.parse(JSON.parse(await readBoundedFile(values['request-file'] as string, 4096)))
      if (action === 'control') control = callerControlRequestSchema.parse(admitWorkflowData(JSON.parse(await readBoundedFile(values['request-file'] as string, 16384)),
        { maxBytes: 16384, maxDepth: 8, maxValues: 256 }))
    }
  } catch { throw new RuntimeHttpError('invalid-command') }
  // Validate request and reviewed pins before opening any credential or contacting the host.
  const context = await readCliTraceContext(values['trace-context-file'])
  const token = await readSecretFile(values['token-file'] as string)
  const ca = values['ca-file'] === undefined ? undefined : await readTlsPemFile(values['ca-file'] as string)
  const client = new CallerClient(values.endpoint as string, token, values['instance-id'] as string, pin,
    Number(values['timeout-ms'] ?? 30000), 20_000_000, ca === undefined ? {} : { ca })
  return action === 'start' ? client.start(request!, context) : action === 'cancel' ? client.cancel(id!, cancellation!, context)
    : action === 'checkpoint' ? client.checkpoint(id!, context) : action === 'control' ? client.control(id!, control!, context) : client.read(id!, context)
}
