# Collab: Live Session Sharing

`/collab` shares your running session with other omp instances in real time. Guests render the **same session natively in their own TUI** — streaming assistant text, tool-call cards, footer state (cwd, model, context %, cost), ctrl+o expansion, `/dump` — no terminal mirroring. Guests can prompt and interrupt the agent; the host machine runs the agent and all tools.

## Quick start

Host:

```
/collab
```

prints

```
Collab session started!
 • Join from another terminal: omp join "mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30"
 • or any web browser: my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30
```

The browser line is click-to-join (an OSC 8 hyperlink to the full `https://` deep link): the relay serves the web guest client at `/`, and the room id + key ride in the URL fragment. From another omp (any directory, any machine), either form works:

Running `/collab` or `/collab view` starts or displays the active hosting session, rendering terminal/browser join links and a QR code for the browser URL. `/collab` requests control access: if the active room was started view-only, it replaces that room. `/collab view` reuses either access level and prints only the read-only link.

```
/join my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJU…
```

The guest's previous session is restored on `/leave` (or when the host stops).

### Commands

| Command                | Effect                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `/collab`              | Start full-control sharing; reuse a control room or replace a view-only room        |
| `/collab <relay>`      | Start sharing through a specific relay (`relay.example.com`, `ws://localhost:7475`) |
| `/collab view [relay]` | Start read-only sharing, or print the existing room's read-only link/QR             |
| `/collab status`       | Show link + participants                                                            |
| `/collab stop`         | Stop sharing                                                                        |
| `/collab list`         | List every active local Collab host (no links)                                      |
| `/join <link>`         | Join a shared session as a guest                                                    |
| `/leave`               | Leave (guest) or stop sharing (host)                                                |

`/collab start [relay]` is also accepted. Passing a relay while a reusable room is active does not move that room to another relay; stop it first to change the relay.

### Sharing every session automatically

Explicit `/collab stop` and `/leave` also cancel any replacement already queued by a session transition. A later, distinct session change still follows the saved auto-start policy. Guests can answer startup dialogs, but cannot prompt, interrupt, or control agents until the outer startup—including setup UI and transcript replay—has completed successfully.

Dedicated joins retain session-change observation: a failed join returns to the saved auto-start policy immediately, and `/leave` or host disconnection restores automatic hosting for the local session and its later replacements. Remote replica resynchronization never starts a local host.

An explicit `omp join <link>` launch takes precedence over auto-start: it initializes as a guest without publishing a temporary local host, and leaves the saved auto-start setting unchanged. If interactive startup fails after a host has been installed, that room is shut down and withdrawn before terminal teardown and the startup error is rethrown.

Set `collab.autoStart` to `view` or `control` and every interactive session hosts itself as it starts, through `collab.relayUrl`, without running `/collab`. The room is created before extension `session_start` hooks run — a question an extension asks at startup is retained and delivered to the first writer that joins — and the relay connection proceeds in the background, so a slow or unreachable relay never delays the prompt (a failure is shown as a dim status line). Guests can join an auto-started room and answer a startup question straight away, but — like the local composer, whose Enter is gated for the same reason — they cannot prompt, interrupt, or drive subagents until startup has finished; such a frame is refused with `… is unavailable until the host finishes starting up`. Each auto-started session publishes itself to the local host registry below; the setting's value is the highest access the registry will hand out for it (`view`: read-only links only; `control`: links that can prompt and interrupt). `/collab` still works as before: it re-prints the current room, or replaces a view-only room with a full-control one when you ask for control.

Rooms follow the session, not the process. `/new`, `/resume`, `/fork`, and branching stop the current room — guests are told goodbye and its registry entry is withdrawn — before starting a replacement under the live auto-start policy. A guest holding the old link never sees a different session. During an uncommitted `/resume`, the old room instead suspends while the target session is provisionally active; rollback restores access to the original room without needing a callback. Shutdown makes the room unavailable immediately and finishes its cleanup before disposing the session. After a failed session change, `/collab` and `/join` use current-session hosting state and retire any stale owned room before proceeding; joining still refuses to replace a live host.

Explicit stop also cancels pending automatic launches without changing the saved policy. Application frames still queued or being encrypted are discarded; only the final goodbye drains. Bytes already handed to the transport cannot be recalled. A later distinct session change or manual start can host again.

