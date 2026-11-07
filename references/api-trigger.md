# Explicit API workflow entry

Use this when a reviewed workflow declares `api` on its entry Trigger. It is a standalone runtime execution contract, not a new ingress service. SDK imports and local CLI jobs do not start an HTTP server or require Docker. Webhooks, schedules, public ingress and anonymous invocation remain unavailable.

## Select the contract

The only explicit selector currently supported is `api`. Omission preserves the existing local manual/chat entry contract, including historical run and test serialization. The runtime does not infer API mode from an HTTP transport, an API-only graph, or a packaged release. The selected entry must declare `api`; a manual/chat-only workflow refuses it before run creation or provider admission. Mixed-mode graphs need the same deliberate selection on retries.

```sh
node bin/jevable.mjs check examples/api-echo.yaml --trigger-mode api --data-dir .jevable
node bin/jevable.mjs run examples/api-echo.yaml --trigger-mode api --input examples/echo-input.json --id <retained-run-uuid> --data-dir .jevable
```

`projects run` also accepts `--trigger-mode api`, alongside its accepted revision/generation guards. `validate` remains structural and does not select an execution contract. `check` is read-only readiness without provider dispatch; ready does not authorize execution or prove external effects will succeed.

SDK calls accept `{id, paused, triggerMode: 'api'}` in the run options of `run`, `runProject` and `runRelease`. Call `check(yaml, 'api')` for selected readiness. SQLite and explicitly configured PostgreSQL share these rules, with independent owner/configuration requirements and no backend fallback.

For an explicitly selected authenticated management service, add `"triggerMode":"api"` to `check`, `runs.start` or `projects.run`. The exact-release service accepts it on `release.check` and `runs.start`, retaining the reviewed `releaseSha256` guard. Existing token, protocol, instance, input/resource and review guards still apply. API mode grants no approval authority, provider permissions, credentials or deployment authorization. It is not proof of incoming HTTP or an external caller's identity.

## Retain identity and review

The optional mode is immutable run metadata, included in creation evidence, checkpoint guards, receipts, lists, metadata-only exports and evidence ZIP inspection. Approval, paused controls, cancellation, scoped loop review, recovery and owner restart use the retained contract; never supply a new mode to a continuation. An identical start UUID only observes the retained run. Changing a mixed-entry run's mode conflicts; omitting the mode on an API-only workflow refuses the default contract. Neither outcome authorizes a new UUID or replay after uncertainty.

Saved test definitions may include `"triggerMode":"api"`. It contributes to the definition checksum and must be reviewed before acceptance. `tests generate ... --trigger-mode api` records that mode in its immutable request and all generated drafts without execution. Generation on an undeclared entry is refused even if no candidate could be generated. Case runs and serial/parallel suites consume the accepted definition's mode, not a caller override. Old omitted-mode tests are not silently migrated: edit/review/accept a new definition. Project transfer preserves the contract but creates locally reviewable drafts, never restores acceptance or execution.

## Deliver a runnable app

API-only workflows can be packaged as immutable releases. Inspection checks supported graph families without selecting or executing an entry. `configuration.json` reports explicit API selection and whether the default local entry exists; packaging does not provision ingress or credentials.

From a trusted extracted release:

```sh
node app.mjs check --trigger-mode api --data-dir /private/workflow-state
node app.mjs run --trigger-mode api --input /private/input.json --id <retained-run-uuid> --data-dir /private/workflow-state
```

A PostgreSQL app instead requires its independently protected `--database-file` on stateful commands. Node-only apps include their compatible Jevable workflow runtime; they need no authoring skill, source checkout, Jarness, harness, desktop or npm install. Container jobs pass the same explicit option to the workflow runtime; API does not cause a container/pod to listen automatically. Separately authorize/configure the [exact-release service](http.md#exact-release-serving) for HTTP integration.

Optional OTel execution-segment spans and correlated logs include `jevable.trigger.mode=api` only when explicitly retained. Old/default runs have no inferred label; node/model spans and metric labels are unchanged. Exported traces are not a durable commit or authenticated ingress receipt.

The experimental [HTML preview](live-preview.md#select-an-entry-contract) offers a deliberate entry selector. It defaults to manual/chat even for an API-only graph; choose API explicitly to refresh readiness before a new run. Saved cases use their reviewed definition's mode, not the selector. Candidate generation retains its mode with the batch UUID, including explicit retries after response loss. These protocol/serialized-controller implementations are not actual-browser qualification. Host checks remain distinct from current-byte container, Kubernetes, real-provider and production qualification; use the exact scope in the source roadmap.
