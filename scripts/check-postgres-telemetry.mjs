// RECONSTRUCTION. The original script is not in the public repository, and no copy was found.
// It is rebuilt from how the trace tests use it and from the shape declared in
// tests/provider-trace-fixture.d.ts, and may differ from the original. The original was probably
// also a PostgreSQL telemetry check runner; only the traceRecords helper the tests import is rebuilt.
//
// traceRecords(bytes) decodes an OTLP ExportTraceServiceRequest into
// { traceId, spanId, parent?, name, attributes, links, resource } records (IDs as lowercase hex).
// `links` and `resource` are not declared in provider-trace-fixture.d.ts; tests read them via Reflect.get.
import { attributes, fields, hex } from './check-telemetry-package.mjs'

export function traceRecords(bytes) {
  const records = []
  for (const resourceSpans of fields(bytes).get(1) ?? []) {
    const decodedResource = fields(resourceSpans)
    const resource = decodedResource.get(1)?.[0]
    const resourceAttributes = resource === undefined ? {} : attributes(fields(resource).get(1))
    for (const scope of decodedResource.get(2) ?? [])
      for (const spanBytes of fields(scope).get(2) ?? []) {
        const span = fields(spanBytes), parent = span.get(4)?.[0]
        records.push({
          traceId: hex(span.get(1)?.[0]),
          spanId: hex(span.get(2)?.[0]),
          ...(parent && parent.length ? { parent: hex(parent) } : {}),
          name: (span.get(5)?.[0] ?? Buffer.alloc(0)).toString('utf8'),
          attributes: attributes(span.get(9)),
          // Span.links (field 13): Link{trace_id=1, span_id=2}.
          links: (span.get(13) ?? []).map(link => {
            const decoded = fields(link)
            return { traceId: hex(decoded.get(1)?.[0]), spanId: hex(decoded.get(2)?.[0]) }
          }),
          resource: resourceAttributes,
        })
      }
  }
  return records
}
