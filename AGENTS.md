# AGENTS.md — rules this package holds itself to

This file is the short, checkable version of the constraints in the task brief. Every rule
below is enforced by a test or by a source-level assertion; if a change breaks one, the
suite fails.

## Hard boundaries

1. **No modification of other extensions' source.** Nothing here edits
   `pi-subagents`, `pi-background-tasks`, `pi-goal-x` or Pi itself. The package is additive:
   one provider registration, one tool registration, a few event subscriptions.
2. **No monkey patching.** The provider lands through the documented seam —
   `registerBackgroundWorkProvider` from `pi-subagents/background-work`, or the same
   validated shape written into the documented process-local registry
   `Symbol.for("pi-subagents.background-work.v1")`. No module is re-exported, wrapped, or
   replaced, and no global prototype is touched.
3. **No Goal-X state changes.** No `get_goal`/`update_goal`/`create_goal`/`set_goal_tasks`
   calls, no import of `pi-goal-x` internals, and no `strictExecutionContract` opt-in
   (`test/goalx.test.ts` asserts all three over `src/` and `extensions/`).
4. **No message or turn injection.** No `sendMessage`, `sendUserMessage`, `appendEntry`,
   or `triggerTurn` in code. The wait surfaces progress through the tool's own `onUpdate`,
   never by waking the model.
5. **No conversion of background tasks into subagents.** The bridge reads
   pi-background-tasks through its public EventBus only; `bg_wait_unified` never spawns a
   subagent to "wrap" a background command.

## Behavioral invariants

| Invariant | Where |
| --- | --- |
| Ownership comes from the host activation's `sessionId`, never guessed | `src/ownership.ts`, `src/bg-host-client.ts` |
| A foreign activation is refused, not merged | `test/bridge.test.ts`, `test/matrix.test.ts` row 14 |
| Session switch drops the previous scope | `src/bridge.ts#provider.reconcile` |
| A terminal frame is recorded once per `id + status` | `src/bridge.ts#noteTerminal` |
| Terminal truth beats a stale snapshot | `src/bridge.ts#applySnapshot` |
| A task finished before the wait still answers (host `detail`) | `src/bridge.ts#lookup`, `test/unified-wait.test.ts` |
| A failed or killed task is a failure, never success | `src/unified-tool.ts`, `test/matrix.test.ts` row 11 |
| Timeout ends the window, never the work | `src/wait-core.ts`, rows 12 |
| Only typed streaming input aborts a wait | `test/extension.test.ts`, rows 9–10 |
| A supervisor request ends a wait even with `stopOnAttention:false` | rows 8, `src/supervisor-probe.ts` |
| A generic attention notice (open tool 240 s, 3 failed tools) never ends a wait | `test/mixed-scope-defaults.test.ts`, `test/supervisor-probe.test.ts` |
| Provider disappearance fails closed | `src/wait-core.ts#providerLost` |
| Notification flags are never rewritten and frames are never consumed | `src/notification-coordination.ts`, `test/notification-coordination.test.ts` |
| Registration happens at load, so `bg_wait` is declared on the first turn | `extensions/bgwait-bridge.ts`, `test/extension.test.ts` |
| A session-wide unified wait also covers the subagent scope, even after a reload with no background task | `src/unified-tool.ts#wantsNativeScope`, `test/mixed-scope-defaults.test.ts`, `scripts/live-subagent-only.mjs` |
| Reload replaces by name; a stale disposer cannot unregister the replacement | `src/provider-registry.ts`, `test/subagent-path.test.ts` |

## Verification contract

Before claiming anything works:

```bash
npm test                       # 90 tests: mock EventBus + controlled time
node scripts/live-e2e.mjs      # real Pi + real bg task + native bg_wait
node scripts/live-mixed.mjs    # real subagent + real bg task in one native bg_wait
node scripts/live-subagent-only.mjs  # only a subagent: session-wide unified wait must not deny it
node scripts/live-attention.mjs      # a subagent tripping needs_attention must not end the wait
```

`--installed` on either live script drops `-e .` so the run uses the package as installed
in `settings.json`, which is the configuration a user actually gets.

Passing only the subagent path is **not** evidence of pi-background-tasks support; the
live scripts assert on provider item counts and on the disappearance of the
"No active async runs" answer.

## Style

- `src/**` is dependency-free TypeScript with explicit `.ts` import specifiers, so
  `node --test` can run it without a loader. Host-provided imports (`typebox`,
  `@earendil-works/pi-coding-agent`) stay in `extensions/` only — `typebox` is typed as
  `import type` there and the tool schema is plain JSON Schema.
- Comments cite the source location they encode when they describe another package's
  behavior (file:line in the installed version), so an upgrade can be diffed against them.
- No timers outlive a call: every `setTimeout`/`setInterval` is unref'd or cleared in a
  `finally`; a wait never leaves a background continuation behind.
