# SOURCE-AUDIT — interfaces verified against the installed packages

Everything below was read from the packages actually installed on this machine, not from
upstream `main`. Versions:

| Package | Version | Path |
| --- | --- | --- |
| `pi-subagents` | 0.89.2 | `~/.pi/agent/npm/node_modules/pi-subagents` |
| `pi-background-tasks` | 2.6.10 | `~/.pi/agent/npm/node_modules/pi-background-tasks` |
| `pi-goal-x` | 0.34.1 | `~/.pi/agent/npm/node_modules/pi-goal-x` |
| Pi (`@earendil-works/pi-coding-agent`) | 1.6.0 | `~/.pi/agent/install/releases/1.6.0` |

The upstream docs the task brief links were checked only to name the seams; every claim
below is backed by a source location in the installed copy.

## 1. pi-subagents: `registerBackgroundWorkProvider`

### Exported surface

`package.json` → `exports["./background-work"]` → `bundle/background-work.js`, types
`src/api/background-work.d.ts`. Runtime exports (verified by importing the bundle):

```
BACKGROUND_WORK_PROTOCOL_VERSION   // 1
BACKGROUND_WORK_REGISTRY_KEY       // "pi-subagents.background-work.v1"
listBackgroundWorkProviders
listBackgroundWorkWakeChannels
registerBackgroundWorkProvider
snapshotBackgroundWork
```

`src/api/background-work.js` defines the registry as a **process-global symbol**:

```js
const key = Symbol.for("pi-subagents.background-work.v1");
globalObject[key] = { version: 1, providers: new Map() };
```

This is why two independently loaded extension modules meet in one registry, and why
this package can register without importing pi-subagents at all.

### Provider contract (validated, not advisory)

`validateProvider` rejects unknown fields outright, so a provider object may contain **only**
`name`, `listActiveWork`, `wakeChannels`, `reconcile`:

* `name` — non-empty, trimmed, ≤128 chars.
* `listActiveWork` — required function; must return an array (≤10 000 items).
* `wakeChannels` — optional array of non-empty strings ≤256 chars, no duplicates.
* `reconcile` — optional function.

Item validation (`validateItem`) allows exactly `id` (≤256 chars) and `sessionId`
(≤4096 chars). Any third field on an item fails the whole snapshot.

### Reload-safety and replacement

```js
current.providers.set(validated.name, validated);
return () => { if (current.providers.get(validated.name) === validated) current.providers.delete(validated.name); };
```

A new provider with the same name replaces the old callback, and the **old disposer cannot
remove the replacement** (identity check). This is what makes re-registration on
`session_start` safe.

### Snapshot filtering (the part that decides what is "current session")

```js
provider.reconcile?.( { sessionId, sessionIds, nowMs } );
const active = provider.listActiveWork({ sessionId, sessionIds, nowMs });
// accepted = every identity form of the active session; items keyed by any of them are kept
if (accepted.includes(item.sessionId)) items.push({ provider: provider.name, ...item });
```

`sessionIds` holds **both** forms of the current session: the session file path when one
exists, and `getSessionId()`. The first element is `sessionId`. Both are accepted on the
item. This is exactly the seam the bridge uses to report the form the caller asked for
(`src/ownership.ts#itemSessionId`).

### How `bg_wait` consumes providers — and the two gaps this package fills

`src/runs/background/subagent-wait.js`:

* `backgroundWorkForSession(deps)` (:182) builds `sessionIds` from
  `state.currentSessionId` (= `getSessionFile() ?? getSessionId()`) and
  `state.supervisorOwnerSessionId` (= `getSessionId()`), then calls
  `snapshotBackgroundWork`.
* Item identity for dedupe and completion tracking is
  `${provider}\0${sessionId}\0${id}` (:179, :604).
* **`id` never reaches provider items.** `params.id` resolves only through
  `runsForIds`/`matchesId` (:132) against subagent runs and detached foreground runs
  (:591-:620). With `params.id` set, `providerSnapshot` is forced to
  `{providers: [], items: []}` (:562). Consequence: `bg_wait({id: "<bg task id>"})` answers
  *"No active run matched …"* while the task runs.
* `all:true` is aggregate only (`isDone` at :638-:644): every initially-active item must
  leave the active set. It cannot express "only these three tasks".
* The no-work branch (:625) is the string
  `"No active async runs or registered provider work in this session. Nothing to wait for."`
  — the message the brief requires the bridge to eliminate for a running `bg_run`.
* Fail-closed behavior: if a provider name present in the initial snapshot disappears from a
  later one, the wait returns an error (:671-:675).
* Poll interval: `max(250, deps.pollIntervalMs ?? 1000)` (:55-:56, :537). Wake channels only
  shorten polling; validated snapshots remain authoritative (`waitForWake`, :88-:135).
