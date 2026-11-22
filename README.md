# pi-bgwait-bridge

Make native **`bg_wait`** wait for **pi-background-tasks** work as well as **pi-subagents**
async runs, and add **`bg_wait_unified`** for the waits the native provider contract cannot
express (exact task ids, mixed scopes, per-task failures).

Verified against the packages installed on this machine:

| Package | Version |
| --- | --- |
| `pi-subagents` | 0.89.2 |
| `pi-background-tasks` | 2.6.10 |
| `pi-goal-x` | 0.34.1 |
| Pi (`@earendil-works/pi-coding-agent`) | 1.6.0 |

## What problem this solves

`bg_wait` has **two** sources of background work and only one of them was reachable:

1. **Async subagents** — built into `bg_wait` (`runsForSession`, `matchesId`).
2. **pi-background-tasks jobs** (`bg_run`, `bg_delegate`, `fusion_*`, …) — reachable only
   through pi-subagents' *background-work provider* registry. Without a provider, a session
   with a running `bg_run` still answered:

   > `No active async runs or registered provider work in this session. Nothing to wait for.`

This extension registers that provider. After install:

- `bg_wait({all:true})` blocks until **both** kinds finish.
- `bg_wait` on an async-only session is unchanged.
- `bg_wait({id})` still covers subagent run ids only (pi-subagents resolves `id` against runs).
  Use `bg_wait_unified({ids:[…]})` for background task ids.

## Install

### Windows

```cmd
REM from the package directory
scripts\install-windows.cmd            REM user scope (writes ~/.pi/agent/settings.json)
scripts\install-windows.cmd --local    REM project scope (writes .pi/settings.json)
```

Manual equivalent:

```cmd
pi install .\            REM user scope
pi install .\ -l         REM project scope
```

`pi install` records the package in `settings.json`; the extension declares itself under
`package.json` → `pi.extensions`, so no extra path is needed.

### Linux / macOS

```bash
scripts/install-unix.sh           # user scope
scripts/install-unix.sh --local   # project scope
```

Manual equivalent: `pi install .` or `pi install . -l`.

### Try it without installing

```bash
pi -e . -p "…"
```

### Verify the install

```bash
pi list | grep pi-bgwait-bridge
```

Inside a session, `PI_BGWAIT_BRIDGE_DEBUG=1` prints to **stderr**:

```
[pi-bgwait-bridge] provider "pi-background-tasks" registered (registry|official)
[pi-bgwait-bridge] bridge created for <session file or id>
```

## Uninstall

### Windows

```cmd
scripts\uninstall-windows.cmd
scripts\uninstall-windows.cmd --local
```

### Linux / macOS

```bash
scripts/uninstall-unix.sh
scripts/uninstall-unix.sh --local
```

Manual equivalent: `pi remove .` (or `pi remove . -l`). The provider is removed on
`session_shutdown`; nothing is left behind in pi-subagents' registry, and no other
extension's state is touched.

### Rollback

The package touches nothing outside its own directory and two settings entries. To roll
back:

1. `pi remove pi-bgwait-bridge` (see above), then `/reload` in a running session.
2. Deleting the package directory is safe afterwards: no process holds references once
   the extension is unloaded.
3. If a session was left with a stale registration (only possible when a crash skipped
   `session_shutdown`), a Pi restart clears it — the registry lives in one process.

## Usage

### Native `bg_wait` — unchanged call, broader coverage

```ts
bg_wait({ all: true, stopOnAttention: false, timeoutMs: 7200000 })
```

Covers this session's async subagent runs **and** this session's pi-background-tasks jobs.

### `bg_wait_unified` — what native cannot do

```ts
// exactly these two tasks, ignoring anything else this session launched
bg_wait_unified({ ids: ["abc123", "def456"], timeoutMs: 3600000 })

// the whole session: background tasks running at wait start **and** async subagents
bg_wait_unified({ all: true, stopOnAttention: false, timeoutMs: 3600000 })

// first one to finish, either scope
bg_wait_unified({ any: true, ids: ["abc123", "def456"] })

// exact ids plus the subagent scope
bg_wait_unified({ ids: ["abc123"], includeNative: true })
```

