import { z } from 'zod'
import { RuntimeHttpError, type RuntimeClient, type RuntimeTraceContext } from '../http/client.ts'
import { createOperationTestSuiteHost } from './operation-host.ts'
import type { TestSuiteTelemetry } from './telemetry.ts'
import type { TestSuiteHost } from './suite.ts'
import { PROTOCOL_VERSION } from '../capabilities.ts'

/** Client-side orchestration over existing guarded owner operations; no new execution endpoint. */
export function createHttpTestSuiteHost(client: RuntimeClient, traceContext?: RuntimeTraceContext, telemetry?: TestSuiteTelemetry): TestSuiteHost {
  let instanceId: string | undefined
  let initialized: Promise<void> | undefined
  const initialize = () => initialized ??= (async () => {
    const capabilities = z.object({ instanceId: z.uuid(), api: z.object({ protocol: z.literal(PROTOCOL_VERSION) }) })
      .safeParse(await client.capabilities())
    if (!capabilities.success) throw new RuntimeHttpError('invalid-response')
    client.pinInstance(capabilities.data.instanceId)
    instanceId = capabilities.data.instanceId
  })()
  const call = async (command: Parameters<RuntimeClient['operation']>[0], context?: RuntimeTraceContext) => {
    // Bootstrap is read-only and shared by concurrent callers. Its immutable pin
    // is sent before any operation, so a replacement rejects before mutation.
    // A failed handshake poisons this host; do not discover/retry another owner.
    await initialize()
    const parsed = z.object({ schemaVersion: z.literal(1), instanceId: z.uuid(), result: z.unknown() }).safeParse(await client.operation(command, context))
    if (!parsed.success) throw new RuntimeHttpError('invalid-response')
    if (instanceId && instanceId !== parsed.data.instanceId) throw new RuntimeHttpError('conflict')
    instanceId = parsed.data.instanceId
    return parsed.data.result
  }
  return createOperationTestSuiteHost({ call }, traceContext, telemetry)
}
