import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { verifyHttpObservations, HttpObservationVerificationError, type HttpObservationLedger } from '../src/telemetry/index.ts'

const bounds = [.001, .01, .1, .5, 1, 5, 10, 30, 60, 300, 3600]
const durations = [.0005, .002, .03, .15, .7, 2, 8, 15, 45, 100, 500, 4000]
const attr = (values: Record<string, string | number>) => Object.entries(values).map(([key, value]) => ({ key,
  value: typeof value === 'string' ? { stringValue: value } : { doubleValue: value } }))
const ns = (ms: number) => (BigInt(ms) * 1000000n).toString()
function fixture(population = 7, ownerCount = 1, nullRoute = false) {
  const owners = Array.from({ length: ownerCount }, () => randomUUID()), instances = owners.map(() => randomUUID())
  const ledger: HttpObservationLedger = { schemaVersion: 1, ownerAttribute: 'k8s.pod.uid', owners,
    clockDomain: 'shared-unix-milliseconds', intents: [], settlements: [] }
  const responses = Array.from({ length: population }, (_, index) => {
    const owner = index < ownerCount ? index : 0, id = randomUUID(), startedMs = 1000000 + index * 5000000
    const seconds = durations[index % durations.length]!, endedMs = startedMs + Math.ceil(seconds * 1000) + 2
    const status = index % 3 === 0 ? 500 : index % 3 === 1 ? 401 : 200
    const traceId = (index + 1).toString(16).padStart(32, '0'), spanId = (index + 1).toString(16).padStart(16, '0')
    const context = `00-${traceId}-${spanId}-01`, route = nullRoute ? null : '/v1/health' as const
    ledger.intents.push({ id, ownerId: owners[owner]!, startedMs, method: 'GET', route })
    ledger.settlements.push({ id, endedMs, status, context, bodyEnded: true })
    const labels = { 'http.request.method': 'GET', 'jevable.http.status_class': Math.floor(status / 100) + 'xx',
      'jevable.http.outcome': 'response-finished', ...(route === null ? {} : { 'http.route': route }) }
    const attributes = { ...labels, 'http.response.status_code': status, ...(status === 500 ? { 'error.type': '500' } : {}) }
    const end = ns(endedMs - 1)
    return { owner, seconds, labels, endedMs, span: { name: 'jevable.http.request', traceId, spanId, kind: 2,
      startTimeUnixNano: ns(startedMs), endTimeUnixNano: end, attributes: attr(attributes), status: { code: status === 500 ? 2 : 0 } },
    log: { eventName: 'jevable.http.request.ended', traceId, spanId, timeUnixNano: end,
      severityNumber: status === 500 ? 17 : 9, body: { stringValue: 'jevable.http.request.ended' },
      attributes: attr({ ...attributes, 'jevable.duration.seconds': seconds }) } }
  })
  const resource = (owner: number) => ({ attributes: attr({ 'k8s.pod.uid': owners[owner]!, 'service.instance.id': instances[owner]! }) })
  const traces: any = { resourceSpans: owners.map((_, owner) => ({ resource: resource(owner),
    scopeSpans: [{ scope: { name: 'jevable.http' }, spans: responses.filter(r => r.owner === owner).map(r => r.span) }] })) }
  const logs: any = { resourceLogs: owners.map((_, owner) => ({ resource: resource(owner),
    scopeLogs: [{ scope: { name: 'jevable.workflow' }, logRecords: responses.filter(r => r.owner === owner).map(r => r.log) }] })) }
  const snapshot = (length: number) => ({ resourceMetrics: owners.flatMap((_, owner) => {
    const known = responses.slice(0, length).filter(r => r.owner === owner)
    if (!known.length) return []
    const groups = new Map<string, typeof known>()
    for (const response of known) { const key = JSON.stringify(response.labels); groups.set(key, [...(groups.get(key) ?? []), response]) }
    const timeUnixNano = ns(responses[length - 1]!.endedMs + 1), startTimeUnixNano = ns(999999)
    const points = [...groups.values()].map(group => ({ attributes: attr(group[0]!.labels), timeUnixNano, startTimeUnixNano }))
    const distributions = [...groups.values()].map((group, index) => {
      const bucketCounts = Array<number>(12).fill(0)
      for (const item of group) { const bucket = bounds.findIndex(bound => item.seconds <= bound); bucketCounts[bucket < 0 ? 11 : bucket]!++ }
      return { ...points[index], count: String(group.length), sum: group.reduce((sum, item) => sum + item.seconds, 0),
        min: Math.min(...group.map(item => item.seconds)), max: Math.max(...group.map(item => item.seconds)),
        bucketCounts: bucketCounts.map(String), explicitBounds: [...bounds] }
    })
    return [{ resource: resource(owner), scopeMetrics: [{ scope: { name: 'jevable.workflow' }, metrics: [
      { name: 'jevable.http.requests', unit: '{request}', sum: { aggregationTemporality: 2, isMonotonic: true,
        dataPoints: points.map((point, index) => ({ ...point, asInt: String([...groups.values()][index]!.length) })) } },
      { name: 'jevable.http.duration', unit: 's', histogram: { aggregationTemporality: 2, dataPoints: distributions } },
    ] }] }]
  }) })
  const metrics: any[] = population === 1 ? [snapshot(1)] : [snapshot(Math.ceil(population / 2)), snapshot(population)]
  const signals = () => ({ traces: JSON.stringify(traces), metrics: metrics.map(packet => JSON.stringify(packet)).join('\n'), logs: JSON.stringify(logs) })
  return { ledger, traces, logs, metrics, signals }
}
function refused(f: ReturnType<typeof fixture>, code?: string) {
  try { verifyHttpObservations(f.ledger, f.signals()); throw Error('unexpected-match') }
  catch (error) { expect(error).toBeInstanceOf(HttpObservationVerificationError); if (code) expect((error as HttpObservationVerificationError).code).toBe(code) }
}
const span = (f: ReturnType<typeof fixture>) => f.traces.resourceSpans[0].scopeSpans[0].spans[0]
const log = (f: ReturnType<typeof fixture>) => f.logs.resourceLogs[0].scopeLogs[0].logRecords[0]
const families = (f: ReturnType<typeof fixture>, packet = f.metrics.length - 1) => f.metrics[packet].resourceMetrics[0].scopeMetrics[0].metrics
const point = (f: ReturnType<typeof fixture>) => families(f)[0].sum.dataPoints[0]
const histogram = (f: ReturnType<typeof fixture>) => families(f)[1].histogram.dataPoints[0]
const setAttribute = (record: any, key: string, value: string | number) => {
  record.attributes = record.attributes.filter((a: any) => a.key !== key).concat(attr({ [key]: value }))
}