Parameters:

| Field | Meaning |
| --- | --- |
| `ids` | exact background task ids (no prefixes), max 64 |
| `all` | every task running at wait start (plus async subagents — see below) |
| `any` | return on the first terminal state |
| `timeoutMs` | wait window; **never kills** the work |
| `stopOnAttention` | **opt-in**, default `false`. Attention notices, intercom messages and supervisor requests that appear *during* the wait always end it; `true` additionally lets native `bg_wait` end on a notice it sees first |
| `includeNative` | `true` forces the subagent scope, `false` opts out |

**Subagent scope.** A session-wide call (`all`, `any`, or no `ids`) also waits for async
subagents by nesting one native `bg_wait`; explicit `ids` mean "exactly these background
tasks" and stay background-only unless `includeNative:true` is set. This is why a
`bg_wait_unified({all:true})` issued right after `/reload` still waits for a running
subagent instead of answering "no background task is running".

A failed or killed task is reported as a failure (`isError: true`, `details.failed`,
`details.failedIds`), never as success.

### Launch parameters for tasks a wait will cover

```ts
bg_run({ …, notifyOnCompletion: true, triggerOnCompletion: false })
```

`notifyOnCompletion:true` keeps the completion notification; `triggerOnCompletion:false`
stops it from starting a second agent turn while the wait is blocking. Tasks launched with
the defaults (`triggerOnCompletion:true`) keep their behavior — this extension never edits
them — and the wait result says so:

> Notification coordination: `<ids>` will also start a follow-up turn when it finishes …

## Behavior details worth knowing

- **Ownership.** `BgTaskSnapshot` has no `sessionId`, and the extension-surface `status`
  operation returns every retained task of the activation, so neither can establish
  ownership. Ownership comes from the pi-background-tasks **host** activation, whose
  `subscribe`/`list`/`detail` responses carry `sessionId` captured at `session_start`. An
  activation naming a different session is refused, not merged. See `SOURCE-AUDIT.md`.
