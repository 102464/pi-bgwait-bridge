/**
 * Mixed-scope defaults (`wantsNativeScope`) — the post-reload bug this fixes.
 *
 * Observed failure: right after `/reload`, with only an async subagent running and no
 * background task, `bg_wait_unified({all:true})` answered
 * `No background task of this session is running; nothing to wait for.`
 * That was wrong twice over: there *was* work in flight, and the tool advertises itself as a
 * mixed-scope wait.
 *
 * Rule now:
 *  - a session-wide call (`all`, `any`, or no ids) includes the subagent scope through the
 *    native `bg_wait` (the native tool owns async runs);
 *  - explicit `ids` mean "exactly these background tasks" and do not pull the subagent scope
 *    in, unless `includeNative:true` says so;
 *  - `includeNative:false` always opts out.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridge } from "../src/bridge.ts";
import { PROVIDER_NAME } from "../src/constants.ts";
import { createUnifiedToolRunner, wantsNativeScope } from "../src/unified-tool.ts";
import { FakeBackgroundTaskHost, FakeEventBus, tick, until } from "./doubles.ts";

function harness(nativeAnswer = "Waited 1.0s for 1 async run(s); done. Outcome: 1 complete.") {
  const bus = new FakeEventBus();
  const host = new FakeBackgroundTaskHost(bus, { sessionId: "sess-A" });
  const bridge = createBridge({
    events: bus,
    identity: () => ({ sessionId: "sess-A", sessionFile: "C:/sessions/A.jsonl" }),
    refreshMs: 400,
    requestTimeoutMs: 400,
  });
  const nativeCalls: Record<string, unknown>[] = [];
  const runner = createUnifiedToolRunner({
    bridge,
    events: bus,
    providers: () => [PROVIDER_NAME],
    subscribe: (listener) => bridge.onChange(listener),
    nativeWait: async (params) => {
      nativeCalls.push(params);
      return nativeAnswer;
    },
  });
  return { bus, host, bridge, runner, nativeCalls };
}

const bgTask = (id: string) => ({
  id,
  name: id,
  command: "sleep 30",
  status: "running" as const,
  startTime: Date.now(),
  isAgent: false,
});

test("wantsNativeScope: session-wide calls include the subagent scope", () => {
  assert.equal(wantsNativeScope({ all: true }), true);
  assert.equal(wantsNativeScope({ any: true }), true);
  assert.equal(wantsNativeScope({}), true);
});

test("wantsNativeScope: explicit ids do not pull the subagent scope in", () => {
  assert.equal(wantsNativeScope({ ids: ["bg-1"] }), false);
  assert.equal(wantsNativeScope({ ids: ["bg-1"], all: true }), false, "ids win over all");
});

test("wantsNativeScope: includeNative overrides in both directions", () => {
  assert.equal(wantsNativeScope({ ids: ["bg-1"], includeNative: true }), true);
  assert.equal(wantsNativeScope({ all: true, includeNative: false }), false);
  assert.equal(wantsNativeScope({ any: true, includeNative: false }), false);
});

test("post-reload: no background task, only a subagent → native scope is waited, not denied", async () => {
  const h = harness();
  await h.bridge.refreshNow();
  await until(() => h.bridge.owned());
  const result = await h.runner({ all: true, timeoutMs: 5000 }, undefined, undefined, undefined);
  assert.equal(h.nativeCalls.length, 1, "the subagent scope must be delegated to native bg_wait");
  // Native `stopOnAttention` stays false unless the caller opts in: `true` makes native
  // bg_wait end on ANY needs_attention (subagent-wait.js:638), including an open tool at 240 s.
  assert.deepEqual(h.nativeCalls[0], { all: true, stopOnAttention: false, timeoutMs: 5000 });
  assert.match(result.text, /No background task of this session is running/i);
  assert.match(result.text, /1 complete/i, "the native answer must reach the model");
  assert.doesNotMatch(result.text, /nothing to wait for/i, "a live subagent scope is not 'nothing'");
  assert.equal(result.failed, false);
  h.bridge.dispose();
});

test("post-reload: a native 'No active async runs' answer is passed through, not invented over", async () => {
  const h = harness("No active async runs or registered provider work in this session. Nothing to wait for.");
  await h.bridge.refreshNow();
  await until(() => h.bridge.owned());
  const result = await h.runner({ all: true, timeoutMs: 5000 }, undefined, undefined, undefined);
  assert.equal(h.nativeCalls.length, 1);
  assert.match(result.text, /No active async runs/i, "the native verdict is surfaced verbatim");
  h.bridge.dispose();
});

test("explicit ids with no matching task do not burn the native wait", async () => {
  const h = harness();
  await h.bridge.refreshNow();
  const result = await h.runner({ ids: ["bg-typo"], timeoutMs: 300 }, undefined, undefined, undefined);
  assert.equal(h.nativeCalls.length, 0, "an exact-id wait is about background tasks only");
  assert.match(result.text, /Nothing to wait for/i);
  h.bridge.dispose();
});

test("background tasks still keep the primary scope while the native wait runs alongside", async () => {
  const h = harness("Waited 0ms; 1 of 1 item(s) finished.");
  h.host.upsert(bgTask("bg-mixed"));
  await h.bridge.refreshNow();
  await until(() => h.bridge.running().length === 1);
  const pending = h.runner({ all: true, timeoutMs: 3000 }, undefined, undefined, undefined);
  await tick(40);
  h.host.finish("bg-mixed", "completed", { exitCode: 0 });
  const result = await pending;
  assert.equal(h.nativeCalls.length, 1);
  assert.match(result.text, /bg-mixed completed/i);
  assert.match(result.text, /Native wait:/i, "the nested result is appended, not dropped");
  h.bridge.dispose();
});

test("any mode forwards all:false to the native wait so both halves return on first completion", async () => {
  const h = harness();
  h.host.upsert(bgTask("bg-any"));
  await h.bridge.refreshNow();
  await until(() => h.bridge.running().length === 1);
  const pending = h.runner({ any: true, timeoutMs: 1000 }, undefined, undefined, undefined);
  await tick(30);
  h.host.finish("bg-any", "completed", { exitCode: 0 });
  await pending;
  assert.deepEqual(h.nativeCalls[0], { all: false, stopOnAttention: false, timeoutMs: 1000 });
  h.bridge.dispose();
});

test("stopOnAttention is opt-in only: true reaches the native half, false and unset do not", async () => {
  // Native behaviour (audited): stopOnAttention:true ends a bg_wait on any needs_attention
  // notice (open tool at 240s, 3 consecutive tool failures), not just a supervisor ask
  // (subagent-wait.js:638). Default must therefore be false.
  const unset = harness();
  await unset.bridge.refreshNow();
  await unset.runner({ all: true, timeoutMs: 300 }, undefined, undefined, undefined);
  assert.equal((unset.nativeCalls[0] as { stopOnAttention?: boolean }).stopOnAttention, false, "unset defaults to false");
  unset.bridge.dispose();

  const optIn = harness();
  await optIn.bridge.refreshNow();
  await optIn.runner({ all: true, stopOnAttention: true, timeoutMs: 300 }, undefined, undefined, undefined);
  assert.equal((optIn.nativeCalls[0] as { stopOnAttention?: boolean }).stopOnAttention, true, "explicit true is forwarded");
  optIn.bridge.dispose();
});

test("a native wait failure is reported, never as a completed subagent wait", async () => {
  const h = harness();
  const runner = createUnifiedToolRunner({
    bridge: h.bridge,
    events: h.bus,
    providers: () => [PROVIDER_NAME],
    subscribe: (listener) => h.bridge.onChange(listener),
    nativeWait: async () => {
      throw new Error("tool blocked by policy");
    },
  });
  await h.bridge.refreshNow();
  const result = await runner({ all: true, timeoutMs: 400 }, undefined, undefined, undefined);
  assert.match(result.text, /native bg_wait nested call failed: tool blocked by policy/i);
  h.bridge.dispose();
});

test("includeNative:false keeps the tool background-task-only", async () => {
  const h = harness();
  await h.bridge.refreshNow();
  await until(() => h.bridge.owned());
  const result = await h.runner({ all: true, includeNative: false, timeoutMs: 400 }, undefined, undefined, undefined);
  assert.equal(h.nativeCalls.length, 0);
  assert.match(result.text, /nothing to wait for/i, "an explicit opt-out keeps the old wording");
  h.bridge.dispose();
});