A room can also end on its own: the relay closes it for good, or the host's send backlog exceeds its limit (`Collab ended: …`). Its guests must rejoin to resync, but the session keeps following the live auto-start policy: once the ended room has withdrawn, a replacement room (next generation) is hosted for the same session. An auto-started room the relay never opens — the relay is unreachable, or the connection times out — is retried the same way; no guest or registry reader ever saw it, so the retry reuses its generation and a session that recovers still publishes generation 1 first. The first replacement is immediate; if rooms keep ending, or the relay stays unavailable, within five minutes of each other, each further replacement waits twice as long (1 s, 2 s, 4 s, … up to 60 s). `/collab`, a session switch, `/collab stop`, and shutdown are not held behind that wait. With auto-start `off`, a manually started room that ends this way stays down until `/collab` is run again.

Guest ownership begins before replica activation and lasts through restoration of the previous local session. Neither joining, resynchronizing, nor a failed join may publish the replica as a local host. Leaving waits for restoration; a restoration failure is reported and keeps hosting blocked. An explicit stop during restoration suppresses its pending automatic restart without cancelling the restoration itself.

### Listing active local hosts

Suspension suppresses session data, joins, and guest actions; it does not suppress termination of an existing room-local dialog. An ended dialog carries only its request ID, so guests can dismiss it even if `/resume` later rolls back. The first authenticated answer to an existing dialog is retained while the target session is provisional and applied only if the original room resumes with the writer still authorized. Commit, stop, and local cancellation cannot apply that answer to another session. Joins during that provisional window must be retried once it settles. `/collab status` prints the room's published access level, so a view-only room never exposes its internal control link through status.

Already-admitted work is not generally undone by closing a room. In particular, subagent revival is shared with local callers and remains bound to the original agent reference and transcript; it may finish after closure, but the old guest's follow-up prompt is discarded. Closing a room does not cancel a local caller's coalesced revival.

Replacement rooms wait for the session operation to finish its hooks, transcript replacement, and any rollback before connecting. During an in-place transcript reset or tree navigation, existing guests continue receiving replication, but prompts and agent-control commands are refused until the operation settles; new joins and registry discovery are unavailable during that interval. If a previously admitted prompt is discarded before execution, its guest receives an error in a retained room. A retiring room instead sends a goodbye explaining that prompts absent from the conversation must be resubmitted after rejoining. A provisional switch must settle before deciding which notification applies.

`omp collab list` (and `/collab list` inside a TUI) enumerates every live Collab host on the local machine under the same omp configuration root — across terminals, projects, and profiles. Listing is metadata only; it never prints or transmits a link:

```
omp collab list                          # one row per host, no links
omp collab list --json                   # {"version": 1, "hosts": [...]}
omp collab link <instanceId|pid>         # print that host's full-control browser URL
omp collab link <instanceId|pid> --view  # print its view-only browser URL
omp collab link <instanceId> --json      # {"version": 1, "instanceId", "generation", "access", "url"}
```

Each host row carries a stable `instanceId` (random per process, kept across the rooms that process hosts), the room `generation` (increments every time the process starts a new room, e.g. on `/resume`), PID, session ID and name, working directory, model, start time, participant count, whether the relay connection is currently open, whether a host-side question is waiting for a writable guest (`inputRequired`), whether the session is running a turn (`busy`, rendered `working` or `idle`), and the highest `access` the registry will hand out (`view` or `control`). Hosts are sorted by start time, then PID, then instance ID. An empty result ("No active Collab hosts.") is a successful outcome, not an error.

`busy` is true for the whole turn — response streaming and tool execution alike — and false once the agent ends, so polling it is how a dashboard notices that a still-published session stopped working; a host that vanishes from the listing has died or become unreachable, which is a different thing. It is `null` from a host running an omp older than the field, and unknown must not be read as idle. `busy` reports a turn in flight, not scheduled work: it reads false during scheduling pauses (queued follow-ups, async-job waits, compaction) even when the session resumes on its own, so a `true`→`false` edge means the turn ended, not that the work finished.