function rateLink(f: ReturnType<typeof fixture>, sampled = true) {
  const traceId = 'a'.repeat(32), spanId = 'b'.repeat(16)
  for (const record of [span(f), log(f)]) record.attributes.push(
    { key: 'jevable.http.rate.trace_id', value: { stringValue: traceId } },
    { key: 'jevable.http.rate.span_id', value: { stringValue: spanId } },
    { key: 'jevable.http.rate.sampled', value: { boolValue: sampled } })
  span(f).links = [{ traceId, spanId, flags: sampled ? 257 : 256 }]
  return f
}

it.each([true, false])('matches the owned rate link with sampled=%s without claiming received quota or commit proof', sampled => {
  const f = rateLink(fixture(), sampled), before = JSON.stringify(f)
  expect(verifyHttpObservations(f.ledger, f.signals())).toMatchObject({ responseJoins: 7, cumulativeRequestTotal: 7,
    rateAdmissionLinks: { contexts: 1, sampled: sampled ? 1 : 0, unsampled: sampled ? 0 : 1,
      scope: 'HTTP-side owned context correlation only; not received quota observations, admission receipts or SQL/COMMIT proof.' } })
  expect(JSON.stringify(f)).toBe(before)
})
it('keeps the unlinked HTTP report shape unchanged', () => {
  const f = fixture()
  expect(verifyHttpObservations(f.ledger, f.signals())).not.toHaveProperty('rateAdmissionLinks')
})
it.each([
  ['missing rate field', (f: ReturnType<typeof fixture>) => { span(f).attributes.pop() }],
  ['zero quota trace', (f: ReturnType<typeof fixture>) => setAttribute(span(f), 'jevable.http.rate.trace_id', '0'.repeat(32))],
  ['zero quota span', (f: ReturnType<typeof fixture>) => setAttribute(span(f), 'jevable.http.rate.span_id', '0'.repeat(16))],
  ['nonboolean sampling', (f: ReturnType<typeof fixture>) => setAttribute(span(f), 'jevable.http.rate.sampled', 'true')],
  ['missing owned link', (f: ReturnType<typeof fixture>) => { span(f).links = [] }],
  ['duplicate owned link', (f: ReturnType<typeof fixture>) => { span(f).links.push(structuredClone(span(f).links[0])) }],
  ['different linked trace', (f: ReturnType<typeof fixture>) => { span(f).links[0].traceId = 'c'.repeat(32) }],
  ['different linked span', (f: ReturnType<typeof fixture>) => { span(f).links[0].spanId = 'c'.repeat(16) }],
  ['different linked sampling', (f: ReturnType<typeof fixture>) => { span(f).links[0].flags = 256 }],
  ['invalid link flags', (f: ReturnType<typeof fixture>) => { span(f).links[0].flags = -1 }],
  ['overflowed link flags', (f: ReturnType<typeof fixture>) => { span(f).links[0].flags = 0x100000001 }],
  ['fractional link flags', (f: ReturnType<typeof fixture>) => { span(f).links[0].flags = 1.5 }],
  ['linked private attributes', (f: ReturnType<typeof fixture>) => { span(f).links[0].attributes = attr({ payload: 'PRIVATE' }) }],
  ['dropped link attributes', (f: ReturnType<typeof fixture>) => { span(f).links[0].droppedAttributesCount = 1 }],
  ['linked tracestate', (f: ReturnType<typeof fixture>) => { span(f).links[0].traceState = 'PRIVATE' }],
  ['missing log correlation', (f: ReturnType<typeof fixture>) => { log(f).attributes.pop() }],
  ['changed log correlation', (f: ReturnType<typeof fixture>) => setAttribute(log(f), 'jevable.http.rate.trace_id', 'c'.repeat(32))],
  ['orphan link', (f: ReturnType<typeof fixture>) => {
    for (const r of [span(f), log(f)]) r.attributes = r.attributes.filter((a: any) => !a.key.startsWith('jevable.http.rate.'))
  }],
  ['self-link', (f: ReturnType<typeof fixture>) => {
    for (const r of [span(f), log(f)]) { setAttribute(r, 'jevable.http.rate.trace_id', span(f).traceId); setAttribute(r, 'jevable.http.rate.span_id', span(f).spanId) }
    span(f).links[0].traceId = span(f).traceId; span(f).links[0].spanId = span(f).spanId
  }],
] as const)('refuses %s without widening HTTP fields or weakening populations', (_name, change) => {
  const f = rateLink(fixture()); change(f); refused(f)
})

