/**
 * `bg_wait_unified` matrix tests: the §8 table rows that belong to the native
 * pi-background-tasks side, plus the mixed-scope rows that only this tool can satisfy.
 *
 * The "subagent" side is represented by the same two signals pi-subagents exposes to a
 * wait: async run ids disappearing from the active set, and a pending supervisor request
 * predicate. Both are injected here, so ordering rows ("subagent finishes first", "bg_run
 * finishes first") are deterministic.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridge } from "../src/bridge.ts";
import { PROVIDER_NAME } from "../src/constants.ts";
import { createUnifiedToolRunner } from "../src/unified-tool.ts";
import { FakeBackgroundTaskHost, FakeEventBus, tick, until } from "./doubles.ts";
import type { WaitTargetTask } from "../src/types.ts";

interface HarnessOptions {
  /** Extra ids that behave like async subagents still running. */
  subagentActive?: () => string[];
  supervisor?: () => boolean;
}

function harness(options: HarnessOptions = {}) {
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
    ...(options.supervisor ? { hasSupervisorRequest: options.supervisor } : {}),
    subscribe: (listener) => bridge.onChange(listener),
  });
  return { bus, host, bridge, runner };
}

function task(id: string, overrides: Partial<WaitTargetTask> = {}): WaitTargetTask {
  return {
    id,
    name: `task ${id}`,
    command: "sleep 30",
    status: "running",
    startTime: Date.now(),
    isAgent: false,
    ...overrides,
  } as WaitTargetTask;
}

async function start(h: ReturnType<typeof harness>, ids: string[]): Promise<void> {
  for (const id of ids) h.host.upsert(task(id));
  await h.bridge.refreshNow();
  await until(() => h.bridge.running().length === ids.length);
}

test("one bg_run task: waits and returns its terminal record", async () => {
  const h = harness();
  await start(h, ["bg-1"]);
  const pending = h.runner({ all: true, timeoutMs: 2000 }, undefined, undefined, undefined);
  await tick(50);
  h.host.finish("bg-1", "completed", { exitCode: 0 });
  const result = await pending;
  assert.equal(result.failed, false);
  assert.match(result.text, /bg-1 completed/i);
  h.bridge.dispose();
});

test("three bg_run tasks with all:true wait for every one", async () => {
  const h = harness();
  await start(h, ["bg-1", "bg-2", "bg-3"]);
  const pending = h.runner({ all: true, timeoutMs: 4000 }, undefined, undefined, undefined);
  await tick(30);
  h.host.finish("bg-1", "completed", { exitCode: 0 });
  await tick(30);
  h.host.finish("bg-2", "completed", { exitCode: 0 });
  await tick(30);
  // Two finished, one running: the wait must still be open.
  assert.deepEqual(h.bridge.running().map((entry) => entry.id), ["bg-3"]);
  h.host.finish("bg-3", "completed", { exitCode: 0 });
  const result = await pending;
  assert.match(result.text, /all settled/i, result.text);
  assert.equal((result.text.match(/completed/g) ?? []).length >= 3, true);
  h.bridge.dispose();
});

test("any:true returns on the first completion", async () => {
  const h = harness();
  await start(h, ["bg-1", "bg-2"]);
  const pending = h.runner({ any: true, timeoutMs: 3000 }, undefined, undefined, undefined);
  await tick(30);
  h.host.finish("bg-2", "completed", { exitCode: 0 });
  const result = await pending;
  assert.match(result.text, /first completion reached/i, result.text);
  assert.match(result.text, /bg-2 completed/i);
  assert.match(result.text, /Still running: bg-1/i, "the other task must still be reported as running");
  h.bridge.dispose();
});

test("a failed task is reported as a failure, never as success", async () => {
  const h = harness();
  await start(h, ["bg-bad"]);
  const pending = h.runner({ all: true, timeoutMs: 2000 }, undefined, undefined, undefined);
  await tick(30);
  h.host.finish("bg-bad", "failed", { exitCode: 3, error: "compile error" });
  const result = await pending;
  assert.equal(result.failed, true);
  assert.deepEqual(result.failedIds, ["bg-bad"]);
  assert.match(result.text, /bg-bad failed exit=3/i);
  assert.match(result.text, /did not complete successfully/i);
  h.bridge.dispose();
});

