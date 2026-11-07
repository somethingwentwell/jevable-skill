# Optional website-account SDK and CLI

`@jevable/core/account` is an optional, explicitly configured website-account client and private POSIX session host. Local workflow execution does not require it. It does not start a server, attach to a desktop, configure workflow providers or grant workflow-owner/caller/reviewer authority. Six account commands are implemented and independently tested in the installed and dependency-free management CLIs against a synthetic local TLS issuer on Darwin arm64. This scope does not establish full distribution/platform/fault or real issuer/browser authorization. Older SDK-only packages do not contain these commands.

The protocol follows the existing Jevable website authorization routes: a human approves a PKCE authorization link, then the host exchanges the one-time code for a private key. Account status and explicit key revocation use that key. No issuer is discovered or selected by default. Real issuer/browser authorization remains unqualified; synthetic fixture tests are not live sign-in.

## Account CLI contract

Check the selected build's `help account --json`; older installed packages do not contain this integration. Scoped source and independent installed/extracted checks cover protected code input, verified TLS plus untrusted/wrong-CA refusals, retained uncertain intent, private status opt-in and actual normal repeated SIGTERM draining of one admitted exchange. These are synthetic fixtures, not live sign-in, an exhaustive fault matrix or production acceptance.

| Command | Effect | Output |
| --- | --- | --- |
| `account prepare` | Create a fresh private session offline | Authorization URL and exact review pins |
| `account inspect` | Read the same session offline | Retained metadata and pins |
| `account link` | Read its original link while prepared, offline | Authorization URL and pins |
| `account exchange` | One explicitly confirmed code exchange | Metadata after private grant persistence |
| `account status` | Observe the explicitly selected account service | Metadata; private details only with `--include-private` |
| `account revoke` | One explicitly confirmed remote key revocation | Metadata; local credentials retained |

Every command requires `--issuer` and `--session-dir`. Prepare additionally requires `--name`; the session must be a fresh path beneath an existing owned mode-0700 parent. There is no automatic browser opening or sign-in. Present the returned link only for separately requested human authorization.

Exchange requires the retained `--session-id` and `--authorization-sha256`, `--confirm-exchange`, and exactly one of `--code-file` or `--code-stdin`. The file must satisfy the protected secret-file reader; stdin is bounded private input, never a code argument. The CLI paste profile uses `urn:jevable:paste`; it does not start a callback server. Review pins before supplying private input. No raw code, verifier, key, token or workflow-owner flag is accepted.

Status and revoke additionally require the exact retained `--key-id` and `--grant-sha256`. Revoke requires `--confirm-revoke` equal to that key UUID. Status excludes email, plan, balance and console links by default; `--include-private` explicitly includes those validated private details, never the key. A successful read is not authority to spend or proof of revocation.

Network commands accept an explicit `--ca-file` for HTTPS and `--timeout-ms` from 1 to 60000 (default 10000). `--allow-loopback-http` is only for an explicitly selected literal-loopback test issuer with an explicit port; CA input with HTTP refuses. No issuer or credentials are discovered. Offline commands do not read CA files or contact the issuer.

Account exit codes are 0 for a successful operation/read, 1 for an operational refusal/failure, 2 for invalid input, 3 for a recorded attempt/non-active session and 5 for an uncertain mutation outcome. Normal SIGINT/SIGTERM after operation admission drains the original request and private persistence before exit 130/143; repeated signals do not force an abort or retry. Before admission, interruption need not complete preparation or private input. An output failure can follow remote success: inspect the same retained session, not another exchange. Exit 0 from prepare/link is not sign-in, and status 401 never automatically erases credentials.

## Embed the host

```js
import { AccountClient, AccountSession } from '@jevable/core/account';

const client = new AccountClient({ issuer: explicitlySelectedHttpsOrigin });
// Choose a fresh session path under an existing owned mode-0700 parent.
const session = await AccountSession.prepare(privateSessionDirectory, client, 'My automation');
const link = await session.authorizationLink();
// Only link.authorizationUrl and link.pin are suitable for the presentation adapter.
// Open the link only when the user requests authorization; collect the code privately.
```

`AccountSession.open(privateSessionDirectory, client)` reopens the same session without network access, workflow replay or new credentials. `session.inspect()` returns metadata-only status and immutable review pins; it never returns the verifier, authorization code, account key or email. Keep the exact `link.pin` for the explicitly authorized `session.exchange(link.pin, privateCode)` call. Paste mode (`urn:jevable:paste`) is the default. An explicitly selected loopback redirect can be passed as the fourth argument to `prepare`; exchange then additionally requires the returned callback state. The SDK does not start a callback listener.

After a successful exchange, inspection includes a grant pin. `session.status(grantPin)` explicitly observes the website account; the service may update last-used metadata. `session.revoke(grantPin)` explicitly revokes that retained key. Both verify session/authorization/grant identities. A 401 means observed unauthorized, not proof of revocation, and never erases local state. Balance is an observed numeric credit value, not an exact monetary amount or permission to spend.

## Persistence and uncertainty

Each exchange and revocation has an exclusive retained request UUID. The host syncs its complete private intent and directory entry before sending credentials. Separate processes cannot publish the same intent twice. Reopening, reading, refreshing or repeating a recorded mutation never redispatches it.

Successful keys are saved in private files before returning metadata. A lost reply, malformed success, failed persistence or abrupt exit can leave `exchange-uncertain` or `revoke-uncertain`. Stop and inspect the same session; do not mint another key automatically, change issuer, overwrite files or remove an intent to bypass this state. A recorded HTTP refusal describes only that reply, not proof that no remote key exists. The website console's key list can be reviewed and revoked by the human independently. Deliberate recovery/redispatch and local credential erasure are not implemented in this profile.

Successful revocation retains the private grant and records `revoked`/`recorded-success`; it does not physically erase credentials, cancel provider work, end a subscription or reverse external effects. The one-attempt profile refuses a second revocation from the same session even after a refused/lost reply.

The session parent/directory must be owned mode 0700. Records must be owned regular mode-0600 files with one link; final symlinks, hard links, unsafe permissions, oversized/invalid records and replaced directory identities refuse. Failed private staging files remain for inspection. This is plaintext private POSIX storage, not encryption, secure erasure, a keychain, protection from root or hostile same-user processes, Windows ACL qualification, or a general crash/power-loss certification.

## Transport and scope

Production-shaped issuers require HTTPS with ordinary certificate/hostname verification. An explicit PEM CA can be selected; invalid CA configuration never falls back. Plain HTTP requires an explicit `allowLoopbackHttp` flag and a literal loopback host with an explicit port, for local fixtures only. No redirects, cookies, ambient credentials, automatic retries, desktop discovery or default issuer are used. Response bodies and deadlines are bounded, and errors do not echo service bodies or keys. Status links must stay on the pinned issuer's known console/checkout paths.

The low-level `AccountClient` returns secret-bearing authorization/grant values for applications that own their own protected persistence. Prefer `AccountSession` when that lifecycle is not already implemented. Never print those low-level values, put keys/codes/verifiers in CLI arguments or URLs, embed them in a workflow/preview/export, or treat them as provider or workflow access grants. Account calls require separate user authority; permission to build or preview a workflow is not permission to sign in or revoke a key.