A link is a deliberate per-host act. `omp collab link` asks the selected host for one URL, bound to the generation observed while listing: if the host has since started a new room (a session switch), the request fails with `stale_generation` instead of handing out the successor room, and you list again. A host published with `view` access refuses `control`. A PID that matches more than one live host (or none) is rejected with the candidate instance IDs; use the instance ID. The printed URL grants whatever its access says — treat a control URL like the `/collab` link itself.

How it works: each room publishes its own private IPC endpoint (a Unix domain socket on macOS/Linux, a named pipe on Windows — never a TCP port) once its relay connection succeeds; a rotation publishes under fresh artifact names, so withdrawing the old room can never disturb its successor. Full-control and view-only URLs, the room key, and the write token stay in the host process's memory; disk holds only discovery metadata (protocol version, instance ID, PID, endpoint, creation time, and a random bearer token) under `~/.omp/run/collab-hosts`. On macOS/Linux, permissions are tightened to owner-only on every publication. Windows inherits the configuration root's ACL, so that root must remain private to the user. Two authenticated operations exist over the endpoint: `snapshot` (host state, with free-form strings bounded so an unusual session title cannot make a host unlistable) and `link` (`access` + `generation` → one URL). Listing queries every live host concurrently with short independent deadlines, skips unresponsive or foreign-version entries, and prunes metadata left behind by crashed hosts; a transient socket error (`EMFILE`, `EACCES`, …) never prunes a live host. Stopped rooms disappear immediately — the registry keeps no history, lists no guests or remote hosts, and requires no relay change. Third-party dashboards and bridges can build on `omp collab list --json` plus `omp collab link` — or speak the newline-delimited JSON endpoint directly — without omp shipping a remote product of its own.

A missing registry directory means no active hosts. An unreadable or symlinked registry directory is a listing error, not a successful empty result; POSIX also rejects foreign-owned directories. Individual unreachable or malformed host entries are still omitted independently. The CLI exits nonzero for a directory error; `/collab list` displays a sanitized, bounded error and leaves the TUI usable.

## Headless one-shot guest (`omp join --once`)

`omp join --once` is a guest for scripts and agents: it joins a live room, does one thing, prints one JSON object, and leaves. It builds no replica session (no session file, no `AgentSession`, no TUI): the transcript snapshot the host sends every joiner is received and discarded. It works against any host that speaks collab protocol v3, with no host-side setting.

```
omp join --once --link-file <path> --print-requests
omp join --once --link-file <path> --answer <reqId> --value <label|text>
omp join --once --link-file <path> --prompt <text> [--wait-idle <sec>]
omp join --once --link-file <path> --abort [--wait-idle <sec>]
```

Common flags: `--connect-timeout <sec>` (relay connection, default 15), `--timeout <sec>` (whole run, default 120; the run never outlives it), and `--name <name>` (the participant name the host shows, default `omp-once`).

Headless behavior is selected by `--once`, never by the absence of a terminal: `omp join <link> | tee` still fails with `requires an interactive terminal`. The `--once`-only flags are refused without `--once`.

### The link file

The link is never accepted in argv: `/proc/<pid>/cmdline` is world-readable and argv is kept in job records. `--once` with a positional link is a usage error. Pass `--link-file`, which must be a regular file owned by the caller with mode `0600` or stricter; any group or other bit is refused. It holds either the bare link or the JSON that `omp collab link --json` prints (its `url` is used):

```
umask 077; omp collab link <instanceId|pid> --json > ~/.omp-link
```

The link is never printed. Error messages name the file, never its content.

Use a **control** link. A host replays pending requests only to writers, and refuses writes from view-only peers, so a view-only link (`--view`) is refused up front for every action with exit code 4. The same exit code is returned when the host demotes a full-looking link because its write token is no longer current.

### Actions

