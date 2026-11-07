# Offline input schema discovery

Inspect this installed core's input contracts without reading a workflow/configuration file, opening storage, resolving credentials or contacting an owner:

```sh
jevable schemas list
jevable schemas show workflow
jevable schemas show node-decision
jevable schemas show test-definition
jevable schemas show provider-connection
jevable schemas show postgres-config
jevable schemas show usage-selection
jevable schemas show runtime-operation
jevable schemas show caller-control
jevable schemas show collector-gateway-options
jevable schemas show trace-viewer
```

Both commands emit JSON; `--json` is also accepted. In a skill installation use `node <skill-directory>/bin/jevable.mjs`; in an extracted management ZIP use `node bin/jevable.mjs`. No server, Docker, Jarness or desktop is required. The SDK exposes the same `listSchemas()` and `showSchema(id)` through `@jevable/core/contracts`.

The index lists stable IDs, summaries, routed guides and contract-specific limitations. A shown contract has `schemaVersion: 1`, `execution: not-dispatched`, `validation: structural-input-projection-only`, a Draft 2020-12 `schema` and its `sha256`. The checksum covers `JSON.stringify(schema)`, not semantic rules, core implementation, user input or an authorized operation. Retain the core version and limitations as well as the checksum. Unknown IDs and execution/configuration flags refuse with exit 2; discovery accepts no user file or endpoint.

The projection uses the actual consuming Zod schema's input shape, rather than a separately maintained validator or its normalized output. For example, approval expiry is entered as a duration string, not the parsed millisecond number. Defaults describe parsing if that contract is eventually submitted; discovery does not insert them into user configuration. Unsupported conversion fails rather than weakening a field to an empty schema. [Zod's JSON Schema documentation](https://zod.dev/json-schema) explains the input/output distinction.

## How to use the catalogue

| Task | Inspect | Then use the actual core operation |
| --- | --- | --- |
| Author a workflow | `workflow`, relevant `node-*` entries | `validate` compiles the YAML and its graph, bindings and value schemas; `check` separately assesses configured readiness |
| Design a typed Jev Decision | `node-decision` | Keep typed questions/state and explicit provider/model settings; review native versus LLM answer contracts in [systemone.md](systemone.md) |
| Save tests and bounded suites | `test-definition`, `test-identity`, `suite-selection`, `suite-manifest` | Review and accept exact tests and the saved suite hash, including explicit concurrency, before authorized execution |
| Configure a provider | `provider-connection` | Use protected credential input and guarded `providers set`; discovery does not contact the provider |
| Configure explicit PostgreSQL storage | `postgres-config` | Use driver-free `parsePostgresConfiguration` and protected file admission, then explicitly open the owner; no database provisioning or credential check occurs during discovery |
| Select retained usage | `usage-selection` | Submit exact run/revision pins with optional canonical half-open window and provider/model grouping; this is neither an evidence ZIP selection nor billing/account discovery |
| Configure observability/delivery | `telemetry-config`, `notification-config` | Explicit startup configuration and independent trust/credentials; neither discovery nor startup authorizes sends |
| Package an optional telemetry gateway | `collector-gateway-options` | Review exact options bytes and use offline `telemetry export-gateway`; private credential files, Collector startup and deployment qualification stay separate |
| Prepare retained trace links | `trace-viewer` | Choose a credential-free simple path or Grafana Tempo Explore destination with explicit range; no probing, telemetry export, browser opening or backend authority is implied |
| Submit management JSON | `runtime-operation` and the nested contract | Use the explicitly selected authenticated owner and retain request/review guards; not the exact-release API |
| Control a caller-owned run | `caller-control` | Use the creating grant's explicit control permission and an opaque checkpoint through direct SDK or opt-in management caller transport; this is only the nested request, not an owner/HTTP envelope or output/approval authority |
| Observe a caller-owned run | `caller-stream` | One bounded POST SSE request with creating-grant read permission and exact instance/release/run pins; metadata only, no output, reconnect cursor or execution |
| Transfer/package | `project-bundle`, `release-snapshot`, `image-build`, `kubernetes-options` | Inspect/review exact artifact identities; export/build is not execution, push or cluster deployment |

JSON Schema cannot capture all runtime refinements, normalization, byte limits, semantic compiler rules, uniqueness, cross-field conditions, recorded-state membership, reviewed-hash equality or authority. A structural match is not runtime admission. The `limits` field names important per-contract gaps; follow the routed guide and actual consuming validator. SDK project/test commands include `actor`; their HTTP nested command bodies reject it because the service fixes the actor. Several management-envelope fields intentionally remain broad and are validated by their consumers. A Custom-node source schema does not enable unsupported Custom execution.

The catalogue covers shared input contracts, not every file or API: protected-file admission, secret values, vendor exports, ZIP framing/evidence attachments and exact-release operations retain their separate validators and guides. Use `schemas list` for this installed build's exact inventory. The full operator/file-schema/deployment qualification gates remain open. Shown schemas and checksums contain no user input, credentials, retained state or private paths; copying a schema does not authorize copying the private configuration that would use it.

`postgres-config` shows a required password **field**, never a password value. Its input projection cannot establish host safety, PEM validity, file permissions, database reachability or ownership. `parsePostgresConfiguration` from `@jevable/core/storage/configuration` performs the same in-memory normalization and semantic checks used by journal startup, without loading the PostgreSQL driver, reading a file or connecting. Never log its returned configuration: that object contains the supplied password. `initialize` remains required and explicit; schema defaults do not provision anything.

`usage-selection` reuses the evidence selection's strict run pins, adding only optional `window` and `groupBy`. Core admission still enforces case-insensitive UUID uniqueness, canonical millisecond timestamps and `from < before`, plus the 32,000-byte selection limit. The half-open window selects recorded original intent times; grouping opts into retained requested provider/model identities. Neither structural validation nor known-zero totals prove billing completeness. See [usage.md](usage.md) for coverage and privacy limits.
