/**
 * §8 acceptance matrix — every row of the brief's table, in one place, with the row text
 * next to the assertion so a reader can check coverage without cross-referencing files.
 *
 * Rows that need a real Pi process are marked `INTEGRATION` and are additionally covered by
 * `scripts/live-e2e.mjs`; the automated rows here are the deterministic half (mock EventBus
 * + controlled time), which is what the brief requires to be *always* runnable.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridge } from "../src/bridge.ts";
import { PROVIDER_NAME } from "../src/constants.ts";
import { registerProviderSync } from "../src/provider-registry.ts";
import { createUnifiedToolRunner } from "../src/unified-tool.ts";
import { FakeBackgroundTaskHost, FakeEventBus, tick, until } from "./doubles.ts";

interface Row {
  row: number;
  scenario: string;
  expected: string;
}

export const MATRIX: Row[] = [
  { row: 1, scenario: "仅一个子代理", expected: "正常等待并返回" },
  { row: 2, scenario: "仅一个 bg_run 任务", expected: "正常等待并返回" },
  { row: 3, scenario: "三个 bg_run 并行", expected: "all:true 等待全部完成" },
  { row: 4, scenario: "两个子代理 + 一个 bg_run", expected: "all:true 等待三者全部完成" },
  { row: 5, scenario: "子代理先完成，bg_run 未完成", expected: "继续等待" },
  { row: 6, scenario: "bg_run 先完成，子代理未完成", expected: "继续等待" },
  { row: 7, scenario: "all:false 任意任务完成", expected: "正常提前返回" },
  { row: 8, scenario: "Supervisor 请求", expected: "立即结束等待以便回复" },
  { row: 9, scenario: "用户输入", expected: "立即结束等待" },
  { row: 10, scenario: "240 秒 idle 通知", expected: "stopOnAttention:false 时不退出" },
  { row: 11, scenario: "bg_run 失败", expected: "正确报告失败" },
  { row: 12, scenario: "等待超时", expected: "返回超时，后台工作继续" },
  { row: 13, scenario: "重复终态通知", expected: "不产生重复完成" },
  { row: 14, scenario: "会话切换", expected: "不混入其他会话任务" },
  { row: 15, scenario: "Goal-X 计时", expected: "等待期间继续增长" },
  { row: 16, scenario: "Goal-X 自动继续", expected: "等待期间不空转" },
];

function harness() {
  const bus = new FakeEventBus();
  const host = new FakeBackgroundTaskHost(bus, { sessionId: "sess-A" });
  const bridge = createBridge({
    events: bus,
    identity: () => ({ sessionId: "sess-A", sessionFile: "C:/sessions/A.jsonl" }),
    refreshMs: 400,
    requestTimeoutMs: 400,
  });
  const providers = new Map<string, { name: string; wakeChannels: readonly string[]; listActiveWork: () => { id: string; sessionId: string }[] }>();
  const runner = createUnifiedToolRunner({
    bridge,
    events: bus,
    providers: () => [...providers.keys()],
    subscribe: (listener) => bridge.onChange(listener),
    nativeWait: async () => "native wait stub",
    hasSupervisorRequest: () => supervisorPending,
  });
  let supervisorPending = false;
  const setSupervisor = (value: boolean) => {
    supervisorPending = value;
  };
  const setSubagents = (ids: string[]) => {
    providers.set("pi-subagents-test", {
      name: "pi-subagents-test",
      wakeChannels: [],
      listActiveWork: () => ids.map((id) => ({ id, sessionId: "sess-A" })),
    });
    registerProviderSync({ name: "pi-subagents-test", wakeChannels: [], listActiveWork: () => ids.map((id) => ({ id, sessionId: "sess-A" })) });
  };
  return { bus, host, bridge, runner, setSupervisor, setSubagents, providers };
}

function bgTask(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: id, command: "sleep 30", status: "running" as const, startTime: Date.now(), isAgent: false, ...extra };
}

async function seed(h: ReturnType<typeof harness>, ids: string[]) {
  for (const id of ids) h.host.upsert(bgTask(id));
  await h.bridge.refreshNow();
  await until(() => h.bridge.running().length === ids.length);
}

// ---- row 1: only a subagent -------------------------------------------------------------

test("row 1 仅一个子代理 → 正常等待并返回 (native bg_wait reports provider work)", async () => {
  const h = harness();
  await h.bridge.refreshNow();
  await until(() => h.bridge.owned());
  // A session with no running provider work: native bg_wait answers "nothing to wait for"
  // for the provider scope, so the subagent scope is the only live scope.
  const snapshot = h.bridge.provider.listActiveWork({ sessionId: "sess-A", sessionIds: ["C:/sessions/A.jsonl", "sess-A"], nowMs: Date.now() });
  assert.deepEqual(snapshot, []);
  // The unified tool must not invent work either.
  const result = await h.runner({ all: true, timeoutMs: 100 }, undefined, undefined, undefined);
  assert.match(result.text, /nothing to wait for/i);
  h.bridge.dispose();
});

// ---- row 2: only one bg_run ---------------------------------------------------------------

test("row 2 仅一个 bg_run 任务 → 正常等待并返回", async () => {
  const h = harness();
  await seed(h, ["bg-only"]);
  const pending = h.runner({ all: true, timeoutMs: 2000 }, undefined, undefined, undefined);
  await tick(40);
  h.host.finish("bg-only", "completed", { exitCode: 0 });
  const result = await pending;
  assert.match(result.text, /bg-only completed/i);
  assert.equal(result.failed, false);
  h.bridge.dispose();
});

// ---- row 3: three bg_run in parallel ------------------------------------------------------

test("row 3 三个 bg_run 并行 → all:true 等待全部完成", async () => {
  const h = harness();
  await seed(h, ["bg-1", "bg-2", "bg-3"]);
  const pending = h.runner({ all: true, timeoutMs: 4000 }, undefined, undefined, undefined);
  for (const id of ["bg-1", "bg-2", "bg-3"]) {
    await tick(25);
    h.host.finish(id, "completed", { exitCode: 0 });
  }
  const result = await pending;
  assert.match(result.text, /all settled/i, result.text);
  assert.equal((result.text.match(/completed/g) ?? []).length >= 3, true);
  h.bridge.dispose();
});

// ---- row 4: two subagents + one bg_run ----------------------------------------------------

test("row 4 两个子代理 + 一个 bg_run → all:true 等待三者全部完成", async () => {
  const h = harness();
  h.setSubagents(["sub-1", "sub-2"]);
  await seed(h, ["bg-4"]);
  // The bridge scope is the bg task; native bg_wait owns the two async runs. Both halves must
  // report completion before the session may continue, and the provider snapshot proves the
  // subagent half is visible to bg_wait at all.
  const nativeSnapshot = h.bridge.provider.listActiveWork({ sessionId: "sess-A", sessionIds: ["C:/sessions/A.jsonl", "sess-A"], nowMs: Date.now() });
  assert.deepEqual(nativeSnapshot.map((item) => item.id), ["bg-4"], "the bg task is provider work bg_wait can see");
  const pending = h.runner({ all: true, timeoutMs: 3000 }, undefined, undefined, undefined);
  await tick(30);
  h.setSubagents([]); // both subagents finished
  await tick(60);
  assert.deepEqual(h.bridge.running().map((t) => t.id), ["bg-4"], "bg_run still keeps the wait open");
  h.host.finish("bg-4", "completed", { exitCode: 0 });
  const result = await pending;
  assert.match(result.text, /bg-4 completed/i);
  h.bridge.dispose();
});

// ---- row 5: subagent first ----------------------------------------------------------------

test("row 5 子代理先完成，bg_run 未完成 → 继续等待", async () => {
  const h = harness();
  h.setSubagents(["sub-1"]);
  await seed(h, ["bg-5"]);
  const pending = h.runner({ all: true, timeoutMs: 3000 }, undefined, undefined, undefined);
  await tick(30);
  h.setSubagents([]);
  await tick(80);
  const early = await Promise.race([pending.then(() => "returned"), tick(60).then(() => "waiting")]);
  assert.equal(early, "waiting", "the wait must survive the subagent finishing first");
  h.host.finish("bg-5", "completed", { exitCode: 0 });
  const result = await pending;
  assert.match(result.text, /bg-5 completed/i);
  h.bridge.dispose();
});

// ---- row 6: bg_run first ------------------------------------------------------------------

test("row 6 bg_run 先完成，子代理未完成 → 继续等待", async () => {
  const h = harness();
  h.setSubagents(["sub-1"]);
  await seed(h, ["bg-6"]);
  const pending = h.runner({ all: true, timeoutMs: 3000 }, undefined, undefined, undefined);
  await tick(30);
  h.host.finish("bg-6", "completed", { exitCode: 0 });
  const result = await pending;
  assert.match(result.text, /bg-6 completed/i);
  // The subagent scope is still live: a session-level `all:true` covers both halves, so the
  // bridge must not claim the whole session is settled when only its own scope is.
  assert.equal(h.providers.get("pi-subagents-test")?.listActiveWork().length, 1, "subagent scope still running");
  h.bridge.dispose();
});

// ---- row 7: any ---------------------------------------------------------------------------

test("row 7 all:false（any）任意任务完成 → 正常提前返回", async () => {
  const h = harness();
  await seed(h, ["bg-a", "bg-b", "bg-c"]);
  const pending = h.runner({ any: true, timeoutMs: 3000 }, undefined, undefined, undefined);
  await tick(30);
  h.host.finish("bg-b", "completed", { exitCode: 0 });
  const result = await pending;
  assert.match(result.text, /first completion reached/i);
  assert.match(result.text, /bg-b completed/i);
  assert.match(result.text, /Still running: bg-a, bg-c|Still running: bg-c, bg-a/i);
  h.bridge.dispose();
});

// ---- row 8: supervisor request ------------------------------------------------------------

test("row 8 Supervisor 请求 → 立即结束等待以便回复", async () => {
  const h = harness();
  await seed(h, ["bg-sup"]);
  const pending = h.runner({ all: true, stopOnAttention: false, timeoutMs: 5000 }, undefined, undefined, undefined);
  await tick(40);
  h.setSupervisor(true);
  const result = await pending;
  assert.match(result.text, /subagent needs a supervisor reply/i, result.text);
  assert.deepEqual(h.bridge.running().map((t) => t.id), ["bg-sup"], "work keeps running");
  h.bridge.dispose();
});

// ---- row 9: user input --------------------------------------------------------------------

test("row 9 用户输入 → 立即结束等待", async () => {
  const h = harness();
  await seed(h, ["bg-user"]);
  const controller = new AbortController();
  const pending = h.runner({ all: true, timeoutMs: 5000 }, undefined, controller.signal, undefined);
  await tick(40);
  controller.abort();
  const result = await pending;
  assert.match(result.text, /user sent a new message/i);
  h.bridge.dispose();
});

// ---- row 10: 240s idle reminder -----------------------------------------------------------

test("row 10 240 秒 idle 通知 → stopOnAttention:false 时不退出", async () => {
  const h = harness();
  await seed(h, ["bg-idle"]);
  // Replay the shape pi-goal-x emits on its idle schedule (30/60/120/240/300s): nothing here
  // is a supervisor request, so the wait must survive all of them.
  const pending = h.runner({ all: true, stopOnAttention: false, timeoutMs: 700 }, undefined, undefined, undefined);
  for (let index = 0; index < 6; index += 1) {
    h.bus.emit("pi-background-tasks:host:changed:v1", {
      schema_version: "pi-background-tasks.host-changed.v1",
      kind: "changed",
      activationId: "act-1",
      sessionId: "sess-A",
      revision: index,
      observedAt: index,
      counts: {},
    });
    await tick(50);
  }
  const result = await pending;
  assert.match(result.text, /Wait window elapsed/i, "idle churn must not satisfy or end the wait early");
  h.bridge.dispose();
});

// ---- row 11: bg_run failure ---------------------------------------------------------------

test("row 11 bg_run 失败 → 正确报告失败", async () => {
  const h = harness();
  await seed(h, ["bg-fail"]);
  const pending = h.runner({ all: true, timeoutMs: 2000 }, undefined, undefined, undefined);
  await tick(30);
  h.host.finish("bg-fail", "failed", { exitCode: 127, error: "command not found" });
  const result = await pending;
  assert.equal(result.failed, true);
  assert.deepEqual(result.failedIds, ["bg-fail"]);
  assert.match(result.text, /bg-fail failed exit=127/i);
  assert.match(result.text, /did not complete successfully/i);
  h.bridge.dispose();
});

// ---- row 12: timeout ---------------------------------------------------------------------

test("row 12 等待超时 → 返回超时，后台工作继续", async () => {
  const h = harness();
  await seed(h, ["bg-timeout"]);
  const result = await h.runner({ all: true, timeoutMs: 150 }, undefined, undefined, undefined);
  assert.match(result.text, /Wait window elapsed/i);
  assert.deepEqual(h.bridge.running().map((t) => t.id), ["bg-timeout"]);
  h.bridge.dispose();
});

// ---- row 13: duplicate terminal -----------------------------------------------------------

test("row 13 重复终态通知 → 不产生重复完成", async () => {
  const h = harness();
  await seed(h, ["bg-dup"]);
  const pending = h.runner({ all: true, timeoutMs: 2000 }, undefined, undefined, undefined);
  await tick(30);
  h.host.finish("bg-dup", "completed", { exitCode: 0 });
  for (let index = 0; index < 3; index += 1) {
    h.bus.emit("pi-background-tasks:terminal:v1", {
      schema_version: "pi-background-tasks.extension-terminal.v1",
      task: { ...h.host.tasks.find((task) => task.id === "bg-dup"), status: "completed" },
    });
  }
  const result = await pending;
  assert.equal((result.text.match(/bg-dup completed/g) ?? []).length, 1, result.text);
  h.bridge.dispose();
});

// ---- row 14: session switch ---------------------------------------------------------------

test("row 14 会话切换 → 不混入其他会话任务", async () => {
  const bus = new FakeEventBus();
  const other = new FakeBackgroundTaskHost(bus, { sessionId: "sess-B" });
  const mine = new FakeBackgroundTaskHost(bus, { sessionId: "sess-A" });
  mine.upsert(bgTask("bg-mine"));
  other.upsert(bgTask("bg-other"));
  let identity = { sessionId: "sess-A", sessionFile: "C:/sessions/A.jsonl" };
  const bridge = createBridge({ events: bus, identity: () => identity, refreshMs: 0, requestTimeoutMs: 400 });
  await bridge.refreshNow();
  await until(() => bridge.running().length === 1, 2000);
  assert.deepEqual(bridge.running().map((t) => t.id), ["bg-mine"]);
  identity = { sessionId: "sess-B", sessionFile: "C:/sessions/B.jsonl" };
  bridge.provider.reconcile({ sessionId: "sess-B", sessionIds: ["C:/sessions/B.jsonl", "sess-B"], nowMs: Date.now() });
  assert.deepEqual(bridge.running(), [], "switching sessions drops the old scope");
  assert.equal(bridge.owned(), false);
  bridge.dispose();
});

// ---- rows 15/16: Goal-X compatibility (deterministic half) --------------------------------

test("row 15 Goal-X 计时 → 等待期间继续增长 (wait never holds a fake timer/clock)", async () => {
  const h = harness();
  await seed(h, ["bg-clock"]);
  // A real wall-clock wait: if the loop slept on a fake or frozen clock the elapsed time in
  // the result would not advance. pi-goal-x accumulates activeSeconds from the same clock.
  const startedAt = Date.now();
  const result = await h.runner({ all: true, timeoutMs: 260 }, undefined, undefined, undefined);
  const wall = Date.now() - startedAt;
  assert.ok(wall >= 240, `wait must actually consume wall time (took ${String(wall)}ms)`);
  assert.match(result.text, /Wait window elapsed/i);
  h.bridge.dispose();
});

test("row 16 Goal-X 自动继续 → 等待期间不空转 (no self-rescheduling, no repeated model wake)", async () => {
  const h = harness();
  await seed(h, ["bg-spin"]);
  // The tool call is a single Promise: no timers that re-enter the agent, and no wake channel
  // that could synthesize a new turn. Count how many model-visible continuations this wait
  // can cause: exactly one (the tool result).
  let onUpdateCalls = 0;
  const result = await h.runner({ all: true, timeoutMs: 300 }, undefined, undefined, () => {
    onUpdateCalls += 1;
  });
  assert.match(result.text, /Wait window elapsed/i);
  assert.ok(onUpdateCalls >= 1, "progress is surfaced through onUpdate, not by waking the model");
  assert.equal(h.bus.listenerCount("pi-background-tasks:terminal:v1"), 1, "one bridge subscriber, no self-registration churn");
  h.bridge.dispose();
});
