# Connect to an existing workflow runtime

Use an explicitly selected HTTPS management endpoint when the Jevable workflow runtime is already running independently. This needs no Docker executable, local database, Jarness, desktop or cluster tooling on the client. It is a connection mode, not `--runtime remote`: `--runtime local|docker` remains reserved for local execution and Docker ownership.

```sh
jevable projects list --endpoint https://workflow.example:8787 \
  --token-file /private/jevable/management-token --ca-file /private/jevable/service-ca.pem
jevable run workflow.yaml --input input.json --id <retained-run-uuid> \
  --endpoint https://workflow.example:8787 --token-file /private/jevable/management-token \
  --ca-file /private/jevable/service-ca.pem --instance-id <reviewed-runtime-uuid>
```

Replace the example authority with the user's selected runtime. Use an independently provisioned regular owner-only token file. The optional CA file is client trust, not a provider/exporter trust setting; omit it for a certificate trusted by the platform. HTTPS certificate/hostname verification is mandatory. Plaintext, credential-bearing URLs, paths, query strings and fragments are refused. No redirects, automatic retries, environment discovery or fallback are used.

The normal project, run/control/approval, saved-test/suite, readiness, provider/credential, import and release commands accept `--endpoint`, `--token-file`, optional `--ca-file`, `--timeout-ms` and `--instance-id`. Do not combine this selector with `--runtime`, Docker owner/container flags, local storage/database flags or per-job telemetry configuration. A failed remote connection never starts another process or opens local storage.

Existing `runtime request`, `runtime status`, `runs watch` and `doctor` retain their dedicated endpoint grammars. The older suite-only loopback HTTP route also remains available for local compatibility, but does not accept `--instance-id`; use HTTPS suite selection for the capability/health handshake and pre-dispatch instance guard described here.

Each invocation makes authenticated read-only capability/health requests, requires the installed protocol/core version and management API, checks the reported backend, and pins operations to that runtime instance. PostgreSQL also requires a reachable database and open owner session. Exact-release-only and preview-only endpoints are refused by this authoring selector; use their dedicated APIs instead.

By default, a new invocation deliberately selects the instance currently serving the explicit endpoint. Add the reviewed `--instance-id` when a workflow or operator procedure must refuse a replacement even across invocations. Obtain that identity from the runtime's trusted readiness/health receipt. An instance UUID is a consistency guard, not independent authentication. A retained client/gateway rejects replacement before dispatch; it never reconnects itself.

`run`, `projects run`, `import project` and `releases create` require caller-retained IDs before submission. Preserve request/control/review identities after timeout or response loss and inspect them before retrying. A timeout does not cancel server execution. Actor attribution and approval authority stay with the selected service. A management token grants owner-level access, including private inspection and approval; it is not a multi-user or run-only credential.

PostgreSQL list commands require explicit `--page`; follow cursors rather than treating one page as complete. Release creation defaults to the discovered backend unless `--runtime-storage sqlite|postgres` explicitly selects another exported-app backend. Source/input files are read on the client; project/evidence/release ZIP and image packaging remain client-side. Release creation still requires exact host/server runtime hashes. No server Docker socket, checkout mount, image push or Kubernetes apply is added.

## Scoped HTML testing gateway

```sh
jevable preview workflow.yaml --serve \
  --endpoint https://workflow.example:8787 \
  --token-file /private/jevable/management-token --ca-file /private/jevable/service-ca.pem \
  --preview-token-file /private/jevable/preview-token --project-id <retained-fresh-project-uuid>
```

Create the preview token independently with `runtime token`; it must differ from the management token. The client starts only a local loopback HTML gateway and explicitly creates one retained preview project on the selected runtime. No workflow runs on startup. An uncertain project-create response must be inspected using that same ID; never silently create a replacement. The page receives only its preview credential and scoped session token, never the remote management token or a general management proxy.

The shared [live-preview controls](live-preview.md) support explicit tests, approvals, debugging and evidence against that pinned project/revision. Gateway shutdown closes only the local gateway; it neither stops the remote runtime nor cancels its work. A restarted remote service invalidates the gateway's instance pin, so inspect retained state and explicitly start a new authorized session instead of automatically reconnecting or replaying.

To reopen a reviewed existing project, replace `--project-id` with `--project-pin-file <pin.json> --project-pin-sha256 <reviewed-file-hash>`. The strict pin contains its current `id`, `generation` and accepted `revision`; use the matching reviewed workflow source. Startup performs only a guarded project read, not creation or execution. After replacement, explicitly review the new owner instance and use the same unchanged project pin in a new gateway. Stale, archived, missing or uncertain targets never create/restore/retarget implicitly. See [existing-project attachment](live-preview.md#reopen-an-existing-project-without-creating-or-running).

## Qualification and deployment boundary

Source tests and the independent-package verifier use private local HTTPS fixtures. They exercise remote command selection and the gateway protocol; they do not qualify internet routing, a reverse proxy, SSO, multiple users, Kubernetes, or actual browser layout/accessibility/CSP. Check browser capability and permission in the current session; a blocked browser is never bypassed through another browser, tunnel or publication. No alternative browser route is authorized by this feature.

Provision deployment, DNS, certificates, ingress/network policies and database operations separately. This mode neither discovers cluster endpoints nor runs `kubectl`, creates port forwards, modifies contexts or applies manifests. The runtime must already be reachable with its configured public origin and authorized credentials. There is no implied permission to expose a private service or connect to another application's runtime.
