# Headless collab guest: notes

Working notes for the `omp join --once` branch (`feat/headless-collab-guest`, based on `v19.0.0`). Drop this file before opening the upstream PR.

## Run from source on a Bun-only machine

```
git clone git@github.com:zgroseclose/oh-my-pi.git && cd oh-my-pi
git checkout feat/headless-collab-guest
bun install                       # bun >= 1.4.4
bun packages/coding-agent/src/cli.ts join --once --link-file ~/.omp-link --print-requests
```

The installed `omp` stays stock and keeps hosting the TUI.

### Native addon check (result: the addon is required, a Rust build is not)

"Nothing on the join path pulls in a native crate" does **not** hold:

- `src/cli.ts:546` calls `installSqliteLockShim()` for every command except `--help`/`--version`, which loads `pi_natives`. Without an addon, `bun src/cli.ts join …` dies there before `join` runs.
- Even the transport alone loads it: `collab/crypto.ts` imports `asStrictBytes` from the `@oh-my-pi/pi-utils` barrel, and that barrel loads the addon (`dirs.ts`, `file-lock.ts`, `sqlite.ts`, …). `collab/protocol.ts` is the only collab module that imports cleanly without one.

The fix is to reuse a prebuilt addon of the **same version** (the loader rejects a `.node` from another release; this branch is `19.0.0`). A workspace checkout only looks in `packages/natives/native/` and in the directory of the `bun` binary. It does **not** look in `~/.omp/natives/` or read `PI_NATIVES_DIR`. So copy one in:

- Stock omp installed as the compiled binary: it extracts its addon to `~/.omp/natives/19.0.0/` on first run. `cp ~/.omp/natives/19.0.0/pi_natives.linux-x64*.node packages/natives/native/`
- Stock omp installed through npm/bun: the leaf package is in the global `node_modules`, at `@oh-my-pi/pi-natives-linux-x64/pi_natives.linux-x64*.node`.
- Neither: download `@oh-my-pi/pi-natives-linux-x64@19.0.0` from the npm registry and copy the `.node` out of `package/`.

`packages/natives/native/*.node` is gitignored. After rebasing onto `main` the package version changes, so the addon must be replaced with a matching one.

Measured on macOS arm64 (Bun 1.4.5, addon from `@oh-my-pi/pi-natives-darwin-arm64@19.0.0`): `bun src/cli.ts join --once …` starts and exits in about 0.45 s.

## Time to first ask

The host sends `welcome`, then every `snapshot-chunk`, then the replayed asks, as one ordered batch. A lightweight guest cannot see an ask before the whole snapshot has crossed the relay.

| Where | Relay | Snapshot | `requestsMs` | Wall (incl. CLI startup) |
| --- | --- | --- | --- | --- |
| macOS laptop | `local-relay.ts` on localhost | 9.7 MB, 2,304 entries | 37 ms | 456 ms |
| Work VM | public relay | ~9 MB real session | **TODO: measure** | |

The localhost number shows the guest's own cost is negligible (decrypt + parse + discard). On the public relay the transfer dominates. At the ~350 KB/s the code comments cite for `my.omp.sh`, 9 MB is about 26 s. Run the VM checklist below and put the measured `timings.requestsMs` / `timings.snapshotBytes` here and in the PR.

## Manual checklist on the VM

1. `cd packages/collab-web && bun run relay` (port 7466). Run `omp config set collab.relayUrl ws://localhost:7466`.
2. In tmux pane A, run stock `omp`, then `/collab`. Confirm the printed link points at `localhost:7466`.
3. `umask 077; omp collab link <pid> --json > ~/.omp-link`
4. Trigger a bash approval in A. `omp collab list --json` shows `"inputRequired": true`.
5. `bun …/cli.ts join --once --link-file ~/.omp-link --print-requests`: the approval is listed. Run it again: still listed.
6. `bun …/cli.ts join --once --link-file ~/.omp-link --answer <reqId> --value Approve`: A proceeds, and the guest prints `status: "answered"`.
7. `bun …/cli.ts join --once --link-file ~/.omp-link --prompt "…"` mid-turn: it shows in A as a steer with the `omp-once` badge.
8. Repeat step 5 against the real ~9 MB session through the public relay and record `timings`.

## Draft upstream issue

> **Title:** Collab: let a guest join without the transcript snapshot (welcome + pending asks only)
>
> Follow-up to discussion #6460 ("Step 0": collab outside the TUI) and #9643 (RpcClient extension UI).
>
> I built a headless one-shot guest, `omp join --once`, that lets an automated client see and answer what a live TUI session is waiting on: list pending asks, answer one, prompt (steer), or abort. It is printed as one JSON object and needs no host changes. It works against a stock host by speaking the existing frames: it discards `snapshot-chunk` bodies instead of building a replica, and it uses a `ui-response` for the never-issued reqId 0 as a barrier, since the host acknowledges it with a targeted `ui-request-end` queued behind the welcome batch.
>
> Two things in the current protocol limit it:
>
> 1. **Every joiner pays for the full transcript before it can see an ask.** `#welcomeBatch` sends `welcome` → all `snapshot-chunk`s → replayed asks as one unit. Skipping the replica avoids the TUI guest's resume cost (about 90 s to first event on a 756 KB transcript in our measurement), but not the transfer. On a ~9 MB session through the public relay, time to the request list was **TODO ms** (`timings.requestsMs`), against 37 ms for the same size over a localhost relay. A persistent RPC guest built on `CollabGuestLink` pays the transfer *and* the replica resume.
> 2. **No follow-up frame.** A guest `prompt` while the host is streaming is always a steer (`promptCustomMessage(..., { streamingBehavior: "steer" })`), and a steer that arrives during a pending approval denies the tool call. RPC clients that expect `follow_up` semantics have no equivalent.
>
> **Proposal (host-side, backward compatible):** an optional `hello` flag, e.g. `{ t: "hello", …, snapshot: false }`. The host answers with `welcome` (with `entryCount: 0`) plus the replayed asks, and skips the snapshot chunks. Hosts that don't know the flag ignore it and send the snapshot as today, which the lightweight guest already handles. Optionally, a guest `prompt` could carry `streamingBehavior: "followUp"` for the second gap.
>
> Happy to send the host-side patch if this direction is acceptable.

## Phase 2 (`--mode rpc`) status

See the PR description.