- `--print-requests` lists the asks the host is waiting on (approvals, `ask` selects, editor prompts) and exits 0 without writing anything.
- `--answer <reqId> --value <v>` answers one ask and exits on the host's `ui-request-end` for that reqId. For a select, the value must be one of its option labels; an exact match wins, otherwise a unique case-insensitive match is normalized to the label. Any other value is refused locally (exit 9) and not sent, because a host reads an unknown approval label as a denial. For an editor, any text is sent. A JSON string literal (`--value '" padded "'`) passes leading or trailing whitespace through. An ask that is no longer pending (answered elsewhere, aborted, timed out) returns `status: "already-settled"` with exit 0. That is a success, not an error: first answer wins, and the usual cause is someone answering at the host's terminal first. Do not treat it as a failure to retry. An answer to an already-settled reqId is acknowledged and ignored by the host, so it cannot refuse a later ask, but there is nothing left to do.
- `--prompt <text>` sends a prompt. While the host is streaming, it lands as a **steer**: it is delivered at the next turn boundary, not queued as a follow-up. Collab has no follow-up frame. A steer that arrives while an approval is pending denies that tool call and is delivered first.
- `--abort` interrupts the host's current turn.

`--prompt` and `--abort` exit once the host has handled the frame, including any immediate refusal (for example, startup not finished). A prompt also waits 750 ms for the host's asynchronous refusal. `--wait-idle <sec>` is **best-effort, for humans**: it waits until a `state` frame reads idle (not streaming, nothing queued, not aborting). That frame is the host's debounced footer snapshot and reads idle during scheduling pauses (queued follow-ups, async-job waits, compaction), so the result is labeled `authoritative: false`. An automated driver should not end a job on it: an early idle reading is a lost turn. Watch for the next ask with `--print-requests`, or read the host transcript, instead.

### Leaving without answering is safe

A guest that lists asks and disconnects does not refuse them. When the last writer leaves, its asks stay pending and are replayed to the next writer that joins. So `--print-requests` followed later by a separate `--answer` works. Approvals also survive relay reconnects (`retainOnReconnect`). One edge case: if a `--once` guest is not offered an ask (the host's send queue refused it) while another writer that also lacks it stays connected, the ask settles as unavailable. It never settles merely because a `--once` guest left while another writer still holds it.

### Output (version 1)

On success, one JSON object on stdout:

```json
{
  "version": 1,
  "action": "print-requests",
  "status": "ok",
  "requests": [
    {
      "reqId": 3,
      "kind": "select",
      "title": "Allow bash: rm -rf build?",
      "approval": true,
      "options": [{ "label": "Approve" }, { "label": "Deny" }]
    }
  ],
  "host": { "sessionId": "…", "sessionName": "…", "cwd": "/work", "isStreaming": false, "queuedMessageCount": 0, "isAborting": false },
  "timings": { "connectMs": 40, "welcomeMs": 120, "snapshotMs": 2900, "requestsMs": 2910, "totalMs": 2910, "snapshotEntries": 2304, "snapshotBytes": 9747114 }
}
```

| `action`         | Extra fields                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `print-requests` | `status: "ok"`, `requests[]`: `reqId`, `kind` (`select`/`editor`), `title`, `approval`, `options[]` (`label`, `description?`), `helpText?`, `prefill?` |
| `answer`         | `reqId`, `status`: `answered` or `already-settled`, `value` (as sent)                                   |
| `prompt`         | `status: "submitted"`, `steer` (host was streaming when sent; non-authoritative), `idle?`               |
| `abort`          | `status: "submitted"`, `idle?`                                                                          |

`idle` (with `--wait-idle`) is `{ "authoritative": false, "idle": true|false, "waitedMs": n }`. `host` is the host's state as last seen. `timings` are milliseconds since the guest started connecting: `requestsMs` is time to the complete request list, which comes after the whole snapshot (see below).

`answered` means the answer was sent and the host then ended the ask. A different writer's answer that wins the race reads the same way.

On failure, nothing goes to stdout. One JSON object goes to stderr, `{"version":1,"error":{"code","exitCode","message"}}`, with a matching exit code:

| Exit | `code`          | Meaning                                                                                       |
| ---- | --------------- | --------------------------------------------------------------------------------------------- |
| 0    | —               | Success, including `already-settled`                                                          |
| 1    | `internal`      | Unexpected failure                                                                            |
| 2    | `usage`         | Bad or conflicting flags                                                                      |
| 3    | `link`          | Link file missing, unreadable, too permissive, not owned by you, or not a valid link          |
| 4    | `read-only`     | View-only link, or the host demoted the link to read-only                                     |
| 5    | `host-gone`     | Room closed, no such room, host stopped (`bye`), or the connection dropped mid-run             |
| 6    | `timeout`       | `--connect-timeout` or `--timeout` ran out                                                    |
| 7    | `protocol`      | Collab protocol version mismatch with the host                                                |
| 8    | `host-error`    | The host refused the join or the action (an `error` frame)                                     |
| 9    | `invalid-value` | `--value` is not one of the select's options                                                  |

A connection that drops after a write was sent fails with `host-gone`, and the message says the outcome is unknown. The guest never rejoins mid-run, so a prompt is never sent twice.

### Cost on large sessions

Every joiner receives the host's full transcript snapshot before the replayed asks; that order is fixed by the host. `--once` discards the snapshot instead of building a replica (the TUI guest's resume step takes tens of seconds on large sessions), but it cannot skip the transfer: time to the request list is roughly snapshot bytes divided by relay throughput (`timings.snapshotBytes`, `timings.requestsMs`). Over a loopback relay, a 9.7 MB snapshot lists in under 50 ms, so the ordering is a real cost only through a remote relay.

