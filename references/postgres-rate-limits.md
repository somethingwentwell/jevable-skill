# PostgreSQL coordinated HTTP quotas

Use this explicitly selected PostgreSQL backend when the user wants independent HTTP owners to share a reviewed quota. It belongs to the standalone **Jevable workflow runtime**, not a desktop, harness or skill server. Direct workflow SDK/CLI jobs remain unthrottled. The generic [admission contract](rate-limits.md#explicit-coordinated-admission-for-trusted-sdk-hosts) still governs dispatch, authority and uncertainty.

## Select and own the backend explicitly

Import `PostgresHttpRateCoordinator` and its options/error types from `@jevable/core/http/postgres-rate-limits` in a build containing this module. PostgreSQL 17 is required; other major versions are refused. `PostgresHttpRateCoordinator.open(options)` requires exactly:

- `connection`: explicit `host`, `port`, `database`, `user`, `password`, `tls`. No connection string, environment-derived PostgreSQL settings or workflow namespace. `tls` is `{ mode: 'verify-full', ca?: <PEM text> }`; CA and reviewed host/IP identity are verified. `{ mode: 'loopback-test' }` is restricted to literal `127.0.0.1`/`::1`, for test fixtures only.
- `scope`: retained shared UUID, canonicalized to lowercase. All participants must use the same scope and policy.
- `policy`: the strict request/control token-bucket shape in the rate reference.
- `initialize`: explicit boolean. Use `true` only for an authorized operator bootstrap; serving hosts should attach with `false`.
- `timeoutMs`: integer 100–5000 for admission deadline and connection wait.
- `statementTimeoutMs`: integer 100–5000, no greater than `timeoutMs`.
- `maxPendingDebits`: integer 1–64, counting active plus queued debits in this owner.

The SDK receives configuration values, not a file path. The embedding host must load any password-bearing configuration through its protected local configuration mechanism; do not put it in arguments, URLs, workflow YAML, exported content or chat. Local CLI startup, PostgreSQL exported apps and [managed Docker startup](docker-owner.md#optional-shared-postgresql-http-quota) select this backend explicitly. Docker requires verified TLS and `initialize:false`; it stages protected configuration without opening the quota connection on the host. CLI preview and default SQLite exported apps do not accept it. It is never discovered from workflow storage.

The operator provisions the `jevable_http_rate.scopes` schema/table and retained scope using `initialize: true`, then closes that owner. Repeating initialization with the exact binding preserves balances; conflicting policy, unsupported format/version, missing scope or malformed balance is refused, never silently repaired or reset. Initialization is not a migration or quota-evading reset. Before live startup, retain the scope and review policy/connection ownership; an uncertain initialization commit requires inspection rather than a new UUID.

Open one coordinator per embedding host. Pass `coordinator.admission()` as `coordinatedRateLimits` to the explicitly selected HTTP service or preview gateway. Do not also supply `rateLimits`. Close/drain the HTTP service and await `service.closed`, then call `coordinator.close()` in the host's owned shutdown path. HTTP shutdown does not close the coordinator for you. Backend close seals queued admission, settles already-active SQL and ends its single session; it deletes no data and resets no quota. Session loss seals admission without automatic reconnect.

## Local CLI attachment

In a build containing this feature, `runtime serve` and foreground `runtime start --runtime local` accept `--rate-coordinator-file`. Supply the complete options above in a regular owner-only, non-symlink UTF-8 JSON file, no larger than 65,536 bytes. **`initialize` must be `false`**. Provision the retained scope separately with the reviewed operator SDK; the serving CLI cannot bootstrap a schema, mint a scope, repair state or reset quota.

```sh
node bin/jevable.mjs runtime serve --token-file /private/service-token \
  --data-dir /private/workflow-state \
  --rate-coordinator-file /private/shared-quota.json
```

For PostgreSQL workflow storage, select `--storage postgres --database-file /private/workflow-database.json` instead of `--data-dir`. Workflow database/namespace and quota connection/scope remain separate explicit configurations. Do not point competing workflow owners at one single-owner namespace just because quota sharing is enabled.

Do not combine `--rate-coordinator-file` with `--rate-limits-file`. Flag conflicts are rejected before token-file access. Private quota file/schema admission occurs before connecting or acquiring workflow ownership. Startup opens the quota session, then the selected workflow HTTP owner. SIGINT/SIGTERM, startup failure and output failure use the existing graceful service lifecycle; the CLI closes its coordinator only after that owned HTTP service has drained. No ambient PostgreSQL variables, discovery, fallback or reconnect is used. Startup/backend errors expose safe categories, never connection/password text. A lost reply is not permission to restart or replay an admission.

## PostgreSQL exported workflow apps

An independently exported PostgreSQL app built with this feature accepts the same protected attach-only file on `serve`:

```sh
node app.mjs serve --token-file /private/service-token \
  --database-file /private/workflow-database.json \
  --rate-coordinator-file /private/shared-quota.json
```

The app's fixed archive contains neither quota/database connection settings nor credentials. Its generated command reference advertises the option only for PostgreSQL `serve`; direct jobs and client commands do not accept it. Initialization stays operator-owned. The backend captures/validates the protected quota input before token/connection startup, then opens quota after the token is read and closes it after HTTP drain or startup/output failure. Existing exact-release pins/operations remain enforced, with no authoring, source replacement, quota refund or automatic replay.

The default SQLite workflow bundle still imports no PostgreSQL driver and refuses this flag. The explicitly selected optional SQLite profile below is a separate runtime checksum, not a workflow storage conversion. No new sidecar/server/desktop dependency is silently introduced. Older ZIPs/images do not gain this behavior; an explicit new reviewed runtime/release is necessary. Native extracted-app, image/container and Kubernetes qualification remain distinct.

## Kubernetes export attachment

The PostgreSQL workflow deployment exporter now accepts explicit `rateCoordinator: true` in builds containing this change. It adds only a protected `rate-coordinator.json` Secret projection and the app's attach-only flag; see [Kubernetes quota configuration](kubernetes.md#optional-shared-http-quota). Provision the scope and restricted role separately, use verified TLS and `initialize: false`, and review quota-specific egress and the shared readiness/control budget. Omission leaves the default export unchanged. No quota sidecar, automatic egress, bootstrap or cluster apply is introduced. This source/export capability does not qualify previously installed packages, images or live pods, and does not add SQLite workflow deployment support.

## Optional SQLite workflow app profile

To keep the workflow journal in SQLite while opting into PostgreSQL HTTP quotas, create a separately reviewed release with both explicit profile flags:

```sh
node bin/jevable.mjs releases create <project-id> \
  --revision <accepted-revision> --expected-generation <generation> --version 1.0.0 \
  --runtime-storage sqlite --runtime-rate-coordinator postgres --data-dir /private/authoring-state
```

The SDK equivalent is `loadReleaseRuntimeProfile({ storage: 'sqlite', rateCoordinator: 'postgres' })` from `@jevable/core/releases`, then `createRelease` with that artifact's exact identity and normal project guards. The management `releases.create` operation adds `runtimeRateCoordinator: 'postgres'` alongside `runtimeStorage: 'sqlite'`; the owner verifies its own installed optional bundle/hash before mutation. No client-supplied code paths are accepted. The default loader/creation path stays on the no-PostgreSQL-driver SQLite bundle. PostgreSQL workflow apps already support quota attachment and do not accept this SQLite-only profile selection.

Export resolves the saved runtime checksum, never a new current default. The fixed twelve-member ZIP embeds the optional quota driver in its one `runtime.mjs`, not a plugin requiring npm, desktop, sidecar or skill. `manifest.json`, `configuration.json`, `README.txt` and `app.mjs info` distinguish SQLite workflow storage from the optional PostgreSQL quota capability. The archive contains no connection settings or quota credentials. Direct jobs and serving without the quota flag open no quota connection and need no quota server.

```sh
node app.mjs serve --token-file /private/service-token \
  --data-dir /private/workflow-state \
  --rate-coordinator-file /private/shared-quota.json
```

Use separate SQLite state directories for independent owners. The app accepts no `--database-file`; quota sharing never moves workflow history to PostgreSQL or permits competing owners of one journal. The same protected attach-only configuration, reserve, fail-closed uncertainty and drain-before-close rules apply. Omit the flag for ordinary direct/local operation; do not assume that selecting the capability automatically opens or initializes a quota server. Images/deployments require fresh exact-artifact qualification; generated Docker/Compose files remain optional job inputs, not an applied service deployment.

## Shared state and atomic debit

There is one fixed-size row per explicitly provisioned scope, with immutable canonical policy/hash/format binding, request/control integer balances and the last database-time anchor. No per-IP/account/run/attempt history, credentials, workflow payloads, workflow journal lock or unbounded pool is created. The policy text is bounded, and each client serializes its bounded accepted work on one database session.

A transaction locks the scope using PostgreSQL [row-level locking](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS), then samples [the actual database clock](https://www.postgresql.org/docs/17/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT). Millisecond integer units avoid fractional-token rounding: one token costs `refillIntervalMs` units, and one elapsed millisecond adds `refillTokens`. Both lanes refill up to capacity; only the selected lane is debited. Backward clock movement does not move the saved anchor backward or create credit. This is shared database wall-clock accounting at millisecond precision, not a distributed monotonic clock or protection against a deliberately changed database clock.

Only an acknowledged COMMIT can produce admission or quota-denial receipt. Failure before COMMIT rolls back uncommitted changes. A lost COMMIT acknowledgement seals the connection with safe `commit-uncertain`; no refund, receipt reconstruction, retry or reconnect occurs. HTTP maps backend exceptions to the generic safe 503 admission failure and dispatches no workflow. A committed debit may remain charged after abort, transport loss or subsequent workflow refusal. `consume` is **not idempotent** and retains no attempt ledger: do not retry it, even with the same attempt UUID. Workflow mutation UUID recovery is separate.

Abort and the owner's monotonic admission deadline are checked before/after SQL boundaries, including after lock waits and before COMMIT. PostgreSQL statement/client waits are bounded. Abort cannot retract an in-flight or acknowledged COMMIT. The owner has no automatic scheduler, job execution or fallback bucket. `status()` is a memory-only session/pending-count and binding projection, not a database readiness probe, balance report, durable audit or telemetry backend.

## Permissions and qualification boundary

An operator can bootstrap with a separate role, then grant the trusted serving role schema USAGE, table SELECT and column-only UPDATE on `requests_units`, `controls_units`, `at_ms`. The native fixture verifies this profile over CA/IP TLS and SCRAM, with policy/binding updates, DELETE, TRUNCATE, DDL and runtime initialization refused. Do not apply fixture grants to an existing database automatically. The role still has trusted balance-write access, and a shared table is **not tenant isolation**; scope binding and checksums do not defend against a compromised database administrator/runtime.

Actual native checks cover two independent compiled HTTP workers, shared request/control exhaustion, refused run absence, replacement/policy conflict, refill/backward-anchor behavior, abort while row-locked, wire-dropped COMMIT acknowledgement before workflow dispatch, and the restricted TLS role. The first trial failed its final scope-count reporting assertion after those checks; retain that failure and its saved four-scope identity audit. A distinct fresh database/worker trial passes all six behavior groups and an exact join to its four scenario identities, without replaying the earlier trial. This is not a passing whole production matrix.

Remaining gates include broader coordinator outage/rollback/deadline/corruption/queue/native-process profiles, migrations/backup/HA/clock/operator security, wider PostgreSQL workflow hosts, current artifact installation/deployed qualification, app/container/Kubernetes qualification/wiring, received OpenTelemetry/backend operations, public ingress/platform/distribution and production quotas. Sharing admission does not authorize multiple owners of one single-owner workflow journal. Earlier runtime/image/browser/Kubernetes artifacts do not gain this module or its acceptance automatically.
