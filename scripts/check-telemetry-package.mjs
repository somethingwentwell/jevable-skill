// RECONSTRUCTION. The original script is not in the public repository, and no copy was found.
// It is rebuilt from how the telemetry tests use it and from the shapes declared in
// tests/provider-trace-fixture.d.ts, and may differ from the original. The original was probably
// also a package-level OTLP check runner; only the decoding helpers the tests import are rebuilt.
//
// Minimal OTLP protobuf decoding for test assertions (opentelemetry-proto v1 field numbers). It is
// an independent oracle: it does not use the runtime's own exporters or encoders.
//
// fields(bytes) -> Map<fieldNumber, value[]>, where varints are BigInt and length-delimited,
// fixed64 and fixed32 values are Buffers (fixed64 can be read with readBigUInt64LE/readDoubleLE).

function buffer(bytes) {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function varint(bytes, offset) {
  let value = 0n, shift = 0n
  for (let index = offset; index < bytes.length; index++) {
    const byte = bytes[index]
    value |= BigInt(byte & 0x7f) << shift
    if (!(byte & 0x80)) return [value, index + 1]
    shift += 7n
    if (shift > 63n) throw Error('Malformed protobuf varint')
  }
  throw Error('Truncated protobuf varint')
}

export function fields(bytes) {
  const data = buffer(bytes), result = new Map()
  let offset = 0
  while (offset < data.length) {
    const [tag, next] = varint(data, offset)
    const field = Number(tag >> 3n), wire = Number(tag & 7n)
    if (field === 0) throw Error('Invalid protobuf field number 0')
    let value
    offset = next
    if (wire === 0) [value, offset] = varint(data, offset)
    else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4
      if (offset + size > data.length) throw Error('Truncated protobuf fixed field')
      value = data.subarray(offset, offset + size); offset += size
    } else if (wire === 2) {
      const [length, start] = varint(data, offset)
      const end = start + Number(length)
      if (end > data.length) throw Error('Truncated protobuf length-delimited field')
      value = data.subarray(start, end); offset = end
    } else throw Error(`Unsupported protobuf wire type ${wire}`)
    if (!result.has(field)) result.set(field, [])
    result.get(field).push(value)
  }
  return result
}

const first = (message, field) => message.get(field)?.[0]
const text = value => (value === undefined ? '' : value.toString('utf8'))
export const hex = value => (value === undefined ? '' : value.toString('hex'))

/** Decodes an AnyValue message into a JavaScript value. */
export function anyValue(bytes) {
  const value = fields(bytes)
  if (value.has(1)) return text(first(value, 1))
  if (value.has(2)) return first(value, 2) !== 0n
  if (value.has(3)) return Number(BigInt.asIntN(64, first(value, 3)))
  if (value.has(4)) return first(value, 4).readDoubleLE()
  if (value.has(5)) return (fields(first(value, 5)).get(1) ?? []).map(anyValue)
  if (value.has(6)) return attributes(fields(first(value, 6)).get(1) ?? [])
  if (value.has(7)) return Buffer.from(first(value, 7))
  return undefined
}

/** Decodes repeated KeyValue messages into an object. */
export function attributes(keyValues = []) {
  const result = {}
  for (const keyValue of keyValues) {
    const entry = fields(keyValue)
    const value = first(entry, 2)
    result[text(first(entry, 1))] = value === undefined ? undefined : anyValue(value)
  }
  return result
}

/** Resource attributes of every Resource{Spans,Metrics,Logs} in an export request, values as strings. */
export function resourceAttributes(bytes) {
  return (fields(bytes).get(1) ?? []).map(resourceSignals => {
    const resource = first(fields(resourceSignals), 1)
    const decoded = resource === undefined ? {} : attributes(fields(resource).get(1))
    return Object.fromEntries(Object.entries(decoded).map(([key, value]) => [key, String(value)]))
  })
}

/** Iterates the messages at request.1 (resource) -> .2 (scope) -> .2 (span/metric/log record). */
export function* signalMessages(bytes) {
  for (const resource of fields(bytes).get(1) ?? [])
    for (const scope of fields(resource).get(2) ?? [])
      for (const message of fields(scope).get(2) ?? []) yield fields(message)
}

/** Sum metrics only (Metric.sum, field 7) with their number data points. */
export function metricSums(bytes) {
  const sums = []
  for (const metric of signalMessages(bytes)) {
    const sum = first(metric, 7)
    if (sum === undefined) continue
    const decoded = fields(sum)
    sums.push({
      name: text(first(metric, 1)),
      temporality: Number(first(decoded, 2) ?? 0n),
      points: (decoded.get(1) ?? []).map(pointBytes => {
        const point = fields(pointBytes)
        const value = point.has(4) ? first(point, 4).readDoubleLE() : point.has(6) ? Number(first(point, 6).readBigInt64LE()) : 0
        return { value, labels: attributes(point.get(7)) }
      }),
    })
  }
  return sums
}

/** Log records with event name (field 12), string body, severity number and correlation IDs. */
export function logRecords(bytes) {
  return [...signalMessages(bytes)].map(record => {
    const body = first(record, 5)
    return {
      event: text(first(record, 12)),
      body: body === undefined ? '' : String(anyValue(body) ?? ''),
      severity: Number(first(record, 2) ?? 0n),
      traceId: hex(first(record, 9)),
      spanId: hex(first(record, 10)),
      attributes: attributes(record.get(6)),
    }
  })
}