How it knows the request list is complete: right after `hello`, the guest sends a `ui-response` for reqId -1. Hosts issue reqIds counting up from 1, so a negative id can never name a real ask, and the barrier can never answer (and so deny) a pending approval. A stock host answers an unknown reqId with a targeted `ui-request-end`. That reply is queued behind the welcome batch (welcome, snapshot chunks, replayed asks), so its arrival marks the end of the replayed asks. The same barrier, sent after a `prompt` or `abort`, confirms the host has handled that frame.

### Discovery loop

Nothing in omp polls for you. A caller that only runs one-shot commands (no stdin, allowlisted commands) can:

1. Poll `omp collab list --json` every ~15 s. When a host's `inputRequired` turns `true`, exit the polling job so the caller wakes up.
2. Mint a link into a `0600` file: `omp collab link <instanceId> --json`. The link is bound to the host's room generation, so re-mint after `stale_generation` or exit code 5.
3. Run `omp join --once --link-file <f> --print-requests` and relay the requests (title, options) to a human.
4. Run `omp join --once --link-file <f> --answer <reqId> --value "<label>"` with the reply. `already-settled` means someone answered at the terminal first.

## Link format

Accepted by `/join <link>` and `omp join "<link>"`:

```
<roomId>.<key>                                                    → default relay (wss://my.omp.sh)
<roomId>#<key>                                                    → legacy bare form
host[:port]/r/<roomId>.<key>                                     → custom relay, wss:// inferred
host[:port]/r/<roomId>#<key>                                     → legacy direct relay form
https://host[:port]/r/<roomId>.<key>                             → direct relay URL, normalized to wss://
wss://host[:port]/r/<roomId>.<key>                               → direct websocket relay URL
ws://localhost:7475/r/<roomId>.<key>                             → direct plain ws, localhost only
https://host[:port]/#<link>                                      → browser deep link when web UI and relay share a host
https://web-host[:port][/<path>]/#<relay-link>                   → browser UI wrapper with relay link in the fragment
https://web.example/collab/#relay.example.com/r/<roomId>.<key>   → web UI and relay on different hosts
```

`<link>` / `<relay-link>` are parsed recursively as any accepted link above. For `http(s)` browser wrappers with a parseable fragment, the fragment wins before the HTTP host/path are treated as a relay. This lets `https://web.example/collab/#relay.example.com/r/<roomId>.<key>` open the web UI at `web.example` while joining `wss://relay.example.com/r/<roomId>`. If the fragment is not a complete collab link, parsing falls back to the legacy direct relay form, so `https://relay.example.com/r/<roomId>#<key>` still means relay `relay.example.com`.

The trailing `.<key>` or `#<key>` part is the room secret, base64url-encoded, in one of two strengths:

- **Full link** — 48 bytes: the 32-byte AES-256-GCM room key followed by a 16-byte write token. Grants prompting, interrupting, and subagent control.
- **View-only link** — the bare 32-byte key, no write token. Grants live read access only. Pre-token links parse as view-only.

The room secret is dot-joined in newly generated links because RFC 3986 forbids a raw `#` inside a URL fragment; parsers still accept legacy `#` forms and `%23`-mangled legacy deep links.

