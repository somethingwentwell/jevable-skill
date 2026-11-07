# Recover a crashed SQLite owner lock

Use this only when recovery of the exact private state directory is authorized. It releases a proven-exited storage owner's lock; it does **not** repair SQLite, settle an uncertain provider request, approve a gate, restart a service or resume a workflow. PostgreSQL ownership uses its own database protocol and is not supported by these commands.

First use this installed distribution's command-scoped help. Initial recovery uses `runtime lock inspect` / `runtime lock recover`; interrupted transactions use `runtime lock inspect-recovery` / `runtime lock complete-recovery`. Older distributions may not have them. Preserve the state directory and journals; never delete a lock merely because a PID appears missing.

```sh
jevable runtime lock inspect --state-dir /absolute/private-state --json
```

Inspection reads bounded protected lock bytes, not SQLite. It reports the exact `lockSha256`, owner UUID, PID, reason and whether recovery is eligible **at that observation**. It does not create missing directories, start an owner, signal a process or mutate state. The explicit `--state-dir` avoids selecting the CLI's default `.jevable` or accepting execution/telemetry/remote-owner options.

For an eligible lock, review and retain its owner/hash and a fresh request UUID. Then explicitly authorize the release:

```sh
jevable runtime lock recover --state-dir /absolute/private-state \
  --request-id <retained-request-uuid> --owner <reviewed-owner-uuid> \
  --lock-sha256 <reviewed-lock-bytes-sha256> --confirm-recover --json
```

Recovery rechecks the actual lock and kernel context and requires `kill(pid, 0)` to report `ESRCH`. Before excluding new owners, it saves and syncs the original request, version-2 intent (recoverer PID, transaction-owner UUID and kernel context), exact old-lock bytes and publication declaration in private `runtime-lock-preparations/<request-id>/<recoverer-owner-id>/` staging. It then atomically publishes a no-replace `runtime.recovery.lock` relative symlink to that complete proof. An existing barrier is never replaced. New SQLite owners check for **any** barrier before and after creating their exclusive lock, and again before database startup.

The proof directory and completion receipt are archived under `runtime-lock-recoveries/<request-id>/`; a held exclusive completion claim serializes removal of the exact published pointer. During archival the pointer may be dangling: it still blocks startup. Request anchors and unused prepared attempts are retained, not pruned. An identical finalized request returns its existing receipt without touching a replacement owner. Changed pins or an incomplete archive are refused, not overwritten. Finalized version-1 intents remain readable for receipt-only retries; incomplete version-1 intents cannot prove the recovery actor exited.

## Conservative support boundary

New owner records include a recovery context only on Linux with readable kernel boot/PID-namespace identity and a supported local ext, XFS, Btrfs or tmpfs filesystem. The recovery process must have the same boot UUID, PID namespace, filesystem type and original directory device/inode as the crashed owner. A present/reused PID or `EPERM` is not absence. Cross-boot, copied-directory, legacy PID-only, unavailable-context, overlay/NFS/FUSE, Windows and macOS locks remain nonrecoverable by this command. Ordinary exclusive startup and clean shutdown still work without recovery context; there is no Docker, shell helper, native addon or desktop dependency in this protocol.

This is cooperative single-process exclusion in an owned private POSIX directory, not distributed leases/fencing or protection from a malicious same-UID/root actor manipulating paths between checks and unlink. Checksums are consistency pins, not authenticated evidence. Kernel identity and filesystem observations are not production storage/durability qualification.

## Interruption or refusal

A failure before publication leaves no new barrier and does not release the original owner lock. Retain the prepared proof and original request. If inspection still proves the exact owner exited, explicitly authorized `recover` with the **same** request can make a fresh private attempt; a partial or mismatched request anchor is refused. This is lock recovery, not workflow retry.

Once the barrier is published, **any** later failure or interruption retains it and its available evidence. Startup stays blocked even if the old owner lock has already been released. Do not automatically clear the barrier, restart, invent another recovery UUID or replay workflow work. Only the owned, bounded, exact generated relative pointer is resolved; arbitrary symlinks, symlinked target directories, unsafe permissions and mismatched declarations are refused. Evidence files remain protected no-follow reads. Older private directory barriers are still recognized; this publication change does not repair their empty or partial contents.

For an existing interrupted transaction, inspect its retained proof without changing it:

```sh
jevable runtime lock inspect-recovery --state-dir /absolute/private-state --json
```

For an eligible version-2 transaction, retain and review the **original** request/owner/hash. Separately authorize completion of that exact transaction, never a replacement identity:

```sh
jevable runtime lock complete-recovery --state-dir /absolute/private-state \
  --request-id <original-request-uuid> --owner <original-reviewed-owner-uuid> \
  --lock-sha256 <original-reviewed-lock-bytes-sha256> --confirm-recover --json
```

Completion requires matching original directory/boot/PID namespace/filesystem context and proof that **both** the original storage owner and initial recoverer have exited. It validates the saved intent and original bytes, refusing a replacement lock, unexpected transaction files, incomplete existing archive or changed pins. It handles legacy intent-only (original lock still present), saved old-lock copy, released-before-receipt, saved-receipt and generated-pointer archived-before-barrier-release stages. An existing receipt and its bytes are preserved. A completion claim is created exclusively inside the proof directory (or its archive); new owners remain blocked until archival and, for generated pointers, exact pointer removal. No SQLite opening, decision, workflow execution or restart occurs. The finalized identical request only returns its receipt, even while a replacement storage owner is running.

Older intent without recovery-actor proof, partial/malformed evidence, unknown/live/reused PIDs or mismatched context remain refused. **A failure after the completion claim is created retains that claim and barrier. Recursive takeover of an interrupted completion, an empty/partial initial barrier and cross-boot completion are not implemented.** Do not clear or repair them automatically. These are explicit refusal boundaries, not acceptance of complete crash/power-loss handling.

After successful release, separately authorized owner startup can inspect retained runs. A saved `executing` state still means uncertain settlement; lock recovery gives no permission to redispatch. See [workflow controls](control.md), [normal shutdown](job-shutdown.md) and [development](development.md). Source tests use real private files and naturally exited child PIDs, with supported Linux kernel identity doubled on macOS. Linux/tmpfs qualification applies only to its recorded runtime bytes and scenarios; earlier initial-recovery or completion evidence does not qualify a changed publication protocol. Process/power-loss, installed/extracted/exported artifacts and platform/deployment qualification remain separate gates.

Implementation references: [Node 22.19 filesystem API](https://nodejs.org/download/release/v22.19.0/docs/api/fs.html), [Linux filesystem type constants](https://github.com/torvalds/linux/blob/master/include/uapi/linux/magic.h), and [Linux procfs namespace documentation](https://www.kernel.org/doc/html/v6.7/filesystems/proc.html).