- **Wakes.** `wakeChannels` only shorten polling; validated snapshots stay authoritative
  (pi-subagents' own rule). The provider also polls every 1.5 s as a fallback.
- **Duplicate terminal frames** are deduplicated by `id + status`.
- **Terminal wins over stale snapshots.** A `list` response issued before a task finished
  cannot resurrect it as running.
- **Wait ends without killing.** Timeout/user input/supervisor request/abort end the window;
  the task keeps running.
- **User input vs idle prompt.** Only *typed streaming* input (steer/follow-up) aborts a
  wait. Idle prompts and Goal-X's idle reminders never do.
- **Three signals end the wait (operator requirement, 2026-11-22).** An attention notice from
  a run of this session (`scout needs attention in run …`), an intercom message/ask another
  agent routed here (`… is waiting for a reply over intercom (ask …)`, with the question
  quoted), and a real `contact_supervisor` request (`… needs a supervisor reply (request …, reason
  …, run …, from …)`) all end `bg_wait_unified` before its window, with
  `Work keeps running.` The work is never killed. Sources: `src/subagent-signals.ts` (bus
  events, attributed to this session's runs by the launching `sessionId` in `status.json`),
  `src/intercom-probe.ts` (pi-intercom's own `pending-asks` ledger, because a steered intercom
  message is invisible while a blocking tool holds the turn), `src/supervisor-probe.ts`
  (pi-subagents' request files).
- **A supervisor request is decided by its request file, not by the bus notice.** pi-subagents
  emits the `needs_attention`/`supervisor_request` notice ~130 ms *before* it writes the request
  JSON (measured: event `ts` 1795346701226, request `createdAt` 1795346701359), so a notice-driven
  path would win every race and close the wait as the *attention* class. `onControlEvent`
  therefore drops that one reason, the probe owns the class, and the verdict names the file it
  read (`request <id>, reason <reason>, run <id>, from <agent>`). Both blocking reasons are
  covered — `need_decision` and `interview_request` (upstream blocks on either:
  `expectsReply = params.reason !== "progress_update"`, `native-supervisor-channel.js:133`).
- **Only signals observed *during* the wait count.** A notice that predates the call does not
  end it: a healthy child already marked `needs_attention` (e.g. an unread ask from an earlier
  turn) must not cut a fresh wait short — that was the 7 ms `attention required` regression.
- **Platform limit: a plain intercom `send` cannot end a wait, by design.** Each of the three
  classes above leaves an artifact a wait can read: a bus event (`subagent:control-event`,
  `subagent:control-intercom`), a request file, or a ledger file. pi-intercom's plain
  `send` (`expectsReply=false`) leaves none of them:
  - the broker only writes the ledger for asks — `broker/broker.ts:793-805`
    (`if (message.expectsReply) { this.writePendingAskRecord(…) }`); a plain send falls
    straight through to `writeMessage(target.socket, {type:"message", …})`
    (`broker/broker.ts:827-831`), an in-process socket frame plus the in-memory
    `messageReceiptRoutes` entry at `broker/broker.ts:826` — nothing on disk;
  - the receiving extension delivers it as a *steered* custom message:
    `pi-intercom/index.ts:1334-1341` `pi.sendMessage({customType:"intercom_message", …},
    … { deliverAs: "steer" })`, and Pi's `sendCustomMessage` in
    `pi-coding-agent/dist/core/agent-session.js:1968-1974` calls `this.agent.steer(appMessage)`
    when a run is streaming — the message is queued, not appended, so no `message_start`/
    `message_end` is emitted while a blocking tool call (this wait) holds the turn;
  - pi-intercom emits only four bus events (`pi-intercom/index.ts:1125`, `:2067`, `:2095`,
    `:2173` — outbox result, session identity, subagent result delivery, registry ready);
    none of them is an inbound message.

  So a wait ends on an ask (ledger), on a subagent-forwarded intercom notice
  (`subagent:control-intercom`), on an attention notice, and on a supervisor request — and a
  plain send is reported by the *next* turn, not by the wait. The `message_end` fallback in
  `extensions/bgwait-bridge.ts:219-232` still covers any intercom message that Pi actually
  appends to the session while the wait is open (i.e. one that arrives at a turn boundary), so
  nothing is silently dropped; the queue-only case is the documented limit, and it is not
  papered over with a synthetic signal.
- **A session with no background task still ends on a signal.** The native half owns the async
  run scope there; this tool's own loop stays beside it (`holdEmptyScope`) so the signals are
  seen. This is the reported case: `bg_wait_unified({all:true})` in a session whose only work
  is an async subagent.

## Testing

```bash
npm test                       # 125 unit tests, mock EventBus + controlled time
node scripts/live-e2e.mjs      # real pi process, real bg task, native bg_wait
node scripts/live-mixed.mjs    # real subagent + real bg task, one native bg_wait
node scripts/live-subagent-only.mjs  # only a subagent running: the unified wait must still wait
node scripts/live-attention.mjs      # a healthy run's attention must not end the wait early
node scripts/live-signals.mjs        # seven scenarios: every signal class ends the wait before its window (rpc mode)
LIVE_SIGNALS_SCENARIOS=supervisor-interview node scripts/live-signals.mjs  # contact_supervisor({reason:"interview_request"}) alone ends the wait
LIVE_SIGNALS_SCENARIOS=intercom-control node scripts/live-signals.mjs  # subagent:control-intercom alone ends the wait
```

The live scripts need `pi` on `PATH` (or `PI_LAUNCHER=<path to pi-launcher.js>`), take
1–3 minutes, and assert on `[live-e2e]` / `[live-mixed]` / `[live-signals]` evidence lines.
`LIVE_SIGNALS_SCENARIOS` takes a comma-separated subset of
`intercom, intercom-control, attention, supervisor, supervisor-interview, idle, any-subagent`,
which is how the per-class logs in `COMPATIBILITY.md` were produced.

See `COMPATIBILITY.md` for the tested matrix and known limits, and `AGENTS.md` for the
rules this package holds itself to.
