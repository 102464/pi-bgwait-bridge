# COMPATIBILITY

Verified on this machine (Windows 11, Node 24.19.0) against:

| Package | Version tested | Notes |
| --- | --- | --- |
| `pi-subagents` | 0.89.2 | provider registry `Symbol.for("pi-subagents.background-work.v1")`, `bg_wait` semantics audited in `SOURCE-AUDIT.md` |
| `pi-background-tasks` | 2.6.10 | extension EventBus v1 + host EventBus v1 |
| `pi-goal-x` | 0.34.1 | read-only compatibility, no state touched |
| Pi | 1.6.0 | `session_start`/`session_shutdown`/`input`/`tool_result`, `registerTool`, `executeTool` |

## Tested matrix

Every row of the brief's table, with the automated test that covers it. `test/matrix.test.ts`
carries the row number and the original scenario text inline.

| Row | Scenario | Expected | Covered by |
| --- | --- | --- | --- |
| 1 | 仅一个子代理 | 正常等待并返回 | `matrix.test.ts` row 1, `mixed-scope-defaults.test.ts` (session-wide call delegates the run scope to native `bg_wait`), `live-mixed.mjs` |
| 2 | 仅一个 bg_run 任务 | 正常等待并返回 | `matrix.test.ts` row 2, `live-e2e.mjs` |
| 3 | 三个 bg_run 并行 | `all:true` 等待全部完成 | `matrix.test.ts` row 3 |
| 4 | 两个子代理 + 一个 bg_run | `all:true` 等待三者全部完成 | `matrix.test.ts` row 4, **`live-mixed.mjs`** (1 async run + 1 provider item in one native `bg_wait`) |
| 5 | 子代理先完成，bg_run 未完成 | 继续等待 | `matrix.test.ts` row 5, `live-mixed.mjs` (waited 19 s while the subagent finished first) |
| 6 | bg_run 先完成，子代理未完成 | 继续等待 | `matrix.test.ts` row 6 (native `bg_wait` owns the run scope; the provider scope returns and the run scope keeps blocking) |
| 7 | `all:false` 任意任务完成 | 正常提前返回 | `matrix.test.ts` row 7, `unified-wait.test.ts` |
| 8 | Supervisor 请求 | 立即结束等待以便回复 | `matrix.test.ts` row 8 |
| 9 | 用户输入 | 立即结束等待 | `matrix.test.ts` row 9, `extension.test.ts` |
| 10 | 240 秒 idle 通知 / 任一 attention 通知 | 等待**期间**出现即结束等待（`subagent_signal`，文案点名 run 与 agent）；等待开始前已有的不结束 | `unified-wait.test.ts`（本会话新通知结束、外来 run 不结束、早于开始的旧通知不结束）、`matrix.test.ts` row 10 (replayed change-frame churn)、`extension.test.ts` |
| 11 | bg_run 失败 | 正确报告失败 | `matrix.test.ts` row 11, `extension.test.ts` (`isError: true`) |
| 12 | 等待超时 | 返回超时，后台工作继续 | `matrix.test.ts` row 12 |
| 13 | 重复终态通知 | 不产生重复完成 | `matrix.test.ts` row 13, `bridge.test.ts` |
| 14 | 会话切换 | 不混入其他会话任务 | `matrix.test.ts` row 14, `bridge.test.ts`, `extension.test.ts`, `subagent-path.test.ts` |
| 15 | Goal-X 计时 | 等待期间继续增长 | `matrix.test.ts` row 15 (real wall-clock), `goalx.test.ts` (no surviving timers) |
| 16 | Goal-X 自动继续 | 等待期间不空转 | `matrix.test.ts` row 16 (no self-rescheduling, one subscriber), `goalx.test.ts` (no message/turn injection) |

Run records (reproduce locally; `evidence/` is in `.gitignore`, so the logs these
commands write are per-machine observations and never committed):