test("a killed task also counts as a failure", async () => {
  const h = harness();
  await start(h, ["bg-killed"]);
  const pending = h.runner({ all: true, timeoutMs: 2000 }, undefined, undefined, undefined);
  await tick(30);
  h.host.finish("bg-killed", "killed", { error: "stopped by user" });
  const result = await pending;
  assert.equal(result.failed, true);
  assert.deepEqual(result.failedIds, ["bg-killed"]);
  h.bridge.dispose();
});

test("timeout ends the wait window and reports the work as still running", async () => {
  const h = harness();
  await start(h, ["bg-long"]);
  const result = await h.runner({ all: true, timeoutMs: 150 }, undefined, undefined, undefined);
  assert.match(result.text, /Wait window elapsed/i);
  assert.match(result.text, /bg-long/i);
  assert.equal(result.failed, false, "a timeout is not a failure of the task");
  assert.deepEqual(h.bridge.running().map((entry) => entry.id), ["bg-long"], "timeout must not kill the task");
  h.bridge.dispose();
});

test("typed user input ends the wait immediately", async () => {
  const h = harness();
  await start(h, ["bg-user"]);
  const controller = new AbortController();
  const pending = h.runner({ all: true, timeoutMs: 5000 }, undefined, controller.signal, undefined);
  await tick(40);
  controller.abort();
  const result = await pending;
  assert.match(result.text, /user sent a new message/i);
  assert.equal(result.failed, false);
  assert.deepEqual(h.bridge.running().map((entry) => entry.id), ["bg-user"], "work keeps running");
  h.bridge.dispose();
});

test("a supervisor request ends the wait even with stopOnAttention:false", async () => {
  let supervisor = false;
  const h = harness({ supervisor: () => supervisor });
  await start(h, ["bg-sup"]);
  const pending = h.runner({ all: true, stopOnAttention: false, timeoutMs: 5000 }, undefined, undefined, undefined);
  await tick(40);
  supervisor = true;
  const result = await pending;
  assert.match(result.text, /subagent needs a supervisor reply/i, result.text);
  h.bridge.dispose();
});

test("ordinary state churn does not end the wait (240s idle reminder analogue)", async () => {
  const h = harness();
  await start(h, ["bg-idle"]);
  // 20 unrelated change frames + 20 terminal frames for ids this session never launched.
  const pending = h.runner({ all: true, stopOnAttention: false, timeoutMs: 600 }, undefined, undefined, undefined);
  for (let index = 0; index < 20; index += 1) {
    h.bus.emit("pi-background-tasks:host:changed:v1", {
      schema_version: "pi-background-tasks.host-changed.v1",
      kind: "changed",
      activationId: "act-1",
      sessionId: "sess-A",
      revision: index,
      observedAt: index,
      counts: {},
    });
    h.bus.emit("pi-background-tasks:terminal:v1", {
      schema_version: "pi-background-tasks.extension-terminal.v1",
      task: task(`noise-${String(index)}`, { status: "completed" }),
    });
    await tick(5);
  }
  const result = await pending;
  assert.match(result.text, /Wait window elapsed/i, "unrelated events must not satisfy the wait");
  assert.equal(h.bridge.hasTerminal("noise-0"), false, "unowned terminal frames are never adopted");
  h.bridge.dispose();
});

test("duplicate terminal frames do not double-report a completion", async () => {
  const h = harness();
  await start(h, ["bg-dup"]);
  const pending = h.runner({ all: true, timeoutMs: 2000 }, undefined, undefined, undefined);
  await tick(30);
  h.host.finish("bg-dup", "completed", { exitCode: 0 });
  h.bus.emit("pi-background-tasks:terminal:v1", {
    schema_version: "pi-background-tasks.extension-terminal.v1",
    task: { ...h.host.tasks.find((entry) => entry.id === "bg-dup"), status: "completed" },
  });
  const result = await pending;
  assert.equal((result.text.match(/bg-dup completed/g) ?? []).length, 1, result.text);
  h.bridge.dispose();
});

test("exact ids: waits only for the named tasks, ignoring others of the session", async () => {
  const h = harness();
  await start(h, ["bg-a", "bg-b", "bg-c"]);
  const pending = h.runner({ ids: ["bg-a", "bg-c"], all: true, timeoutMs: 2000 }, undefined, undefined, undefined);
  await tick(30);
  h.host.finish("bg-b", "completed", { exitCode: 0 });
  await tick(60);
  // bg-b was never part of the selection, so bg-a/bg-c must still hold the wait open.
  assert.deepEqual(h.bridge.running().map((entry) => entry.id).sort(), ["bg-a", "bg-c"]);
  h.host.finish("bg-a", "completed", { exitCode: 0 });
  h.host.finish("bg-c", "completed", { exitCode: 0 });
  const result = await pending;
  assert.match(result.text, /bg-a completed/i);
  assert.match(result.text, /bg-c completed/i);
  assert.doesNotMatch(result.text, /Results:[\s\S]*bg-b completed/, "unselected ids must not appear as results");
  h.bridge.dispose();
});

