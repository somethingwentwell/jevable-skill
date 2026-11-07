# Authoring Jevable workflows

The maintained schema/compiler is shipped in `@jevable/core/workflow`; it is the authority for accepted syntax. Examples in `examples/` cover LLM, Decision and Human Approval nodes. Use `templates render` for complete starting workflows, then validate the actual candidate. Do not invent fields from a diagram.

## Steps and bindings

Entry `modes` are not automatic deployment: [API entry](api-trigger.md) requires explicit runtime selection; omission keeps manual/chat behavior. API-only graphs can be packaged, but compilation or packaging does not create a server, webhook or schedule.

A workflow uses `apiVersion: jevable.ai/v1alpha1`, `kind: Workflow`, metadata, and `spec` with `inputSchema`, `nodes`, and `edges`. The outer graph has one Trigger, at least one Output, no cycles and no unreachable nodes. Bounded Loop bodies represent iteration. A node output port has one continuation; rules and approvals require the declared branch ports.

Expressions use `${{ inputs.message }}` or `${{ nodes.judge.output.route.choice }}`. The compiler checks scope and output types, including branch dominance: an output from a step not guaranteed to run cannot be referenced later. Expressions are restricted data operations, not arbitrary JavaScript. Custom code can be admitted by the compiler without being permitted for execution.

## Decision (Jev) and rules

Decision steps ask typed questions about explicit state: choices, scores and yes/no judgments. Their validated answers include the fields defined by the selected question type. Use the provided Decision example for exact syntax. A following Rule handles deterministic routing, including confidence thresholds and a review branch when judgment is uncertain. Do not parse free-form prose as a substitute for typed answers.

An LLM node writes or transforms content; a Rule does not need a model. Choose the Decision provider deliberately. Templates explicitly use the LLM compatibility provider; they do not imply a native Jev provider is already configured. Model routes and credentials are separate from workflow compilation.

Native Noul supplies `noul` without a separate confidence field. Do not copy confidence routing from a Choice example onto a native Noul result or fabricate the missing value. The existing LLM compatibility schema remains unchanged; [native execution](systemone.md) requires the explicit `systemone-v1` output contract and a matching configured route. Use `examples/native-decision.yaml` for its syntax and review binding changes when migrating.

## Review and effects

An approval step must remain in the path before the protected effect. Returning a draft is not sending email or posting a message. Imported unsupported connectors remain gaps for review; never remove their warnings just to obtain a green check. Preserve the exact candidate revision when handing it off for tests or packaging.

The current CLI runs local workflows including rules, bounded loops, approvals in the outer graph or loop body, and configured OpenAI-compatible LLM steps. Decisions use the explicit LLM compatibility route or experimental versioned native System One execution. See [providers.md](providers.md) for setup, protected credential input and model-free readiness checking. Native real-provider and deployment qualification remain separate gates. Provide the actual run receipt when testing is supported and explain unsupported parts. Do not fabricate tests, traces, approvals or release receipts.

## Review each loop item

`examples/loop-approval.yaml` reviews each string in `examples/loop-approval-input.json`. Run it with the ordinary `run` command, then use `approvals show <run-id>` to inspect the frozen current item. A wait retains `scope: { loop, index }`, its own attempt UUID and its approval expiry. Submit only the current reviewed attempt using `approvals decide`; an earlier iteration's UUID cannot approve the next item, even when their values are identical. There is no automatic approval or replay on inspection/restart.

For Each and Repeat Until use the same durable task/continuation. Branching rejection or timeout follows the body's declared edges/exits; terminal rejection/expiry stops the run with the body's scope intact. `--pause-after` commits the decision and leaves the exact next checkpoint paused. A body exit may finish an iteration or the whole loop in that settlement, without dispatching a downstream node. Use the existing checkpoint/request guards for Step/Continue.

The loop's original absolute deadline includes human review, pauses and downtime. Inspecting an elapsed wait does not settle it. On an explicit decision request, an elapsed loop deadline takes priority: the runtime records `loop-timeout`, not an invented action or approval expiry, even with pause-after. Cancellation remains distinct and takes precedence. Set `timeoutSeconds` for the entire intended review window; a 30-minute approval expiry inside a one-minute loop does not extend the loop.

Inbox, evidence and optional requested/decided/expired/cancelled notifications retain loop scope. Scoped notification metadata adds `loopExpiresAt`; a new requested send is refused after either deadline, while a retained same-ID send still returns its original receipt without redispatch. Loop timeout is workflow failure, not an approval-expired notification. Retained approval metrics classify a wait using the earlier deadline without changing state. The experimental preview protocol resolves actions from the scoped body; actual browser and current-byte container/Kubernetes qualification remain separate.