- `npm test` → **125 tests, 125 pass, 0 fail**
- `node scripts/live-e2e.mjs` → **10/10 live checks pass**
- `node scripts/live-mixed.mjs` → **9/9 live checks pass**
- `node scripts/live-subagent-only.mjs` → **5/5 live checks pass**
  — the post-reload regression: only a subagent running, one `bg_wait_unified({all:true})`
- `node scripts/live-attention.mjs` → **7/7 live checks pass**
  — the attention regression: a subagent tripping `needs_attention` must not end the wait,
    and the post-reload empty-scope wait must return on the native answer rather than ride
    out its window (`waited <= native_waited + 20 s`)
- `node scripts/live-signals.mjs` → **11/11 live checks pass across 6 scenarios** (`intercom`,
  `intercom-control`, `attention`, `supervisor`, `idle`, `any-subagent`), each ending before
  its window (5.5 s / 14.1 s / 29.5 s / 12.0 s / 0.6 s / 29.4 s)
- All four live scripts also pass with `--installed`, i.e. loaded from `settings.json`

### Not covered: extension load order

A local baseline note (`evidence/goalx-baseline.txt`, written by hand and not committed)
records a **negative** result and stands as a warning, not as
proof. In a session that predates the install, native `bg_wait` still answers
`No active async runs or registered provider work in this session. Nothing to wait for.`
while a `bg_run` task is running: an already-running Pi process has the extension in
`settings.json` but not in its module graph, so no provider is registered in that process.
Goal-X's clock is unaffected (`activeSeconds` keeps increasing across the wait), which is
the part that matters for Goal-X compatibility.

The operational consequence: after installing, **`/reload` (or restart Pi) before trusting a
`bg_wait` result**. This is a property of Pi's extension loading, not a bug this package can
fix without patching the host.

## Mixed-scope defaults (fix for the post-reload empty wait)

Before this fix, `bg_wait_unified({all:true})` after a `/reload` — with only an async subagent
running — answered `No background task of this session is running; nothing to wait for.`
The tool is advertised as mixed-scope, so that answer was wrong: work was in flight.

Rule now (`src/unified-tool.ts#wantsNativeScope`):

| Call | Subagent scope |
| --- | --- |
| `{all:true}`, `{any:true}`, `{}` | included — delegates one native `bg_wait` |
| `{ids:[…]}` | excluded (exact background tasks only) |
| `{…, includeNative:true}` | included |
| `{…, includeNative:false}` | excluded |

When the background scope is empty but the native scope is live, the native verdict is
reported verbatim instead of being replaced by a "nothing to wait for" line, and a nested
native failure is surfaced rather than counted as a completed wait. Covered by
`test/mixed-scope-defaults.test.ts` (11 cases) plus `matrix.test.ts` row 1.

## Attention notices (fix for the "attention required" early return)

`bg_wait_unified({all:true})` once returned after **7 ms** with `attention required` while the
subagent was still working.

Cause: the tool forwarded `stopOnAttention:true` to native `bg_wait`. In pi-subagents 0.89.2,

```js
// subagent-wait.js:630,638
const stopOnAttention = params.stopOnAttention ?? deps.stopOnAttention !== false;
if (attention.some((run) => initialAsyncIds.has(run.id) && (stopOnAttention || hasSupervisorTool(run))))
```

`stopOnAttention:true` short-circuits the supervisor test, so **any** `needs_attention` ends the
wait. Its ordinary sources (`runs/shared/subagent-control.js:9-12`) are an open tool at 240 s
(`activeNoticeAfterMs`) and three consecutive failing mutating tools
(`failedToolAttemptsBeforeAttention`). None of those is a supervisor ask.

Rule now:

| Call | Ends on a real supervisor request | Ends on an attention notice or intercom message |
| --- | --- | --- |
| default / `stopOnAttention:false` | yes — either the native barrier or `src/supervisor-probe.ts` | yes, when it appears **during** this wait (`src/subagent-signals.ts`) |
| `stopOnAttention:true` | yes | yes — additionally lets native `bg_wait` end on it first |