## End-to-end encryption

Every session payload (entries, events, state, prompts) is sealed with AES-256-GCM before it touches the socket. The relay sees only:

- room ids and connection counts,
- opaque ciphertext frames and their sizes,
- a 4-byte routing prefix (which guest a frame targets).

Possession of the link is the trust boundary: a full link reads and steers the session, a view-only link reads it. Share both like secrets.

## Guest permission model

Two trust levels, enforced by the link itself — the host verifies the 16-byte write token at join and rejects writes from peers without it (they appear as read-only in the participants list, and the join notice says so).

Guests with a full link can:

- read the entire session (including the back-transcript at join time),
- prompt the agent (rendered with their name badge on every participant's transcript; the LLM sees the prompt text verbatim — names are display-only),
- interrupt the agent (Esc),
- use [Agent Hub](./agent-hub.md) against the host's subagents: live table and progress, chat (steers the host's subagent), kill, revive, and transcript viewing (fetched from the host on demand).
- answer host interactive `select` and `editor` requests. The host broadcasts each pending request only to writable guests; the first submitted or cancelled response settles it and dismisses the other presentations.

Guests with a view-only link can read everything live — back-transcript, streaming text, tool cards, subagent transcripts — but the host rejects prompting, interrupting, and agent control from them.

Advisor records are not guest-visible subagents: they are excluded from roster snapshots and transcript fetches, and advisor chat/kill/revive commands are rejected.

Other session/machine commands remain host-only: `/model`, `/compact`, `/resume`, `/branch`, bash (`!`), python (`$`), skills, etc. Guests keep a small local allowlist (`/dump`, `/export`, `/copy`, `/open`, `/help`, `/hotkeys`, `/theme`, `/settings`, `/leave`, `/collab`, `/exit`, `/quit`).

When a guest joins during an assistant turn, that in-flight turn appears on the first subsequent `message_update`: the guest synthesizes the missing `message_start` from the update's full accumulating message before forwarding the delta. If the host emits no further update for that turn after the guest joins, there is no update from which to synthesize the live component. The durable entry still reaches the replica's message state, but entry frames are intentionally not rendered, so that edge case can remain absent from the live TUI.

## Web client

`packages/collab-web` is a standalone browser client for the same links — no omp install needed on the guest side. The relay serves it at `/`, which is what makes the `/collab` deep link click-to-join: `https://<relay>/#<link>` loads the client and auto-connects from the fragment. It renders the live transcript (streaming text, thinking, tool cards), a subagent panel with on-demand transcripts, and a composer with the same guest powers (prompt, interrupt, hub actions). Run `bun run dev` in the package for a local instance, `bun run mock-host` for an offline scripted host to develop against, and `bun run build` to emit a static `dist/` deployable anywhere (HTTPS required for WebCrypto). The client never talks to anything but the relay, and the key stays in the URL fragment.

Set `collab.webUrl` when the browser UI is hosted separately from the websocket relay. When empty, `/collab` derives `http(s)://host[:port]` from `collab.relayUrl`; explicit web UI URLs must use `https://` except for localhost/loopback `http://` development origins, and cannot contain a query string or fragment. The generated browser URL still carries the relay-specific collab link in the fragment.

## Settings

| Setting               | Default               | Meaning                                                                                                        |
| --------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `collab.relayUrl`     | `wss://my.omp.sh`     | Relay used by `/collab` when no relay is passed inline                                                         |
| `collab.webUrl`       | empty                 | Browser UI URL for `/collab` links; empty derives from relay; explicit `http://` is allowed only for localhost |
| `collab.displayName`  | OS username           | Name shown to other participants                                                                               |
| `collab.autoStart`    | `off`                 | `view` / `control`: host every interactive session as it starts and publish it to the local registry           |
| `share.serverUrl`     | `https://my.omp.sh/s` | Share viewer/upload base used by `/share` (links are `<base>/<id>#<key>`)                                      |
| `share.store`         | `blob`                | `/share` uploads to the blob server; `gist` uses an authenticated secret gist with blob fallback               |
| `share.redactSecrets` | `true`                | Run the secret obfuscator over `/share` snapshots before upload                                                |

