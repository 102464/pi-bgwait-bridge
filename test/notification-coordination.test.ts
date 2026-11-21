/**
 * Completion-notification coordination tests (task-7).
 *
 * Upstream facts these assert (pi-background-tasks 2.6.10):
 *  - `bg_run` defaults are `notifyOnCompletion:true`, `triggerOnCompletion:true`
 *    (`src/extension.ts:1032-:1033`).
 *  - On terminal state the registry posts
 *    `sendCompletionNotification(frame, { deliverAs: 'followUp', triggerTurn: task.triggerOnCompletion })`
 *    (`src/core/registry.ts:3955`).
 *  - `triggerOnCompletion` has no effect while `notifyOnCompletion` is false
 *    (`src/core/common.ts:417-:418`).
 *
 * The bridge must never change those flags or drop the notification. It reports the
 * duplicate-wake risk in the wait result and recommends the convention instead.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridge } from "../src/bridge.ts";
import { PROVIDER_NAME } from "../src/constants.ts";
import { analyseCompletionPolicy } from "../src/notification-coordination.ts";
import { createUnifiedToolRunner } from "../src/unified-tool.ts";
import { FakeBackgroundTaskHost, FakeEventBus, tick, until } from "./doubles.ts";

function harness() {
  const bus = new FakeEventBus();
  const host = new FakeBackgroundTaskHost(bus, { sessionId: "sess-A" });
  const bridge = createBridge({
    events: bus,
    identity: () => ({ sessionId: "sess-A", sessionFile: "C:/sessions/A.jsonl" }),
    refreshMs: 500,
    requestTimeoutMs: 400,
  });
  const runner = createUnifiedToolRunner({
    bridge,
    events: bus,
    providers: () => [PROVIDER_NAME],
    subscribe: (listener) => bridge.onChange(listener),
  });
  return { bus, host, bridge, runner };
}

test("task defaults are both true, so a wait reports the follow-up-turn risk", async () => {
  const h = harness();
  // bg_run's documented defaults: notifyOnCompletion true, triggerOnCompletion true.
  h.host.upsert({ id: "bg-default", name: "build", command: "npm run build", status: "running", startTime: 1, isAgent: false });
  await h.bridge.refreshNow();
  await until(() => h.bridge.running().length === 1);
  const pending = h.runner({ all: true, timeoutMs: 2000 }, undefined, undefined, undefined);
  await tick(40);
  h.host.finish("bg-default", "completed", { exitCode: 0 });
  const result = await pending;
  assert.match(result.text, /also start a follow-up turn/i, result.text);
  assert.match(result.text, /triggerOnCompletion:true/i);
  assert.match(result.text, /notifyOnCompletion:true and triggerOnCompletion:false/i, "the convention must be stated");
  assert.match(result.text, /not suppressed/i, "the notification must remain intact");
  h.bridge.dispose();
});

test("a coordinated task (notify true, trigger false) produces no duplicate-wake warning", async () => {
  const h = harness();
  h.host.upsert({
    id: "bg-quiet",
    name: "build",
    command: "npm run build",
    status: "running",
    startTime: 1,
    isAgent: false,
    notifyOnCompletion: true,
    triggerOnCompletion: false,
  });
  await h.bridge.refreshNow();
  await until(() => h.bridge.running().length === 1);
  const pending = h.runner({ all: true, timeoutMs: 2000 }, undefined, undefined, undefined);
  await tick(40);
  h.host.finish("bg-quiet", "completed", { exitCode: 0 });
  const result = await pending;
  assert.doesNotMatch(result.text, /also start a follow-up turn/i);
  assert.match(result.text, /bg-quiet completed/i);
  h.bridge.dispose();
});

test("notifications off is silent, not a risk and not a loss", () => {
  const report = analyseCompletionPolicy([
    { id: "a", notifyOnCompletion: false, triggerOnCompletion: true },
    { id: "b", notifyOnCompletion: false, triggerOnCompletion: false },
  ]);
  assert.equal(report.duplicateWakeRisk.length, 0, "trigger has no effect while notifications are off");
  assert.equal(report.silent.length, 2);
  assert.deepEqual(report.lines, []);
});

test("mixed policies are classified per task, not globally", () => {
  const report = analyseCompletionPolicy([
    { id: "risk", notifyOnCompletion: true, triggerOnCompletion: true },
    { id: "ok", notifyOnCompletion: true, triggerOnCompletion: false },
    { id: "silent", notifyOnCompletion: false, triggerOnCompletion: false },
  ]);
  assert.deepEqual(report.duplicateWakeRisk.map((p) => p.id), ["risk"]);
  assert.deepEqual(report.coordinated.map((p) => p.id), ["ok"]);
  assert.deepEqual(report.silent.map((p) => p.id), ["silent"]);
  assert.equal(report.lines.length, 2, "one line for the risk, one for the convention");
  assert.match(report.lines[0] ?? "", /risk/);
  assert.match(report.lines[1] ?? "", /notifyOnCompletion:true and triggerOnCompletion:false/);
  for (const line of report.lines) assert.doesNotMatch(line, /"ok"|silent/);
});

test("the bridge never rewrites a task's notify/trigger flags", async () => {
  const h = harness();
  h.host.upsert({
    id: "bg-flags",
    name: "build",
    command: "npm run build",
    status: "running",
    startTime: 1,
    isAgent: false,
    notifyOnCompletion: true,
    triggerOnCompletion: true,
  });
  await h.bridge.refreshNow();
  await until(() => h.bridge.running().length === 1);
  // No request to the host may carry a modified flag: the client only sends
  // subscribe/list/detail, and the extension surface is never written to.
  const operations = h.host.requests.map((request) => request.operation);
  assert.deepEqual([...new Set(operations)].sort(), ["list", "subscribe"]);
  const live = h.host.tasks.find((task) => task.id === "bg-flags");
  assert.equal(live?.notifyOnCompletion, true);
  assert.equal(live?.triggerOnCompletion, true, "the task keeps its own policy");
  h.bridge.dispose();
});

test("a terminal frame still reaches pi-background-tasks' own notifier (channel is not consumed)", async () => {
  const h = harness();
  h.host.upsert({ id: "bg-frame", name: "build", command: "npm run build", status: "running", startTime: 1, isAgent: false });
  await h.bridge.refreshNow();
  await until(() => h.bridge.running().length === 1);
  let seen = 0;
  // A second subscriber stands in for pi-background-tasks' notifier path and any other
  // consumer: the bridge must not stop delivery.
  h.bus.on("pi-background-tasks:terminal:v1", () => {
    seen += 1;
  });
  h.host.finish("bg-frame", "completed", { exitCode: 0 });
  await tick(30);
  assert.equal(seen, 1, "other subscribers still receive the terminal frame");
  h.bridge.dispose();
});
