import type { NotificationTelemetry } from './schema.ts'

/** These are live process observations, not proof of dispatch, database commit or human receipt. */
export interface NotificationObservationResult {
  outcome: 'intent-not-acknowledged' | 'settlement-not-acknowledged' | 'receipt-only' | 'accepted' | 'rejected' | 'uncertain'
  intentAcknowledged: boolean
  transportAttempted: boolean
  settlementAcknowledged: boolean
  httpStatus?: number
  reason?: 'transport' | 'timeout' | 'aborted' | 'invalid-response'
}
export interface NotificationObservation {
  readonly telemetry: NotificationTelemetry
  finish(result: NotificationObservationResult): void
}
