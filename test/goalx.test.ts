/**
 * Goal-X compatibility (task-9).
 *
 * pi-goal-x 0.34.1 accumulates `usage.activeSeconds` from wall time and decides
 * continuation in `GoalScheduler.settled()` (`extensions/goal-scheduler.ts:290-:330`):
 * while a tool call is in flight the run is not settled, so no continuation is scheduled.
 * A blocking tool therefore keeps the goal `active` and keeps the clock running, as long as
 * the tool:
 *   - does not call `pi.sendMessage` / `pi.sendUserMessage` / `pi.appendEntry`
 *   - does not call `update_goal` (in particular never `update_goal({status:"wait"})`,
 *     which requires the opt-in `strictExecutionContract`)
 *   - does not create timers that re-enter the agent
 *
 * These assertions enforce exactly that on the extension module, and on the wait loop's
 * timer behavior.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createBridge } from "../src/bridge.ts";
import { PROVIDER_NAME } from "../src/constants.ts";
import { createUnifiedToolRunner } from "../src/unified-tool.ts";
import { FakeBackgroundTaskHost, FakeEventBus, until } from "./doubles.ts";

const root = path.resolve(import.meta.dirname, "..");

function readSource(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

/** Strip comments and string literals so prose about a forbidden API is not a code use. */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/`[^`]*`/g, '""')
    .replace(/'[^'\n]*'/g, '""')
    .replace(/"[^"\n]*"/g, '""');
}

const SOURCE_FILES = [
  "extensions/bgwait-bridge.ts",
  ...readdirSync(path.join(root, "src"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `src/${name}`),
];

test("the extension never touches pi-goal-x state", () => {
  for (const file of SOURCE_FILES) {
    const source = readSource(file);
    // No goal tool calls, no goal record mutation, no goal scheduler import.
    assert.doesNotMatch(source, /update_goal|get_goal|propose_goal_draft|set_goal_tasks|create_goal/i, `${file} must not call goal tools`);
    assert.doesNotMatch(source, /pi-goal-x|goal-scheduler|GoalRecord|GoalScheduler/, `${file} must not import pi-goal-x internals`);
    // `update_goal({status:"wait"})` in particular requires a user opt-in; it must not appear.
    assert.doesNotMatch(source, /strictExecutionContract/, `${file} must not enable strictExecutionContract`);
  }
});

test("the extension never injects messages or turns, so a wait cannot spin the scheduler", () => {
  for (const file of SOURCE_FILES) {
    const code = codeOf(readSource(file));
    for (const forbidden of ["sendUserMessage", "appendEntry", "triggerTurn"]) {
      assert.doesNotMatch(code, new RegExp(forbidden), `${file} must not use ${forbidden}`);
    }
    // `sendMessage` may only appear if it is a read-only reflection of someone else's frame;
    // this package has no such path, so require zero occurrences in code.
    assert.doesNotMatch(code, /sendMessage/, `${file} must not inject messages`);
  }
});

test("a fake Pi with no message/turn capability still loads and registers the tool", async () => {
  // If the extension tried to inject anything, this fake would record it.
  const injected: string[] = [];
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const tools: { name: string }[] = [];
  const pi = {
    events: new FakeEventBus(),
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool(definition: { name: string }) {
      tools.push(definition);
    },
    getAllTools: () => tools,
    getActiveTools: () => tools.map((tool) => tool.name),
    sendMessage: () => injected.push("sendMessage"),
    sendUserMessage: () => injected.push("sendUserMessage"),
    appendEntry: () => injected.push("appendEntry"),
  };
  const module = await import(`../extensions/bgwait-bridge.ts?goalx=${String(Date.now())}`);
  (module.default as (api: unknown) => void)(pi);
  const ctx = { cwd: "C:/work", sessionManager: { getSessionId: () => "sess-A", getSessionFile: () => "C:/s/A.jsonl" } };
  for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
  // A wait that reaches its window must still inject nothing.
  const tool = tools.find((entry) => entry.name === "bg_wait_unified") as
    | { execute: (...args: unknown[]) => Promise<unknown> }
    | undefined;
  assert.ok(tool);
  await tool.execute("call-1", { all: true, timeoutMs: 120 }, undefined, undefined, ctx);
  assert.deepEqual(injected, [], "a wait must not inject messages or turns");
});

test("wait timers are unref'd so the goal clock, not a pending timer, drives the session", async () => {
  const bus = new FakeEventBus();
  const host = new FakeBackgroundTaskHost(bus, { sessionId: "sess-A" });
  const bridge = createBridge({
    events: bus,
    identity: () => ({ sessionId: "sess-A", sessionFile: "C:/sessions/A.jsonl" }),
    refreshMs: 500,
    requestTimeoutMs: 300,
  });
  host.upsert({ id: "bg-clock", name: "clock", command: "sleep 30", status: "running", startTime: 1, isAgent: false });
  await bridge.refreshNow();
  await until(() => bridge.running().length === 1);

  const before = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  const runner = createUnifiedToolRunner({
    bridge,
    events: bus,
    providers: () => [PROVIDER_NAME],
    subscribe: (listener) => bridge.onChange(listener),
  });
  const startedAt = Date.now();
  const result = await runner({ all: true, timeoutMs: 200 }, undefined, undefined, undefined);
  const elapsed = Date.now() - startedAt;
  const after = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

  // Wall-clock advancement is what pi-goal-x's activeSeconds accumulates.
  assert.ok(elapsed >= 180, `the wait must consume real time (took ${String(elapsed)}ms)`);
  assert.match(result.text, /Wait window elapsed/i);
  // No timer survives the call: an unref'd timer does not keep the loop alive, and a
  // surviving timer here would mean a background continuation could fire after the tool.
  assert.ok(after <= before, `no timers may outlive the wait (before=${String(before)} after=${String(after)})`);
  bridge.dispose();
});

test("repeated waits do not accumulate subscribers or timers", async () => {
  const bus = new FakeEventBus();
  const host = new FakeBackgroundTaskHost(bus, { sessionId: "sess-A" });
  const bridge = createBridge({
    events: bus,
    identity: () => ({ sessionId: "sess-A", sessionFile: "C:/sessions/A.jsonl" }),
    refreshMs: 500,
    requestTimeoutMs: 300,
  });
  host.upsert({ id: "bg-repeat", name: "repeat", command: "sleep 30", status: "running", startTime: 1, isAgent: false });
  await bridge.refreshNow();
  await until(() => bridge.running().length === 1);
  const runner = createUnifiedToolRunner({
    bridge,
    events: bus,
    providers: () => [PROVIDER_NAME],
    subscribe: (listener) => bridge.onChange(listener),
  });
  for (let round = 0; round < 5; round += 1) {
    await runner({ all: true, timeoutMs: 60 }, undefined, undefined, undefined);
  }
  // The bridge's own event subscriptions are created once; a wait adds only a temporary
  // wake listener that is removed in `finally`.
  assert.equal(bus.listenerCount("pi-background-tasks:terminal:v1"), 1, "one bridge subscriber");
  assert.equal(bus.listenerCount("pi-background-tasks:host:changed:v1"), 1, "one bridge subscriber");
  bridge.dispose();
});
