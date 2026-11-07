# Bring a workflow, leave with a runnable app

This small support-triage example ships with the skill. The [n8n-shaped input](../examples/import-support/n8n.json) uses a free-text classifier, JavaScript string normalization and text comparison. The [reviewed Jevable workflow](../examples/import-support/reviewed.yaml) replaces that glue with a typed Decision and a deterministic review rule. It returns the routing judgment; it does **not** write or send a reply. The source is illustrative, not a verified export from a particular n8n installation.

| Before | Reviewed Jevable app |
| --- | --- |
| Ask for a free-text team name | Declare the allowed `billing` / `support` choices |
| Normalize strings and hope they match | Validate the choice, probabilities and reported confidence |
| Compare the resulting text | Read typed fields in a Rule |
| No review policy in this sample | Wait for a person when confidence is below 0.7 or native review probability is at least 0.65 |

[Explore the Archify comparison](../architecture/jev-comparison.html). Confidence is provider-reported, not a calibration guarantee. Native Noul returns `noul` with **no separate confidence**. Adding review and changing the output contract is a deliberate policy change, not equivalent vendor conversion.

## 1. Review the conversion — no model needed

From the installed skill directory, use a new working directory/output path:

```sh
node bin/jevable.mjs import preview examples/import-support/n8n.json --output converted.yaml --json
node bin/jevable.mjs import preview examples/import-support/n8n.json --output converted.html --output-format html --json
```

Read the conversion report, including the approximate model route and code mapping. A preview can show a structurally admitted draft that cannot run; generated HTML is inspection-only. Rendering performs no model call and opens nothing automatically. Keep its validation diagnostics visible. Read [vendor import](vendor-imports.md) before using your own upload; unsupported connectors cannot be filled by desktop/harness fallback.

Open the reported HTML beside your conversation where your desktop agent supports it. Review the approximate/unsupported mappings first, expand exact mappings as needed, then find the converted step IDs in the graph. This HTML carries the conversion report and exact converted draft, not the original upload or an executable workflow app.

An invalid-draft preview may exit 2 while still producing its inspection artifact and real diagnostics. That is not successful compilation or execution; resolve the reported gaps before running.

## 2. Review the typed version, then save the exact baseline

Copy `examples/import-support/reviewed.yaml` to a new `reviewed.yaml`. In that copy, choose the native model you are authorized to use and replace `your-explicit-model-id`. Keep the workflow metadata ID: it ties the authored draft to this conversion. Validate the edited file:

```sh
node bin/jevable.mjs validate reviewed.yaml --json
```

Retain a fresh project UUID and the upload/conversion/revision pins from step 1 **before** submitting the import. Save the original converted baseline, not a secretly substituted repair:

```sh
node bin/jevable.mjs import vendor examples/import-support/n8n.json --file converted.yaml \
  --title "Support triage" --id <retained-project-uuid> \
  --reviewed-source-sha256 <upload-hash> --reviewed-conversion-sha256 <conversion-hash> \
  --reviewed-revision <converted-revision> --data-dir .jevable --json
node bin/jevable.mjs projects propose <project-uuid> --file reviewed.yaml --expected-generation 1 --data-dir .jevable --json
node bin/jevable.mjs projects diff <project-uuid> --from <converted-revision> --to <reviewed-revision> --data-dir .jevable --json
```

Review the typed fields, removed code/text routing, new approval gate and changed output contract. Only after authorizing that exact proposal, accept its retained proposal ID/revision and the current generation returned by `propose`:

```sh
node bin/jevable.mjs projects accept <project-uuid> --proposal-id <proposal-uuid> \
  --revision <reviewed-revision> --expected-generation <current-generation> --data-dir .jevable --json
```

Do not accept automatically or refresh a stale generation to bypass review. These commands create no run. The original private upload/conversion remains tied to the original baseline through the later change; ordinary project export does not transfer that origin authority. See [project review](projects.md).

## 3. Configure the model, then explicitly preview or run

Follow [native model setup](systemone.md#configure-and-run): copy `examples/provider-systemone.json`, choose your explicit endpoint/provider/model, and use a protected credential file. The model/provider in your workflow must match that reviewed route. Neither a named model nor a passing configuration check proves credentials work or model quality. Setup/readiness itself spends no model calls:

```sh
node bin/jevable.mjs check reviewed.yaml --data-dir .jevable --json
```

For visual testing, request a [live preview](live-preview.md#desktop-agent-preview) in your desktop agent's browser panel. Its dedicated preview project is distinct from the saved authoring project. The agent starts the standalone Jevable preview, opens its credential-free URL where supported and waits for your protected connection. Opening never runs, accepts or approves anything; real-browser qualification is still pending.

Alternatively, after authorizing model usage, retain a fresh run UUID and run the accepted project with one sample:

```sh
node bin/jevable.mjs projects run <project-uuid> --expected-generation <accepted-generation> \
  --revision <reviewed-revision> --input examples/import-support/billing-input.json \
  --id <retained-run-uuid> --data-dir .jevable --json
```

Also try the [support input](../examples/import-support/support-input.json) and [ambiguous input](../examples/import-support/ambiguous-input.json) with separately authorized fresh run IDs. These are example tickets, not guaranteed answers or guaranteed approval triggers. Model behavior varies: inspect actual Choice probabilities/confidence, Noul, selected Rule port and retained output. Define/review [saved tests](testing.md) against your actual business policy before accepting or running them.

A waiting run exits 3. Inspect its exact review input and attempt ID; only with decision authority approve or reject that attempt. A passing waiting-state test is not completion. A malformed native reply may retain an unsettled attempt with failed provider evidence: inspect the original run and never invent another ID to bypass uncertainty. Reads, same-ID observation and approval continuation do not reclassify the ticket.

## 4. Deliver the app, not just the YAML or graph

Create an immutable release from the reviewed accepted project and export its exact hashes using [runnable releases](releases.md). Extract the trusted ZIP into a fresh directory. The app includes the Jevable workflow runtime and runs with Node 22.19+ without npm, this skill, an authoring agent, a Jevable desktop app or Docker. Configure its provider/credential independently before submitting a new request; authoring credentials are not in the ZIP. Retained state and evidence belong to this new app instance.

Docker image packaging is [optional](images.md); Kubernetes uses the [Jevable workflow runtime](kubernetes.md), never a skill runtime. Neither export authorizes publishing/deploying. Add [OpenTelemetry configuration](telemetry.md) when tracing is requested; received signals and real backend navigation require their own qualification.

Local fixture checks verify typed native requests, review waits/resume, malformed-answer refusal, no same-ID redispatch and retained trace/node/approval correlation. They do not prove this example's real hosted model, vendor compatibility or desktop browser behavior. The [import-preview GIF](../assets/import-preview.gif) animates one actual CLI conversion receipt for this illustrative sample; it is not a browser recording or proof of a repaired, tested, running app. The separate [import-to-app GIF](../assets/import-to-app.gif) follows the tested reviewed repair, saved case, release ZIP and fresh extracted-app execution using a synthetic local model; it is an animation of retained receipts, not a screen recording or hosted-provider result.