## Self-hosting the relay

The production relay is not currently distributed for self-hosting: its Go source and standalone binaries are not published. The endpoint list below documents the hosted service's network contract, not an installable release.

For local protocol development, this repository includes a source-available, WebSocket-only stand-in at [`packages/collab-web/scripts/local-relay.ts`](../packages/collab-web/scripts/local-relay.ts). Run `bun run relay` from `packages/collab-web` to listen on `ws://localhost:7466`. It implements `/r/<roomId>` but does not serve the browser client, `/share` blobs, or `/healthz`, so it is not a replacement for the production service.

The relay is a small content-blind Go service. It keeps no state beyond live connections and exposes:

- `GET /` — the static collab-web guest client (target of the `/collab` deep link),
- `GET /r/<roomId>?role=host|guest` — WebSocket upgrade,
- `POST /s` / `GET /s/<id>` / `GET /s/<id>/raw` — `/share` blob upload, viewer page, and blob fetch,
- `GET /healthz` — liveness.

## Implementation files

- [`src/slash-commands/builtin-collaboration.ts`](../packages/coding-agent/src/slash-commands/builtin-collaboration.ts) — TUI commands and join-link presentation
- [`src/collab/controller.ts`](../packages/coding-agent/src/collab/controller.ts) — auto-start and room rotation
- [`src/collab/host.ts`](../packages/coding-agent/src/collab/host.ts), [`guest.ts`](../packages/coding-agent/src/collab/guest.ts) — authoritative host and local replica
- [`src/collab/protocol.ts`](../packages/coding-agent/src/collab/protocol.ts), [`crypto.ts`](../packages/coding-agent/src/collab/crypto.ts), [`relay-client.ts`](../packages/coding-agent/src/collab/relay-client.ts) — frames, links, encryption, and transport
- [`src/collab/registry.ts`](../packages/coding-agent/src/collab/registry.ts) — private local host discovery
- [`src/collab/headless-guest.ts`](../packages/coding-agent/src/collab/headless-guest.ts), [`src/cli/join-once-cli.ts`](../packages/coding-agent/src/cli/join-once-cli.ts) — `omp join --once`
- [`src/collab/settings.ts`](../packages/coding-agent/src/collab/settings.ts) — `collab.*` defaults
- [`packages/collab-web`](../packages/collab-web/) — browser guest and local development relay

## Architecture notes

Hub topology — the host is authoritative, guests never peer:

1. `welcome` + `snapshot-chunk` frames — initial state and transcript. The transcript is byte-bounded into chunks so each arrival resets the guest's progress timeout; oversized replicated entries are shrunk before transmission.
2. `entry` frames — durable session entries, broadcast pre-blob-externalization so images stay inline (guests cannot resolve host blob refs). Guests append them with ids preserved to a replica session file under `~/.omp/collab/<roomId>.jsonl` and into the agent's message array, which is why `/dump` and context estimates work.
3. `event` frames — live agent events, fed straight into the guest's normal event controller; rendering is events-only to prevent double-render.
4. `state` frames — debounced footer snapshots: streaming flag, the host's full model object and thinking level (applied to the guest's replica agent state, so model display and context-window math are native), host context numbers, and participants.
5. `bus` frames — mirrored task-subagent lifecycle/progress EventBus traffic, republished on the guest's local bus so the subagent HUD and status-line count work natively.
6. `agents` frames — agent-registry snapshots feeding a guest-local registry, so the Agent Hub table renders host subagents.
7. `ui-request` / `ui-request-end` frames — host select/editor prompts presented to full-control guests and dismissed everywhere once settled. Guests answer with `ui-response`.

Guest→host: `hello`, `prompt`, `abort`, `agent-cmd` (hub chat/kill/revive), `fetch-transcript` (incremental subagent-transcript reads answered by targeted `transcript` frames), and `ui-response`. The replica loads through the regular `/resume` machinery, so theming, ctrl+o, and transcript behavior are native by construction; the guest process never chdirs to host paths.

Transcript fetches are capped at 4 MiB per reply and end on complete JSONL lines. Guests continue from `newSize`; a single entry exceeding the cap produces a terminal transcript error instead of an endless empty-read retry.
