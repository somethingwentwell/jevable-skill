import { z } from 'zod'

// This reader deliberately does not import exporters, storage, a runtime or a cluster client.
const uuid = z.uuid(), milliseconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const context = z.string().regex(/^00-(?!0{32}-)[a-f0-9]{32}-(?!0{16}-)[a-f0-9]{16}-01$/u)
const method = z.enum(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH', '_OTHER'])
const route = z.enum(['/', '/v1/capabilities', '/v1/health', '/v1/operations', '/v1/preview/bootstrap',
  '/v1/preview/operations', '/v1/preview/logout', '/v1/reviewer/decisions', '/v1/caller/operations',
  '/v1/caller/stream', '/v1/async-runs', '/v1/async-runs/{id}', '/v1/webhooks']).nullable()
export const httpObservationLedgerSchema = z.strictObject({ schemaVersion: z.literal(1),
  ownerAttribute: z.enum(['k8s.pod.uid', 'service.instance.id']), owners: z.array(uuid).min(1).max(128),
  clockDomain: z.literal('shared-unix-milliseconds'),
  intents: z.array(z.strictObject({ id: uuid, ownerId: uuid, startedMs: milliseconds, method, route })).min(1).max(5000),
  settlements: z.array(z.strictObject({ id: uuid, endedMs: milliseconds, status: z.number().int().min(100).max(599),
    context, bodyEnded: z.literal(true) })).max(5000),
})
export type HttpObservationLedger = z.infer<typeof httpObservationLedgerSchema>
export interface HttpObservationSignals { traces: string; metrics: string; logs: string }
export type HttpObservationVerificationFailure = 'invalid-input' | 'incomplete-evidence' | 'inconsistent-evidence' | 'limit'
export class HttpObservationVerificationError extends Error {
  constructor(readonly code: HttpObservationVerificationFailure) {
    super(`HTTP observation verification refused: ${code}.`)
    this.name = 'HttpObservationVerificationError'
  }
}
const fail = (code: HttpObservationVerificationFailure = 'inconsistent-evidence'): never => { throw new HttpObservationVerificationError(code) }
function require(value: unknown, code?: HttpObservationVerificationFailure): asserts value { if (!value) fail(code) }
type ObjectValue = Record<string, unknown>
function object(value: unknown): ObjectValue { require(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid-input'); return value as ObjectValue }
function array(value: unknown, maximum = 50000): unknown[] { require(Array.isArray(value), 'invalid-input'); require(value.length <= maximum, 'limit'); return value }
function clock(value: unknown): bigint {
  require(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/u.test(value), 'invalid-input')
  const result = BigInt(value); require(result <= 18446744073709551615n, 'invalid-input'); return result
}
function count(value: unknown): number {
  require(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    || typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/u.test(value), 'invalid-input')
  const result = Number(value); require(Number.isSafeInteger(result) && result >= 0, 'invalid-input'); return result
}
function attributes(record: ObjectValue): ObjectValue {
  const result: ObjectValue = Object.create(null)
  for (const raw of array(record.attributes ?? [], 64)) {
    const entry = object(raw); require(typeof entry.key === 'string' && entry.key.length > 0 && entry.key.length <= 128, 'invalid-input')
    require(!Object.hasOwn(result, entry.key)); const value = object(entry.value), keys = Object.keys(value)
    require(keys.length === 1, 'invalid-input'); const key = keys[0]!
    require(['stringValue', 'intValue', 'doubleValue', 'boolValue'].includes(key), 'invalid-input')
    const scalar = value[key]
    if (key === 'stringValue') require(typeof scalar === 'string' && scalar.length <= 1024, 'invalid-input')
    if (key === 'doubleValue') require(typeof scalar === 'number' && Number.isFinite(scalar), 'invalid-input')
    if (key === 'boolValue') require(typeof scalar === 'boolean', 'invalid-input')
    result[entry.key] = key === 'intValue' ? count(scalar) : scalar
  }
  return result
}
function exactKeys(value: ObjectValue, names: string[]) {
  const keys = Object.keys(value).sort(), wanted = [...names].sort()
  require(keys.length === wanted.length && keys.every((key, i) => key === wanted[i]))
}
const LABELS = ['http.request.method', 'jevable.http.status_class', 'jevable.http.outcome']
const RATE_FIELDS = ['jevable.http.rate.trace_id', 'jevable.http.rate.span_id', 'jevable.http.rate.sampled']
const BOUNDS = [.001, .01, .1, .5, 1, 5, 10, 30, 60, 300, 3600]
function packets(text: unknown, resourceKey: string): ObjectValue[] {
  require(typeof text === 'string', 'invalid-input'); require(Buffer.byteLength(text) <= 16 * 1024 * 1024, 'limit')
  const lines = text.trim().split('\n'); require(lines.length <= 10000, 'limit')
  const result: ObjectValue[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    let parsed: unknown; try { parsed = JSON.parse(line) } catch { fail('invalid-input') }
    const packet = object(parsed); require(Object.hasOwn(packet, resourceKey), 'invalid-input')
    for (const resource of array(packet[resourceKey])) { result.push(object(resource)); require(result.length <= 50000, 'limit') }
  }
  return result
}
function near(actual: unknown, expected: number, population: number) {
  require(typeof actual === 'number' && Number.isFinite(actual) && actual >= 0)
  require(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * Number.EPSILON * Math.max(1, population))
}

/**
 * Reconcile supplied independent completed-response evidence with unfiltered Jevable HTTP signals.
 * Requires sampled response contexts, cumulative metrics, a shared clock and one resource instance
 * per declared owner. No I/O or execution. A match is not attestation of capture completeness,
 * backend durability, disconnected requests, business commits or production qualification.
 */
export function verifyHttpObservations(input: unknown, signals: HttpObservationSignals) {
  const admission = httpObservationLedgerSchema.safeParse(input); if (!admission.success) return fail('invalid-input')
  const signalAdmission = z.strictObject({ traces: z.string(), metrics: z.string(), logs: z.string() }).safeParse(signals)
  if (!signalAdmission.success) return fail('invalid-input')
  const ledger = admission.data, owners = new Set(ledger.owners)
  require(owners.size === ledger.owners.length); require(ledger.intents.length === ledger.settlements.length, 'incomplete-evidence')
  const ids = new Set<string>(), responseContexts = new Set<string>(), settlements = new Map<string, typeof ledger.settlements[number]>()
  for (const settlement of ledger.settlements) { require(!settlements.has(settlement.id)); settlements.set(settlement.id, settlement) }
  const witnesses = new Map<string, { intent: typeof ledger.intents[number]; settlement: typeof ledger.settlements[number] }>()
  const usedOwners = new Set<string>()
  for (const intent of ledger.intents) {
    require(!ids.has(intent.id)); ids.add(intent.id); require(owners.has(intent.ownerId)); usedOwners.add(intent.ownerId)
    const settlement = settlements.get(intent.id); require(settlement, 'incomplete-evidence'); require(settlement.endedMs >= intent.startedMs)
    require(!responseContexts.has(settlement.context)); responseContexts.add(settlement.context)
    const [, traceId, spanId] = settlement.context.split('-'); witnesses.set(traceId + '/' + spanId, { intent, settlement })
  }
  require(usedOwners.size === owners.size, 'incomplete-evidence')
  const instances = new Map<string, string>(), instanceOwners = new Map<string, string>()
  const owner = (resource: ObjectValue) => {
    const a = attributes(object(resource.resource)), id = a[ledger.ownerAttribute], instance = a['service.instance.id']
    require(typeof id === 'string' && owners.has(id)); require(typeof instance === 'string' && uuid.safeParse(instance).success, 'invalid-input')
    const old = instances.get(id), oldOwner = instanceOwners.get(instance)
    require((old === undefined || old === instance) && (oldOwner === undefined || oldOwner === id))
    instances.set(id, instance); instanceOwners.set(instance, id); return id
  }
  interface Observation { ownerId: string; record: ObjectValue }
  const observations = (text: string, resourceKey: string, scopeKey: string, recordKey: string, nameKey: string, name: string, scopeName: string) => {
    const result = new Map<string, Observation>()
    for (const resource of packets(text, resourceKey)) for (const scope of array(resource[scopeKey] ?? [])) {
      const group = object(scope)
      for (const raw of array(group[recordKey] ?? [])) {
        const record = object(raw); if (record[nameKey] !== name) continue
        require(object(group.scope).name === scopeName); const ownerId = owner(resource)
        require(typeof record.traceId === 'string' && /^(?!0{32}$)[a-f0-9]{32}$/u.test(record.traceId))
        require(typeof record.spanId === 'string' && /^(?!0{16}$)[a-f0-9]{16}$/u.test(record.spanId))
        const key = record.traceId + '/' + record.spanId; require(!result.has(key)); require(witnesses.has(key), 'incomplete-evidence')
        require((record.droppedAttributesCount ?? 0) === 0); result.set(key, { ownerId, record })
        require(result.size <= 5000, 'limit')
      }
    }
    require(result.size === witnesses.size, 'incomplete-evidence'); return result
  }
  const spans = observations(signals.traces, 'resourceSpans', 'scopeSpans', 'spans', 'name', 'jevable.http.request', 'jevable.http')
  const logs = observations(signals.logs, 'resourceLogs', 'scopeLogs', 'logRecords', 'eventName', 'jevable.http.request.ended', 'jevable.workflow')
  const requests = new Map<string, { time: bigint; seconds: number }[]>(), ownerCounts = new Map<string, number>()
  let rateContexts = 0, sampledRateContexts = 0
  const seriesKey = (ownerId: string, a: ObjectValue) => JSON.stringify([ownerId, a['http.request.method'], a['http.route'] ?? null, a['jevable.http.status_class'], a['jevable.http.outcome']])
  for (const [identity, { intent, settlement }] of witnesses) {
    const span = spans.get(identity)!, log = logs.get(identity)!
    require(span.ownerId === intent.ownerId && log.ownerId === intent.ownerId)
    require(span.record.kind === 2)
    const start = clock(span.record.startTimeUnixNano), end = clock(span.record.endTimeUnixNano), ended = clock(log.record.timeUnixNano)
    const responseEnd = (BigInt(settlement.endedMs) + 1n) * 1000000n
    require(start >= BigInt(intent.startedMs) * 1000000n && end >= start && end < responseEnd)
    require(ended >= end && ended < responseEnd)
    // The owned HTTP observer emits one detached quota context, never arbitrary link metadata.
    // Validate its HTTP-side correlation only: a link is not a quota receipt or SQL/COMMIT proof.
    const spanAttributes = attributes(span.record), rate: ObjectValue = Object.create(null)
    const rateFieldsPresent = RATE_FIELDS.filter(key => Object.hasOwn(spanAttributes, key))
    const links = array(span.record.links ?? [], 1)
    if (rateFieldsPresent.length) {
      require(rateFieldsPresent.length === RATE_FIELDS.length)
      const traceId = spanAttributes[RATE_FIELDS[0]!], spanId = spanAttributes[RATE_FIELDS[1]!], sampled = spanAttributes[RATE_FIELDS[2]!]
      require(typeof traceId === 'string' && /^(?!0{32}$)[a-f0-9]{32}$/u.test(traceId))
      require(typeof spanId === 'string' && /^(?!0{16}$)[a-f0-9]{16}$/u.test(spanId)); require(typeof sampled === 'boolean')
      require(traceId !== span.record.traceId || spanId !== span.record.spanId)
      require(links.length === 1); const link = object(links[0])
      require(Object.keys(link).every(key => ['traceId', 'spanId', 'flags', 'attributes', 'droppedAttributesCount'].includes(key)))
      require(link.traceId === traceId && link.spanId === spanId)
      const flags = link.flags ?? 0
      require(typeof flags === 'number' && Number.isInteger(flags) && flags >= 0 && flags <= 0xffffffff)
      require(Boolean(flags & 1) === sampled)
      require(array(link.attributes ?? [], 0).length === 0 && (link.droppedAttributesCount ?? 0) === 0)
      for (const key of RATE_FIELDS) rate[key] = spanAttributes[key]
      rateContexts++; if (sampled) sampledRateContexts++
    } else require(links.length === 0)
    const expected: ObjectValue = { 'http.request.method': intent.method, 'jevable.http.status_class': Math.floor(settlement.status / 100) + 'xx',
      'jevable.http.outcome': 'response-finished', 'http.response.status_code': settlement.status,
      ...(intent.route === null ? {} : { 'http.route': intent.route }), ...(settlement.status >= 500 ? { 'error.type': String(settlement.status) } : {}), ...rate }
    for (const record of [span.record, log.record]) {
      const a = attributes(record); exactKeys(a, [...Object.keys(expected), ...(record === log.record ? ['jevable.duration.seconds'] : [])])
      for (const [key, value] of Object.entries(expected)) require(a[key] === value)
    }
    require((object(span.record.status ?? {}).code ?? 0) === (settlement.status >= 500 ? 2 : 0))
    require(object(log.record.body).stringValue === 'jevable.http.request.ended'); require(log.record.severityNumber === (settlement.status >= 500 ? 17 : 9))
    const seconds = attributes(log.record)['jevable.duration.seconds']; require(typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0)
    require(seconds <= (settlement.endedMs - intent.startedMs + 1) / 1000)
    const key = seriesKey(intent.ownerId, expected), group = requests.get(key) ?? []
    group.push({ time: ended, seconds }); requests.set(key, group); ownerCounts.set(intent.ownerId, (ownerCounts.get(intent.ownerId) ?? 0) + 1)
  }
  const latest = new Map<string, { time: bigint; start: bigint; histogramStart: bigint; count: number; sum: number }>()
  for (const ownerId of owners) {
    require([...requests.keys()].filter(key => JSON.parse(key)[0] === ownerId).length <= 128, 'limit')
  }
  let distributionSnapshots = 0
  for (const resource of packets(signals.metrics, 'resourceMetrics')) {
    const families: ObjectValue[] = []
    for (const raw of array(resource.scopeMetrics ?? [])) {
      const scope = object(raw)
      for (const metric of array(scope.metrics ?? [])) {
        const item = object(metric)
        if (item.name === 'jevable.http.requests' || item.name === 'jevable.http.duration') {
          require(object(scope.scope).name === 'jevable.workflow'); families.push(item)
        }
      }
    }
    if (!families.length) continue
    require(families.length === 2 && new Set(families.map(f => f.name)).size === 2)
    const ownerId = owner(resource), counter = families.find(f => f.name === 'jevable.http.requests')!, histogram = families.find(f => f.name === 'jevable.http.duration')!
    require(counter.unit === '{request}' && histogram.unit === 's')
    const sum = object(counter.sum), distribution = object(histogram.histogram)
    require(sum.aggregationTemporality === 2 && sum.isMonotonic === true && distribution.aggregationTemporality === 2)
    const histograms = new Map<string, ObjectValue>()
    for (const raw of array(distribution.dataPoints, 128)) {
      const point = object(raw), a = attributes(point), key = seriesKey(ownerId, a)
      exactKeys(a, [...LABELS, ...(a['http.route'] === undefined ? [] : ['http.route'])]); require(!histograms.has(key)); histograms.set(key, point)
      require((point.flags ?? 0) === 0)
    }
    const points = array(sum.dataPoints, 128); require(points.length === histograms.size)
    const seen = new Set<string>()
    for (const raw of points) {
      const point = object(raw), a = attributes(point), key = seriesKey(ownerId, a)
      exactKeys(a, [...LABELS, ...(a['http.route'] === undefined ? [] : ['http.route'])]); require(!seen.has(key)); seen.add(key)
      const h = histograms.get(key); require(h); const observed = requests.get(key); require(observed, 'incomplete-evidence')
      require((point.flags ?? 0) === 0)
      require(['asInt', 'asDouble'].filter(k => Object.hasOwn(point, k)).length === 1)
      const total = count(point.asInt ?? point.asDouble), time = clock(point.timeUnixNano), start = clock(point.startTimeUnixNano)
      const histogramStart = clock(h.startTimeUnixNano)
      // Separate OTel instruments start accumulating at their own first measurement.
      // Sequential add/record can cross a clock tick; each stream must retain its own
      // stable start, not share an invented timestamp. Pair the collection window end.
      require(time >= start && time >= histogramStart && point.timeUnixNano === h.timeUnixNano)
      require(count(h.count) === total)
      const bounds = array(h.explicitBounds, 11); require(bounds.length === BOUNDS.length && bounds.every((b, i) => b === BOUNDS[i]))
      const buckets = array(h.bucketCounts, 12).map(count); require(buckets.length === 12 && buckets.reduce((a, b) => a + b, 0) === total)
      require(array(h.exemplars ?? []).length === 0 && array(point.exemplars ?? []).length === 0)
      const previous = latest.get(key); if (previous) require(previous.start === start && previous.histogramStart === histogramStart
        && time >= previous.time && total >= previous.count && Number(h.sum) >= previous.sum)
      const endedByCollection = observed.filter(r => r.time <= time); require(endedByCollection.length === total)
      require(endedByCollection.every(r => r.time >= start && r.time >= histogramStart))
      require(total > 0); const seconds = endedByCollection.map(r => r.seconds)
      near(h.sum, seconds.reduce((a, b) => a + b, 0), total)
      require(h.min === Math.min(...seconds) && h.max === Math.max(...seconds))
      const actualBuckets = Array<number>(12).fill(0)
      for (const duration of seconds) { const index = BOUNDS.findIndex(b => duration <= b); actualBuckets[index < 0 ? 11 : index]!++ }
      require(buckets.every((value, i) => value === actualBuckets[i]))
      latest.set(key, { time, start, histogramStart, count: total, sum: h.sum as number }); distributionSnapshots++
    }
  }
  require(latest.size === requests.size, 'incomplete-evidence')
  for (const [key, group] of requests) {
    const final = latest.get(key); require(final, 'incomplete-evidence'); require(final.count === group.length && group.every(r => r.time <= final.time), 'incomplete-evidence')
  }
  return { status: 'matched-recorded-http-observations' as const, responseJoins: witnesses.size, requestSpans: spans.size, requestLogs: logs.size,
    cumulativeRequestTotal: [...latest.values()].reduce((sum, p) => sum + p.count, 0), boundedSeries: latest.size, distributionSnapshots,
    owners: ledger.owners.map(ownerId => ({ ownerId, responses: ownerCounts.get(ownerId)! })),
    ...(rateContexts ? { rateAdmissionLinks: { contexts: rateContexts, sampled: sampledRateContexts,
      unsampled: rateContexts - sampledRateContexts,
      scope: 'HTTP-side owned context correlation only; not received quota observations, admission receipts or SQL/COMMIT proof.' } } : {}),
    scope: 'Supplied completed-response ledger and received Jevable HTTP signals only; not capture completeness, disconnected requests, business commits or backend durability.' }
}