* Provider wake channels are read through `listBackgroundWorkWakeChannels()` (:92), so the
  bridge's `wakeChannels` are subscribed by `bg_wait` itself.

**Conclusion:** aggregate provider support exists; exact-id and mixed-scope waits do not.
`bg_wait_unified` is therefore required by the confirmed acceptance table, not optional.

## 2. pi-background-tasks: which surface carries ownership

### Public EventBus v1 (extension surface)

`src/core/extension-api.ts`:

```ts
BG_REQUEST_CHANNEL  = 'pi-background-tasks:request:v1';
BG_RESPONSE_CHANNEL = 'pi-background-tasks:response:v1';
BG_TERMINAL_CHANNEL = 'pi-background-tasks:terminal:v1';
BG_REQUEST_SCHEMA   = 'pi-background-tasks.extension-request.v1';
BG_RESPONSE_SCHEMA  = 'pi-background-tasks.extension-response.v1';
BG_TERMINAL_SCHEMA  = 'pi-background-tasks.extension-terminal.v1';
```

Operations: `capabilities`, `run`, `status`, `logs`, `kill`. Capabilities at runtime
(`BG_EXTENSION_CAPABILITIES`): `run`, `run_is_agent`, `run_completion_trigger`, `status`,
`logs`, `logs_bounded`, `kill` — all `true`.

Terminal frame: `{ schema_version, task: BgTaskSnapshot }` (no session id).
`status` result: `{ tasks: BgTaskSnapshot[] }` from `this.registry.allTasks()` (:529-:534).

### `BgTaskSnapshot` has no sessionId

`src/core/common.ts:221`:

```
id, name?, command, description?, status, outputPath, cwd, startTime, endTime?, exitCode?,
signal?, pid?, bytesWritten, isAgent, surviveReload, reloadSurvival?, error?, notified,
notifyOnCompletion, triggerOnCompletion, timeoutSeconds?, contextUsage?, tokenUsage?,
toolUsage?, model?, telemetryUnavailableReason?, shellPolicy?, attestationPath?, delegate?
```

No `sessionId`. The task id itself encodes a **sanitized** session segment
(`registry.ts:1264-:1265`: `sanitizePathSegment(ctx.sessionId)` → `sessionId-pid` directory),
which is lossy (`common.ts:511-513` replaces every non `[A-Za-z0-9_.-]` run with `-`) and is
therefore **not** usable as an ownership key. `cwd` is shared by every session in a project.

**Consequence:** the extension surface cannot establish ownership. `status` returns the
activation's whole retained set, so using it would merge other sessions' tasks into this
wait — explicitly forbidden by the brief.

### Host EventBus v1 carries the trusted launch record

`src/core/host-protocol.ts`:

```ts
HOST_REQUEST_CHANNEL = 'pi-background-tasks:host:request:v1';
HOST_RESPONSE_CHANNEL = 'pi-background-tasks:host:response:v1';
HOST_CHANGED_CHANNEL = 'pi-background-tasks:host:changed:v1';
HOST_REQUEST_SCHEMA  = 'pi-background-tasks.host-request.v1';
HOST_RESPONSE_SCHEMA = 'pi-background-tasks.host-response.v1';
HOST_CHANGED_SCHEMA  = 'pi-background-tasks.host-changed.v1';
```

Operations: `capabilities`, `subscribe`, `unsubscribe`, `list`, `detail`, `logs`, `stop`,
`stop_all`, `rerun`, `result`, `mark_seen`.
Bounds: max page size 50, max log bytes 65536, frame cap 256 KiB, ≤8 live leases,
≤16 in flight, 100 ms change coalescing.

`HostActivationFacts` — returned by `subscribe` and by **every** `list` response, and carried
by every `changed` frame — includes:

```ts
activationId, sessionId, revision, observedAt, counts
```

`sessionId` is captured at `session_start` (`extension.ts:263-:268` builds
`registryContext(ctx)` with `sessionId: ctx.sessionManager.getSessionId()`), stored by
`HostService.markReady()` (`host-api.ts:293-:297`), and stamped into frames
(`activationFacts()`, :569-:582). **This is the trusted launch record.**

What the bridge relies on:

* `subscribe {clientId}` → `{leaseId, activationId, sessionId, revision, observedAt, counts}`
  (`host-api.ts:584-`: same `clientId` in one activation returns the same lease).
* Every leased operation carries `{leaseId, activationId, sequence}` and a strictly
  increasing `sequence` per lease (replays of an identical request return the cached frame;
  a different request on a used sequence is `CONFLICT`; a too-old sequence is
  `STALE_REQUEST`).
* `list {cursor?, limit?}` pages newest-first, ≤50 per page, with an activation-scoped
  opaque cursor.
* `detail {taskId}` takes an **exact** id; prefixes are never resolved
  (`findTask` in `host-api.ts:648-:654` finds by exact id only, otherwise `NOT_FOUND`).
