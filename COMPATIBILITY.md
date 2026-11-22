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
| 10 | 240 秒 idle 通知 | `stopOnAttention:false` 时不退出 | `matrix.test.ts` row 10 (replayed change-frame churn), `extension.test.ts` (idle `input` vs streaming `input`) |
| 11 | bg_run 失败 | 正确报告失败 | `matrix.test.ts` row 11, `extension.test.ts` (`isError: true`) |
| 12 | 等待超时 | 返回超时，后台工作继续 | `matrix.test.ts` row 12 |
| 13 | 重复终态通知 | 不产生重复完成 | `matrix.test.ts` row 13, `bridge.test.ts` |
| 14 | 会话切换 | 不混入其他会话任务 | `matrix.test.ts` row 14, `bridge.test.ts`, `extension.test.ts`, `subagent-path.test.ts` |
| 15 | Goal-X 计时 | 等待期间继续增长 | `matrix.test.ts` row 15 (real wall-clock), `goalx.test.ts` (no surviving timers) |
| 16 | Goal-X 自动继续 | 等待期间不空转 | `matrix.test.ts` row 16 (no self-rescheduling, one subscriber), `goalx.test.ts` (no message/turn injection) |

Run records:

- `npm test` → **90 tests, 90 pass, 0 fail** (`evidence/unit-tests.log`)
- `node scripts/live-e2e.mjs` → **10/10 live checks pass** (`evidence/live-e2e.log`)
- `node scripts/live-mixed.mjs` → **9/9 live checks pass** (`evidence/live-mixed.log`)
- `node scripts/live-subagent-only.mjs` → **5/5 live checks pass** (`evidence/live-subagent-only.log`)
  — the post-reload regression: only a subagent running, one `bg_wait_unified({all:true})`
- `node scripts/live-attention.mjs` → **6/6 live checks pass** (`evidence/live-attention.log`)
  — the attention regression: a subagent tripping `needs_attention` must not end the wait
- All four live scripts also pass with `--installed`, i.e. loaded from `settings.json`
  (`evidence/live-e2e-installed.log`, `evidence/live-mixed-installed.log`,
  `evidence/live-subagent-only-installed.log`, `evidence/live-attention-installed.log`)

### Not covered: extension load order

`evidence/goalx-baseline.txt` records a **negative** result and is kept as a warning, not as
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

| Call | Ends on a real supervisor request | Ends on a generic attention notice |
| --- | --- | --- |
| default / `stopOnAttention:false` | yes (unconditional barrier, `subagent-wait.js:634-637`) | no |
| `stopOnAttention:true` | yes | yes (native behaviour, explicit opt-in) |

The unified wait's own loop no longer re-interprets the flag at all; it only forwards it to the
native half. A real supervisor request is detected by `src/supervisor-probe.ts`, which reads
pi-subagents' own request files (`supervisor-channels/<run>-<agent>-<child>/requests/*.json`),
skipping notices without `expectsReply`, expired requests and requests that already have a
reply file — the same lifecycle `requestLifecycle` (native-supervisor-channel.js:446-458)
applies. An event-flag listener was rejected because a request is resolved in the parent tool
(`subagent_supervisor({action:"reply"})`, :613-620) or in pi-subagents' own poll, so an outside
observer could never learn it was answered and would latch "pending" forever.

Covered by `test/mixed-scope-defaults.test.ts` (opt-in behaviour),
`test/supervisor-probe.test.ts` (11 cases) and `scripts/live-attention.mjs` (real Pi: a
subagent trips the failure path, the wait still runs ~44 s and ends `done`).

## In-process verification (this session, after the fix)

`evidence/in-process-live-verification.md` records 12 scenarios executed inside the Pi session
that had the fixed extension loaded — two `bg_run` alone returning
`0 async run(s) and 2 provider item(s)` (no `No active async runs`), three bg tasks plus one
subagent under `{all:true}`, `{any:true}` early return, exact ids, timeout-with-work-continuing,
a generic attention notice not ending the wait, and a real supervisor request ending it in 8 s
while a 40 s bg task kept running.

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
