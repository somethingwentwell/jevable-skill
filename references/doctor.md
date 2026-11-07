# Read-only setup diagnostics

Use `jevable doctor` to inspect standalone setup. It prints JSON with fixed check IDs, status codes and suggested next steps. It never runs workflows, calls models, starts services, opens databases, migrates state, removes locks or repairs permissions.

```sh
jevable doctor --json
jevable doctor --data-dir /private/workflow-state --json
jevable doctor --storage postgres --database-file /private/database.json --json
jevable doctor --telemetry-file /private/otel.json --json
```

Without extra flags it checks the running Node version, availability of Node's SQLite module and both shipped release-runtime bundles. Bundle checks verify bounded readable files, byte sizes, SHA-256 and required notices; they neither execute bundles nor authenticate their publisher. If damaged/missing CLI dependencies prevent doctor itself from loading, reinstall the trusted package or rebuild an authorized source checkout. Never substitute a harness runtime.

Diagnostic file reads require regular files, refuse final symlinks and use non-blocking opens to reject named pipes. Normal workflow-file handling is unchanged. This is not a sandbox for an untrusted filesystem or package.

`--data-dir` inspects only directory and `runtime.sqlite`/`runtime.lock` metadata. No default directory is silently inspected. Contents, write access, schema and journal integrity are not checked. Missing state produces a warning and is not created. A present lock is a warning, not proof its owner is stale; use the owning service or investigate separately. No ownership is reserved by this observation. POSIX mode checks do not qualify Windows ACL behavior.

`--storage postgres` requires a protected regular `--database-file` and forbids `--data-dir`. It shares startup's PostgreSQL schema/TLS admission but never connects—even with `initialize: true`. A pass does not verify credentials, server version, ownership, grants, schema or reachability. `--telemetry-file` validates the same bounded configuration used at startup without contacting a collector or resolving credentials. Reports omit secret values, paths, parser errors and raw remote responses.

## Explicit service checks

```sh
jevable doctor --endpoint https://workflow.example:8787 \
  --token-file /private/service-token --ca-file /private/service-ca.pem \
  --timeout-ms 3000 --json
```

This performs only authenticated `GET /v1/capabilities` and, if compatible, `GET /v1/health`. No operation is posted. Local HTTP requires the reported literal `127.0.0.1` URL; remote services require verified HTTPS. Omit the CA file when normal trust suffices. Token values stay in protected files, never arguments, URLs or chat. Do not mix service flags with local storage/telemetry flags. No desktop, Jarness or ambient service discovery occurs.

Doctor requires matching protocol and core version and detects instance replacement between reads. A version mismatch means the pairing is not qualified, not that every older version is incompatible. Timeout is 1–30000 ms per request (default 3000), with responses capped at 256 KB. No redirects, retries or disabled certificate verification. Matching release-only services are inspectable, but doctor does not verify their release hash or grant approval authority; use the independently verified app's release client for operations.

| Result | Exit | Meaning |
| --- | --- | --- |
| `passed` | 0 | Selected checks passed; workflow readiness and unchecked scope remain unknown |
| `attention` | 0 | Warnings need review, such as absent state, owner lock or draining service |
| `failed` | 1 | A diagnostic check failed; inspect its fixed code and guidance |
| Usage error | 2 | Invalid/conflicting flags; diagnostic probes did not run |

Read `checks` and `notChecked`, not just the exit code. Provider availability, credentials, journal integrity, Docker/Kubernetes and full platform qualification are outside scope. `check <workflow>` checks configured readiness through an explicit runtime owner; unlike doctor, opening that owner can initialize/migrate its selected storage. Neither command proves a hosted provider will accept a request.