Wait-period rule (operator decision, 2026-11-22): a signal ends the wait only when it is observed
*after* the wait armed. A healthy child that already carried `activityState: "needs_attention"`
(e.g. an unread supervisor ask from an earlier turn) must not cut a fresh wait short — that was
exactly the 7 ms `attention required` regression. Provider disappearance, a terminal task, user
input and the window expiry keep their previous semantics.

The unified wait's own loop no longer re-interprets the flag at all; it only forwards it to the
native half. A real supervisor request is detected by `src/supervisor-probe.ts`, which reads
pi-subagents' own request files (`supervisor-channels/<run>-<agent>-<child>/requests/*.json`),
skipping notices without `expectsReply`, expired requests and requests that already have a
reply file — the same lifecycle `requestLifecycle` (native-supervisor-channel.js:446-458)
applies. An event-flag listener was rejected because a request is resolved in the parent tool
(`subagent_supervisor({action:"reply"})`, :613-620) or in pi-subagents' own poll, so an outside
observer could never learn it was answered and would latch "pending" forever.

### The bus notice is not allowed to decide the supervisor class

pi-subagents emits the attention notice **before** it writes the request file. Measured on a live
run (2026-11-22): the `subagent.control` event carries `ts: 1795346701226`, the request JSON has
`createdAt: 1795346701359` — a **133 ms race the notice wins**. Before this fix the wait ended on
that notice, and its closing sentence said `<agent> needs attention in run <id>
(supervisor_request)`: the attention class, i.e. the bus path, not the request directory.

The two changes that fix it:

1. `src/subagent-signals.ts#onControlEvent` drops `reason: "supervisor_request"` instead of
   recording it as an attention signal, so only the probe can decide that class (it is woken by
   the request directory through `externalWake`, so this costs no latency). Attention notices
   from any other reason (`tool_failures`, `active_long_running`, …) are unaffected, and the
   `intercom` channel is a separate class with its own bus event.
2. `WaitOutcome` carries the request it read — `{ kind: "supervisor_request", request }
   (SupervisorRequestDetail: requestId / reason / runId / agent)` — so the verdict prints
   `because a subagent needs a supervisor reply (request <id>, reason <reason>, run <id>, from
   <agent>)`. A request id can only come from a file on disk, which makes the sentence itself
   the evidence that the directory was read.

Both blocking reasons are covered, because upstream blocks on either: `expectsReply =
params.reason !== "progress_update"` (`native-supervisor-channel.js:133`). An
`interview_request` usually carries no `message` at all (`:128`), which is why the probe reads
`reason`/`runId`/`agent` from the file rather than from a notice's text.