* Error codes the client must branch on: `UNAVAILABLE`, `CLOSED`, `LEASE_INVALID`,
  `LEASE_LIMIT`, `ACTIVATION_MISMATCH`, `STALE_REQUEST`, `CONFLICT`, `BUSY`, `NOT_FOUND`,
  `INVALID_CURSOR`, `TOO_LARGE`, `OPERATION_FAILED`.

`ready` publication: a fresh initialized activation emits exactly one `changed` frame with
`kind: "ready"` (`markReady` → `publishChange('ready')`), so a consumer can discover it
regardless of extension load order. Change frames are coalesced and only published while a
lease is live (`invalidate()`, :302-:314).

### Terminal truth and duplicate suppression

`registry.ts:3695-:3730` — `publishTerminal` is gated by
`terminalPublicationState === 'pending'` and `terminalPublishInFlight`, then emitted once on
`BG_TERMINAL_CHANNEL` (`extension-api.ts:449`). A task's terminal state is therefore
published exactly once, but a **replayed** frame is still possible after a reload, so the
bridge deduplicates by `id + status` (`src/bridge.ts#noteTerminal`) rather than counting frames.

### Notification coordination (`triggerOnCompletion`)

`docs/tools/bg_run.md`: `notifyOnCompletion` (default true) delivers the durable terminal
notification; `triggerOnCompletion` (default true for `bg_run`) makes that notification start
a follow-up agent turn; it requires `notifyOnCompletion`. `StartTaskOptions`
(`common.ts:446`) accepts both. Neither can be changed after launch, so the bridge cannot
retro-fit an already-running task; the agreed launch params are documented in README.md and
in the tool's own `promptGuidelines`.

## 3. Pi 1.6.0: seams used by the extension

* `pi.on("session_start" | "session_shutdown" | "input" | "tool_result")`
  (`docs/extensions.md` §Events).
* `session_start` runs after the previous runtime's `session_shutdown`; a replacement binds a
  fresh extension instance (`docs/extensions.md` §Session replacement lifecycle), so
  registering again on `session_start` is the reload-safe path.
* `input` event: `event.streamingBehavior` is `undefined` when idle, `"steer"`/`"followUp"`
  when typed into a running turn. The bridge aborts an open wait only for the latter — the
  240 s idle reminder and idle prompts never abort.
* `tool_result` carries `details`, which is where `bg_run`/`bg_*` put `task`/`tasks`
  (`BgRunDetails`, `BgStatusDetails` in `pi-background-tasks` `common.ts:425-431`).
* `ctx.executeTool(name, args, { signal })` for the optional nested native `bg_wait` call.
* `ctx.hasPendingMessages()` (`agent-session.js:2932`, forwarded by
  `core/extensions/runner.js:238`/`:683-686`) reports `pendingMessageCount > 0`, i.e. a steered or
  follow-up custom message is queued. A steered message emits **no** `message_start`/
  `message_end` until the agent loop drains the queue at a turn boundary
  (`agent-session.js:1968-1974` `this.agent.steer(appMessage)`; the comment at `:1983-1988`
  states that appending now would put a message between a tool call and its result). Both
  facts together fix the boundary of the intercom-signal claim: an ask is observable through
  pi-intercom's ledger, a subagent-routed notice through `subagent:control-intercom`, and a
  plain `send` only after the turn ends.
* `ctx.sendMessage(message, options)` (`agent-session.js:3734`) is what pi-intercom uses to
  inject an inbound message (`pi-intercom/index.ts:1334-1341`); it never reaches the bus while
  the wait holds the turn.
* `pi.registerTool({ parameters })` validates JSON Schema; `typebox` is a Pi-aliased import
  (`docs/extensions.md` §Available Imports), available to extension code but **not** to
  code run outside Pi. The parameter schema therefore lives in the extension module
  (`extensions/bgwait-bridge.ts`) while `src/**` stays dependency-free and unit-testable.

## 4. Differences from the upstream `main` docs the brief linked

The brief points at
`pi-subagents/docs/extension-api.md@v0.89.2` and
`pi-background-tasks/docs/api/eventbus-v1.md@main`. Checked against the installed copies:

| Claim in upstream docs | Installed reality (2.6.10 / 0.89.2) |
| --- | --- |
| host interface is "optional" | it is installed and available by default (`eventbus-host-v1.md`: Availability `always`) |
| `list` unlimited | hard cap 50/page, `INVALID_CURSOR` otherwise |
| `status` usable for discovery | returns the activation's whole retained set; **no** session field → unusable for ownership |
| provider `id` reachable from `bg_wait` | not reachable; `params.id` scopes subagent runs only |
| `wakeChannels` "wake" the wait | they only shorten polling; snapshots stay authoritative |

No claim in this file depends on a `main`-branch-only capability.
