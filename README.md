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

// every background task running when the wait starts
bg_wait_unified({ all: true, stopOnAttention: false, timeoutMs: 3600000 })

// first one to finish
bg_wait_unified({ any: true, ids: ["abc123", "def456"] })

// also wait for async subagents in the same call (nests one native bg_wait)
bg_wait_unified({ all: true, includeNative: true })
```

Parameters:

| Field | Meaning |
| --- | --- |
| `ids` | exact background task ids (no prefixes), max 64 |
| `all` | every task running at wait start |
| `any` | return on the first terminal state |
| `timeoutMs` | wait window; **never kills** the work |
| `stopOnAttention` | default `true`; a supervisor request ends the wait, idle reminders never do |
| `includeNative` | also wait for async runs (nests one `bg_wait`) |

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

## Testing

```bash
npm test                       # 68 unit tests, mock EventBus + controlled time
node scripts/live-e2e.mjs      # real pi process, real bg task, native bg_wait
node scripts/live-mixed.mjs    # real subagent + real bg task, one native bg_wait
```

The live scripts need `pi` on `PATH` (or `PI_LAUNCHER=<path to pi-launcher.js>`), take
1–3 minutes, and assert on `[live-e2e]` / `[live-mixed]` evidence lines.

See `COMPATIBILITY.md` for the tested matrix and known limits, and `AGENTS.md` for the
rules this package holds itself to.