test("a terminal id passed to ids answers immediately", async () => {
  const h = harness();
  h.host.upsert(task("bg-done", { status: "completed", exitCode: 0, endTime: Date.now() }));
  await h.bridge.refreshNow();
  await until(() => h.bridge.hasTerminal("bg-done"));
  const result = await h.runner({ ids: ["bg-done"], timeoutMs: 5000 }, undefined, undefined, undefined);
  assert.match(result.text, /bg-done completed/i);
  h.bridge.dispose();
});

test("an unknown id is reported, not waited on forever", async () => {
  const h = harness();
  await start(h, ["bg-real"]);
  const result = await h.runner({ ids: ["bg-typo"], timeoutMs: 200 }, undefined, undefined, undefined);
  assert.match(result.text, /nothing to wait for/i, result.text);
  h.bridge.dispose();
});

test("no running work reports the no-work line instead of hanging", async () => {
  const h = harness();
  await h.bridge.refreshNow();
  await until(() => h.bridge.owned());
  const result = await h.runner({ all: true, timeoutMs: 5000 }, undefined, undefined, undefined);
  assert.match(result.text, /nothing to wait for/i);
  assert.equal(result.failed, false);
  h.bridge.dispose();
});

test("mixed scope: subagent finishing first keeps the wait open for the background task", async () => {
  let subagentIds = ["sub-1"];
  const h = harness();
  const provider = {
    name: "pi-subagents-test",
    wakeChannels: [] as readonly string[],
    listActiveWork: () => subagentIds.map((id) => ({ id, sessionId: "sess-A" })),
  };
  // Register the subagent stand-in the same way bg_wait sees provider work.
  const { registerProviderSync } = await import("../src/provider-registry.ts");
  registerProviderSync(provider);
  await start(h, ["bg-mix"]);
  const pending = h.runner({ all: true, timeoutMs: 5000 }, undefined, undefined, undefined);
  await tick(40);
  const snapshotWhileSubagentRunning = provider.listActiveWork();
  assert.equal(snapshotWhileSubagentRunning.length, 1);
  subagentIds = []; // the subagent finished
  await tick(80);
  assert.deepEqual(h.bridge.running().map((entry) => entry.id), ["bg-mix"], "bg task must still be waited for");
  h.host.finish("bg-mix", "completed", { exitCode: 0 });
  const result = await pending;
  assert.match(result.text, /bg-mix completed/i);
  h.bridge.dispose();
});

test("mixed scope: background task finishing first keeps the subagent scope open", async () => {
  let subagentIds = ["sub-1"];
  const h = harness();
  const provider = {
    name: "pi-subagents-test",
    wakeChannels: [] as readonly string[],
    listActiveWork: () => subagentIds.map((id) => ({ id, sessionId: "sess-A" })),
  };
  const { registerProviderSync } = await import("../src/provider-registry.ts");
  registerProviderSync(provider);
  await start(h, ["bg-first"]);
  // Start the wait while the bg task is still running, then let the bg task finish first.
  const pending = h.runner({ all: true, timeoutMs: 3000 }, undefined, undefined, undefined);
  await tick(40);
  assert.equal(subagentIds.length, 1, "subagent scope is untouched by this wait");
  h.host.finish("bg-first", "completed", { exitCode: 0 });
  const result = await pending;
  assert.match(result.text, /bg-first completed/i);
  assert.equal(subagentIds.length, 1, "subagent scope untouched");
  h.bridge.dispose();
});

test("onTick progress is emitted while waiting", async () => {
  const h = harness();
  await start(h, ["bg-tick"]);
  const seen: string[] = [];
  const pending = h.runner({ all: true, timeoutMs: 300 }, undefined, undefined, (update) => seen.push(update.text));
  const result = await pending;
  assert.ok(seen.length > 0, "progress updates must reach onUpdate");
  assert.match(seen[0] ?? "", /Waiting on 1 background task/i);
  assert.match(result.text, /Wait window elapsed/i);
  h.bridge.dispose();
});
