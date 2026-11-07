declare module '*check-postgres-telemetry.mjs' {
  export function traceRecords(bytes: Uint8Array): { traceId: string; spanId: string; parent?: string; name: string; attributes: Record<string, string | number | boolean> }[]
}
declare module '*check-telemetry-package.mjs' {
  export function fields(bytes: Uint8Array): Map<number, any[]>
  export function resourceAttributes(bytes: Uint8Array): Record<string, string>[]
  export function metricSums(bytes: Uint8Array): { name: string; temporality: number; points: { value: number; labels: Record<string, string | boolean> }[] }[]
  export function logRecords(bytes: Uint8Array): { event: string; body: string; severity: number; traceId: string; spanId: string; attributes: Record<string, string | number | boolean> }[]
}