it.each([1, 22, 47, 128])('derives the exact population from independently supplied %s responses', population => {
  const f = fixture(population, population === 1 ? 1 : 3), before = JSON.stringify(f)
  expect(verifyHttpObservations(f.ledger, f.signals())).toMatchObject({ status: 'matched-recorded-http-observations',
    responseJoins: population, requestSpans: population, requestLogs: population, cumulativeRequestTotal: population,
    owners: f.ledger.owners.map((ownerId, index) => ({ ownerId, responses: index === 0 ? population - f.ledger.owners.length + 1 : 1 })) })
  expect(JSON.stringify(f)).toBe(before)
})
it('matches omitted unknown-route labels and local instance ownership without inferring raw paths', () => {
  const f = fixture(7, 1, true), instance = f.traces.resourceSpans[0].resource.attributes[1].value.stringValue
  f.ledger.ownerAttribute = 'service.instance.id'; f.ledger.owners = [instance]
  f.ledger.intents.forEach(intent => { intent.ownerId = instance })
  expect(verifyHttpObservations(f.ledger, f.signals()).responseJoins).toBe(7)
})
it('refuses lost settlements even when the received signals agree with each other', () => {
  const f = fixture(50, 3); f.ledger.settlements.splice(-2); refused(f, 'incomplete-evidence')
})
it.each([
  ['missing span', (f: ReturnType<typeof fixture>) => f.traces.resourceSpans[0].scopeSpans[0].spans.pop()],
  ['missing log', (f: ReturnType<typeof fixture>) => f.logs.resourceLogs[0].scopeLogs[0].logRecords.pop()],
  ['unrecorded span', (f: ReturnType<typeof fixture>) => { span(f).spanId = 'f'.repeat(16) }],
  ['unrecorded log', (f: ReturnType<typeof fixture>) => { log(f).spanId = 'f'.repeat(16) }],
  ['missing metric family', (f: ReturnType<typeof fixture>) => families(f).pop()],
  ['missing metric series', (f: ReturnType<typeof fixture>) => { families(f)[0].sum.dataPoints.pop(); families(f)[1].histogram.dataPoints.pop() }],
] as const)('refuses %s rather than deriving a smaller workload from telemetry', (_name, mutate) => {
  const f = fixture(); mutate(f); refused(f)
})
it.each([
  ['duplicate intent', (f: ReturnType<typeof fixture>) => { f.ledger.intents[1]!.id = f.ledger.intents[0]!.id }],
  ['duplicate settlement', (f: ReturnType<typeof fixture>) => { f.ledger.settlements[1]!.id = f.ledger.settlements[0]!.id }],
  ['duplicate context', (f: ReturnType<typeof fixture>) => { f.ledger.settlements[1]!.context = f.ledger.settlements[0]!.context }],
  ['unknown owner', (f: ReturnType<typeof fixture>) => { f.ledger.intents[0]!.ownerId = randomUUID() }],
  ['unused owner', (f: ReturnType<typeof fixture>) => f.ledger.owners.push(randomUUID())],
  ['unsampled response', (f: ReturnType<typeof fixture>) => { f.ledger.settlements[0]!.context = f.ledger.settlements[0]!.context.slice(0, -2) + '00' }],
  ['unfinished body', (f: ReturnType<typeof fixture>) => { (f.ledger.settlements[0] as any).bodyEnded = false }],
  ['reversed caller clock', (f: ReturnType<typeof fixture>) => { f.ledger.settlements[0]!.endedMs = 0 }],
  ['duplicate span', (f: ReturnType<typeof fixture>) => f.traces.resourceSpans[0].scopeSpans[0].spans.push(structuredClone(span(f)))],
  ['duplicate log', (f: ReturnType<typeof fixture>) => f.logs.resourceLogs[0].scopeLogs[0].logRecords.push(structuredClone(log(f)))],
  ['wrong span owner', (f: ReturnType<typeof fixture>) => setAttribute(f.traces.resourceSpans[0].resource, 'k8s.pod.uid', randomUUID())],
  ['changed resource instance', (f: ReturnType<typeof fixture>) => setAttribute(f.logs.resourceLogs[0].resource, 'service.instance.id', randomUUID())],
  ['missing instance identity', (f: ReturnType<typeof fixture>) => { f.logs.resourceLogs[0].resource.attributes.pop() }],
  ['wrong span scope', (f: ReturnType<typeof fixture>) => { f.traces.resourceSpans[0].scopeSpans[0].scope.name = 'other' }],
  ['wrong log scope', (f: ReturnType<typeof fixture>) => { f.logs.resourceLogs[0].scopeLogs[0].scope.name = 'other' }],
  ['wrong metric scope', (f: ReturnType<typeof fixture>) => { f.metrics.at(-1).resourceMetrics[0].scopeMetrics[0].scope.name = 'other' }],
  ['wrong span kind', (f: ReturnType<typeof fixture>) => { span(f).kind = 1 }],
  ['wrong status', (f: ReturnType<typeof fixture>) => setAttribute(log(f), 'http.response.status_code', 200)],
  ['wrong span outcome', (f: ReturnType<typeof fixture>) => setAttribute(span(f), 'jevable.http.outcome', 'client-disconnected')],
  ['wrong error status', (f: ReturnType<typeof fixture>) => { span(f).status.code = 0 }],
  ['wrong log severity', (f: ReturnType<typeof fixture>) => { log(f).severityNumber = 9 }],
  ['wrong log body', (f: ReturnType<typeof fixture>) => { log(f).body.stringValue = 'PRIVATE_BODY' }],
  ['extra private label', (f: ReturnType<typeof fixture>) => setAttribute(span(f), 'http.url', 'PRIVATE_URL')],
  ['dropped span attribute', (f: ReturnType<typeof fixture>) => { span(f).droppedAttributesCount = 1 }],
  ['duplicated attribute', (f: ReturnType<typeof fixture>) => span(f).attributes.push(structuredClone(span(f).attributes[0]))],
  ['span before intent', (f: ReturnType<typeof fixture>) => { span(f).startTimeUnixNano = '0' }],
  ['overflowing OTLP clock', (f: ReturnType<typeof fixture>) => { span(f).startTimeUnixNano = '18446744073709551616' }],
  ['span after response', (f: ReturnType<typeof fixture>) => { span(f).endTimeUnixNano = ns(f.ledger.settlements[0]!.endedMs + 1) }],
  ['log before span end', (f: ReturnType<typeof fixture>) => { log(f).timeUnixNano = '0' }],
  ['impossible duration', (f: ReturnType<typeof fixture>) => setAttribute(log(f), 'jevable.duration.seconds', 100)],
  ['counter total', (f: ReturnType<typeof fixture>) => { point(f).asInt = '1' }],
  ['histogram population', (f: ReturnType<typeof fixture>) => { histogram(f).count = '1' }],
  ['histogram bucket redistribution', (f: ReturnType<typeof fixture>) => { const h = histogram(f); h.bucketCounts[0] = '0'; h.bucketCounts[1] = '1' }],
  ['histogram sum', (f: ReturnType<typeof fixture>) => { histogram(f).sum += .01 }],
  ['histogram minimum', (f: ReturnType<typeof fixture>) => { histogram(f).min = 0 }],
  ['histogram maximum', (f: ReturnType<typeof fixture>) => { histogram(f).max += 1 }],
  ['histogram bounds', (f: ReturnType<typeof fixture>) => { histogram(f).explicitBounds[0] = .0001 }],
  ['counter type ambiguity', (f: ReturnType<typeof fixture>) => { point(f).asDouble = Number(point(f).asInt) }],
  ['unsafe count', (f: ReturnType<typeof fixture>) => { point(f).asInt = '9007199254740992' }],
  ['noncanonical count', (f: ReturnType<typeof fixture>) => { point(f).asInt = '03' }],
  ['delta counter', (f: ReturnType<typeof fixture>) => { families(f)[0].sum.aggregationTemporality = 1 }],
  ['nonmonotonic counter', (f: ReturnType<typeof fixture>) => { families(f)[0].sum.isMonotonic = false }],
  ['delta histogram', (f: ReturnType<typeof fixture>) => { families(f)[1].histogram.aggregationTemporality = 1 }],
  ['wrong metric unit', (f: ReturnType<typeof fixture>) => { families(f)[0].unit = '1' }],
  ['unpaired collection time', (f: ReturnType<typeof fixture>) => { histogram(f).timeUnixNano = '0' }],
  ['counter reset', (f: ReturnType<typeof fixture>) => { point(f).startTimeUnixNano = ns(1000000); histogram(f).startTimeUnixNano = ns(1000000) }],
  ['metric not recorded', (f: ReturnType<typeof fixture>) => { point(f).flags = 1 }],
  ['histogram not recorded', (f: ReturnType<typeof fixture>) => { histogram(f).flags = 1 }],
  ['exemplar', (f: ReturnType<typeof fixture>) => { histogram(f).exemplars = [{}] }],
  ['duplicate series', (f: ReturnType<typeof fixture>) => { families(f)[0].sum.dataPoints.push(structuredClone(point(f))); families(f)[1].histogram.dataPoints.push(structuredClone(histogram(f))) }],
  ['reversed collection order', (f: ReturnType<typeof fixture>) => f.metrics.reverse()],
] as const)('refuses %s', (_name, mutate) => { const f = fixture(); mutate(f); refused(f) })
it('accepts repeated unchanged cumulative snapshots without adding their counts', () => {
  const f = fixture(); f.metrics.push(structuredClone(f.metrics.at(-1)))
  expect(verifyHttpObservations(f.ledger, f.signals()).cumulativeRequestTotal).toBe(7)
})
it.each([1, 22, 47, 128])('checks independent stable counter/histogram starts for %s recorded responses', population => {
  const f = fixture(population, population === 1 ? 1 : 3)
  for (const packet of f.metrics) for (const resource of packet.resourceMetrics) {
    const metrics = resource.scopeMetrics[0].metrics
    for (const h of metrics[1].histogram.dataPoints) h.startTimeUnixNano = ns(1000000)
  }
  const before = JSON.stringify(f)
  expect(verifyHttpObservations(f.ledger, f.signals()).responseJoins).toBe(population)
  expect(JSON.stringify(f)).toBe(before)
})
it.each(['counter', 'histogram'] as const)('refuses a reset confined to the %s instrument', instrument => {
  const f = fixture()
  if (instrument === 'counter') point(f).startTimeUnixNano = ns(1000000)
  else histogram(f).startTimeUnixNano = ns(1000000)
  refused(f, 'inconsistent-evidence')
})
it.each(['counter', 'histogram'] as const)('refuses %s accumulation starting after an included observation', instrument => {
  const f = fixture(1)
  const start = ns(f.ledger.settlements[0]!.endedMs)
  if (instrument === 'counter') point(f).startTimeUnixNano = start
  else histogram(f).startTimeUnixNano = start
  refused(f, 'inconsistent-evidence')
})
it.each(['counter', 'histogram'] as const)('refuses %s accumulation starting after collection', instrument => {
  const f = fixture(1)
  const start = (BigInt(point(f).timeUnixNano) + 1n).toString()
  if (instrument === 'counter') point(f).startTimeUnixNano = start
  else histogram(f).startTimeUnixNano = start
  refused(f, 'inconsistent-evidence')
})
it.each([undefined, null, '01', '-1', '18446744073709551616'])('validates the independent histogram start clock: %s', start => {
  const f = fixture(); histogram(f).startTimeUnixNano = start
  refused(f, 'invalid-input')
})
it.each([1, 10, 100])('verifies real OTel metric serialization with a %sms first-measurement clock tick', async difference => {
  const { MeterProvider, MetricReader, AggregationType } = await import('@opentelemetry/sdk-metrics')
  const { resourceFromAttributes } = await import('@opentelemetry/resources')
  const { JsonMetricsSerializer } = await import('@opentelemetry/otlp-transformer')
  class Reader extends MetricReader {
    protected async onShutdown() {}
    protected async onForceFlush() {}
  }
  const f = fixture(1), reader = new Reader()
  const resource = Object.fromEntries(f.traces.resourceSpans[0].resource.attributes.map((a: any) => [a.key, a.value.stringValue]))
  const provider = new MeterProvider({ resource: resourceFromAttributes(resource), readers: [reader],
    views: [{ instrumentName: 'jevable.http.duration', aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: [...bounds], recordMinMax: true },
    } }] })
  const meter = provider.getMeter('jevable.workflow')
  const counter = meter.createCounter('jevable.http.requests', { unit: '{request}' })
  const duration = meter.createHistogram('jevable.http.duration', { unit: 's' })
  const labels = Object.fromEntries(point(f).attributes.map((a: any) => [a.key, a.value.stringValue]))
  const now = vi.spyOn(Date, 'now')
  try {
    now.mockReturnValue(999800); counter.add(1, labels)
    now.mockReturnValue(999800 + difference); duration.record(.0005, labels)
  } finally { now.mockRestore() }
  try {
    const collected = await reader.collect(); expect(collected.errors).toEqual([])
    f.metrics = [JSON.parse(Buffer.from(JsonMetricsSerializer.serializeRequest(collected.resourceMetrics)!).toString())]
    const metrics = families(f)
    const counterPoint = metrics.find((m: any) => m.name === 'jevable.http.requests').sum.dataPoints[0]
    const histogramPoint = metrics.find((m: any) => m.name === 'jevable.http.duration').histogram.dataPoints[0]
    expect(BigInt(histogramPoint.startTimeUnixNano) - BigInt(counterPoint.startTimeUnixNano)).toBe(BigInt(difference) * 1000000n)
    expect(verifyHttpObservations(f.ledger, f.signals())).toMatchObject({ responseJoins: 1, cumulativeRequestTotal: 1 })
  } finally { await provider.shutdown() }
})
it('refuses a service instance claimed by two different pod owners', () => {
  const f = fixture(7, 2), instance = f.traces.resourceSpans[0].resource.attributes[1].value.stringValue
  setAttribute(f.traces.resourceSpans[1].resource, 'service.instance.id', instance)
  refused(f)
})
it.each([null, {}, { traces: 1, logs: '', metrics: '' }, { traces: '', logs: '', metrics: '', secret: 'PRIVATE_TOKEN' }])('sanitizes invalid signal inputs', signals => {
  expect(() => verifyHttpObservations(fixture().ledger, signals as any)).toThrow('HTTP observation verification refused: invalid-input.')
})
it.each(['PRIVATE_TOKEN', '{"resourceSpans":null}', '{"resourceSpans":[{"resource":{}}]}'])('sanitizes invalid packet input', traces => {
  const f = fixture(); expect(() => verifyHttpObservations(f.ledger, { ...f.signals(), traces })).toThrow(HttpObservationVerificationError)
})
it('bounds payload bytes before parsing', () => {
  const f = fixture(); expect(() => verifyHttpObservations(f.ledger, { ...f.signals(), traces: ' '.repeat(16 * 1024 * 1024 + 1) }))
    .toThrow('HTTP observation verification refused: limit.')
})
it('retains unrelated non-HTTP records without treating them as HTTP evidence', () => {
  const f = fixture(); f.traces.resourceSpans.push({ scopeSpans: [{ spans: [{ name: 'jevable.run' }] }] })
  f.logs.resourceLogs.push({ scopeLogs: [{ logRecords: [{ eventName: 'jevable.run.ended' }] }] })
  f.metrics.push({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'jevable.run.duration' }] }] }] })
  expect(verifyHttpObservations(f.ledger, f.signals()).responseJoins).toBe(7)
})