Covered by `test/mixed-scope-defaults.test.ts` (opt-in behaviour, plus the empty-background-scope
signal case), `test/supervisor-probe.test.ts` (13 cases, incl. `pendingDetail()` for
`interview_request` and no-request), `test/unified-wait.test.ts` (signal rows, incl. "the
supervisor verdict names the request file it read" and "a supervisor_request notice on the bus
never ends the wait by itself"), `test/intercom-probe.test.ts` (10 cases), and two live scripts:
`scripts/live-attention.mjs` (a healthy run's notice must not cut the wait short before it is
observed) and `scripts/live-signals.mjs` (all three signal classes, `--mode rpc`).

## Live verification of the three signals (2026-11-22)

`node scripts/live-signals.mjs` runs each signal class in a real Pi session in `--mode rpc` — the
only non-interactive mode that reports `hasUI: true`, which is what makes pi-intercom steer an
inbound ask into a *busy* session instead of auto-answering and dismissing it
(`pi-intercom/index.ts:1360-1384`). Each scenario asserts `waited_ms < timeoutMs`, i.e. the wait
ended on the signal and not on its own window:

| Signal | What produced it | Per-class log | Result |
| --- | --- | --- | --- |
| intercom ask | a `pi-intercom` CLI process asking this session, 5 s after the wait began | `evidence/live-signals-intercom-ask.log` | ended after 5.5 s (window 90 s); the ask id in the text matches `intercom/pending-asks/<id>.json` |
| intercom control | sibling `scout` escalated with the `event` channel withheld | `evidence/live-signals-intercom-control.log` | ended after 10.9 s (window 120 s); the run's `events.jsonl` control record has `channels: ["async","intercom"]` and `intercom.to` set, so no bus notice could have produced it |
| attention | sibling `scout` tripping the repeated-failure path (`tool_failures`) | `evidence/live-signals.log` (`attention` scenario) | ended after 13.5 s (window 120 s), text names run + agent + reason |
| contact_supervisor `need_decision` | sibling subagent calling `contact_supervisor({reason:"need_decision"})` | `evidence/live-signals-supervisor-need-decision.log` | ended after 11.4 s (window 120 s); the request id in the text has a real `replies/<id>.json` and an empty `requests/` dir, i.e. the request was outstanding while the wait ran |
| contact_supervisor `interview_request` | sibling subagent calling `contact_supervisor({reason:"interview_request", interview:{…}})` | `evidence/live-signals-supervisor-interview.log` | ended after 11.8 s (window 120 s); verdict line is the supervisor class, not an attention notice |
| idle session | nothing running | `evidence/live-signals.log` (`idle` scenario) | answered after 0.5 s instead of riding out a 20-minute window |
| `any:true`, subagents only | one async `scout` run | `evidence/live-signals.log` (`any-subagent` scenario) | ended after 24.5 s carrying the native answer, no self-inflicted native failure |

Every row asserts `waited_ms < timeoutMs` and that the verdict line is the class it names. One
`LIVE_SIGNALS_SCENARIOS=…` value runs a subset; the full sweep is seven scenarios, all green
(`All live signal checks passed (7 scenario(s)).`).

Logs go to `evidence/` (gitignored, per-machine). The four pre-existing live scripts (`live-e2e`,
`live-mixed`, `live-subagent-only`, `live-attention`) and their `--installed` variants stay green.

### The two intercom paths, and the one that cannot be observed

| Path | Artifact | Where it is read |
| --- | --- | --- |
| `intercom({action:"ask"})` (expectsReply=true) | `intercom/pending-asks/<sha256(scope)>-<messageId>.json` (`pi-intercom/broker/broker.ts:793-805`, `:1367`) | `src/intercom-probe.ts` |
| a subagent's escalated notice routed to this session | `subagent:control-intercom` bus event (`pi-subagents/src/runs/background/async-job-tracker.js:205-216`) | `src/subagent-signals.ts` |
| plain `send` (expectsReply=false) | **none** — `broker.ts:827-831` writes a socket frame only (no ledger record), `pi-intercom/index.ts:1334-1341` delivers it `{deliverAs:"steer"}`, and `agent-session.js:1968-1974` only queues `agent.steer(...)` while a blocking tool holds the turn | not observable during a wait; ends at the next turn boundary via the `message_end` fallback (`extensions/bgwait-bridge.ts:219-232`) |

The `intercom-control` scenario forces the middle row alone: it launches `scout` with
`control: { failedToolAttemptsBeforeAttention: 1, notifyChannels: ["async","intercom"] }`, so
pi-subagents writes a control record whose `channels` excludes `event` and therefore emits
`subagent:control-intercom` only — nothing can shadow the path under test. Live result
(`evidence/live-signals-intercom-control.log`): `waited_ms=10907` of a 120 000 ms window,
`Wait ended after 10s because scout sent an intercom message in run cd6b47a9-…
(tool_failures).`, verdict line not the attention class. The run's own `events.jsonl` record is
`channels: ["async", "intercom"]` with `intercom.to: subagent-chat-…`, which is the independent
check that the withheld `event` channel really was absent.

## How to re-check a live row by hand

Each per-class log is reproducible and every claim in it can be traced to disk, so a reviewer does
not have to trust the log:

1. Take the run id or request id out of the verdict sentence in the log.
2. For an intercom ask: open `<agentDir>/intercom/pending-asks/<askId>.json` — it must exist with
   `target.sessionId` equal to the session that ran the wait.
3. For the control-intercom row: open `<tempRoot>/async-subagent-runs/<runId>/events.jsonl` and
   find the `"subagent.control"` envelope — `channels` must not contain `"event"`.
4. For a supervisor row: open `<tempRoot>/supervisor-channels/<runId>-<agent>-0/` — a
   `requests/<requestId>.json` still present means the request was outstanding when the wait
   ended; a `replies/<requestId>.json` with an empty `requests/` dir means it was answered
   afterwards (upstream moves the file on reply).
5. For the attention row: open `<tempRoot>/async-subagent-runs/<runId>/status.json` and compare
   its `sessionId` with the session that started the wait.

The earlier in-process note is deliberately gone: it was produced by a pre-fix build and by an
in-process injection, which is not the evidence this contract asks for.

## Platform support

| Platform | Status |
| --- | --- |
| Windows 11, Node 24.19.0 | tested here (unit + both live scripts) |
| Linux / macOS | implemented and dependency-free; the wait loop uses only Node built-ins (`setTimeout`, `AbortSignal`) and paths are never parsed out of upstream data. The live scripts use `sleep` instead of `ping -n` on non-Windows hosts. Unit tests are platform-neutral. |

Installing on either platform: `scripts/install-unix.sh` / `scripts/install-windows.cmd`
(or `pi install <dir>`), with `--local` for project scope.

## Known limits (all documented, none silent)

1. **Native `bg_wait({id})` still resolves subagent run ids only.** pi-subagents matches
   `id` against runs (`runsForIds`, `matchesId`) and forces the provider snapshot to empty
   when `id` is set. Background task ids need `bg_wait_unified({ids:[…]})`. The provider
   improves `{}`/`{all:true}` on its own; exact ids are the tool's job.
2. **`all:false` (`any`) with provider work returns on the first completed *item*, not the
   first-submitted one.** That is pi-subagents' own aggregate semantics; `bg_wait_unified({any:true})`
   gives per-task reporting.
3. **A task that disappears without a terminal frame is reported `killed`, not `completed`.**
   Never assume success from absence (`src/bridge.ts#applySnapshot`).
4. **`triggerOnCompletion:true` cannot be changed after launch.** Tasks already running keep
   their policy; the wait result names the duplicate-wake risk and asks the model to treat
   the follow-up turn as the same completion. The notification itself is never suppressed.
5. **Provider registration is process-local.** A session started before installing the
   package needs `/reload` (or a restart) before `bg_wait` sees the provider.
6. **Poll fallback is 1.5 s.** Events wake the wait immediately; a 1.5 s reconcile bounds
   staleness if an event is lost.
7. **Storage-mode sessions.** pi-background-tasks keys its runtime directory by a *sanitized*
   session id, so that directory name is not used as an ownership key anywhere here;
   ownership always comes from the host activation's `sessionId`.
8. **No support for pi-background-tasks' `surviveReload` tasks across a bridge reload.**
   The activation changes, the lease is dropped, and the task is re-adopted by the new
   activation only if it is still stored there. This is pi-background-tasks' own lifecycle,
   not a bridge decision.

## Upgrade notes

The audit in `SOURCE-AUDIT.md` cites file:line in the installed copies. When pi-subagents or
pi-background-tasks is upgraded, diff those locations first:

- `pi-subagents` → `src/api/background-work.js` (registry key, validation, item filter),
  `src/runs/background/subagent-wait.js` (wait semantics, no-work string)
- `pi-background-tasks` → `src/core/extension-api.ts` (frame + channel constants),
  `src/core/host-protocol.ts` (host frames and error codes),
  `src/core/host-api.ts` (activation facts), `src/core/common.ts` (`BgTaskSnapshot`)

If a required surface disappears, the bridge fails closed: `listActiveWork` returns an empty
array and the tool reports why, instead of waiting on unverifiable work.
