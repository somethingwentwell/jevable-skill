import type { startRuntimeServer } from './server.ts'

type Service = Awaited<ReturnType<typeof startRuntimeServer>>
type Signals = {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

/** Own the CLI service lifetime, including signals received while storage/listener startup is pending. */
export async function runServiceProcess(start: () => Promise<Service>, storage: 'sqlite' | 'postgres' | 'selected-owner',
  emit: (value: unknown) => void, drainWaitMs = 5000, signals: Signals = process,
  ready?: (service: Service) => object): Promise<number> {
  let service: Service | undefined, requested = false, observing: Promise<void> | undefined
  const stop = () => {
    requested = true
    if (!service || observing) return
    observing = service.close(drainWaitMs).then(status => {
      if (status.status === 'draining') emit({ schemaVersion: 1, storage, ...status })
    })
    // Failure is also observable through service.closed; do not cause an unhandled rejection.
    void observing.catch(() => {})
  }
  signals.on('SIGINT', stop); signals.on('SIGTERM', stop)
  try {
    service = await start()
    const startupCancelled = requested
    if (requested) stop()
    else emit(ready ? ready(service) : { schemaVersion: 1, status: 'ready', storage, url: service.url, instanceId: service.instanceId, protocol: service.protocol,
      transport: service.transport, listener: service.listener, ...(service.tls ? { tls: service.tls } : {}),
      ...(service.telemetryResource ? { telemetryResource: service.telemetryResource } : {}),
      ...(service.release ? { release: service.release } : {}),
      auth: 'bearer token from the private token file; never a URL parameter', servesHtml: Boolean(service.release || service.preview) })
    await service.closed
    await observing
    emit({ schemaVersion: 1, status: 'closed', storage, activeRequests: 0, ...(startupCancelled ? { startupCancelled: true } : {}) })
    return 0
  } finally {
    // Cleanup also covers a broken output sink during the readiness receipt.
    try { if (service) { await service.close(); await service.closed } }
    finally { signals.off('SIGINT', stop); signals.off('SIGTERM', stop) }
  }
}
