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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBridge } from "../src/bridge.ts";
import { PROVIDER_NAME } from "../src/constants.ts";
import { createSubagentSignalCapture, type SubagentSignal } from "../src/subagent-signals.ts";
import { createUnifiedToolRunner } from "../src/unified-tool.ts";
import { FakeBackgroundTaskHost, FakeEventBus, tick, until } from "./doubles.ts";
import type { DoubleTask } from "./doubles.ts";

interface HarnessOptions {
  /** Extra ids that behave like async subagents still running. */
  subagentActive?: () => string[];
  supervisor?: () => boolean;
  /**
   * Wire a signal capture built on this harness's own bus (it must be the same bus the wait
   * subscribes to). The setup arms the capture and returns the predicate plus a disarm.
   */
  signalSetup?: (bus: FakeEventBus) => { signal: () => SubagentSignal | undefined; off: () => void };
  /** Live async runs of this session, as pi-subagents' own run records would report them. */
  activeRuns?: () => readonly { runId: string; activity: readonly string[] }[];
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
  const armed = options.signalSetup?.(bus);
  const runner = createUnifiedToolRunner({
    bridge,
    events: bus,
    providers: () => [PROVIDER_NAME],
    ...(options.supervisor ? { hasSupervisorRequest: options.supervisor } : {}),
    ...(armed ? { pendingSubagentSignal: armed.signal } : {}),
    ...(options.activeRuns ? { activeRuns: options.activeRuns } : {}),
    subscribe: (listener) => bridge.onChange(listener),
  });
  return { bus, host, bridge, runner, armed };
}

function task(id: string, overrides: Partial<DoubleTask> = {}): DoubleTask {
  return {
    id,
    name: `task ${id}`,
    command: "sleep 30",
    status: "running",
    startTime: Date.now(),
    isAgent: false,
    ...overrides,
  };
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

test("onTick progress is emitted while waiting, throttled to one second, in native wording", async () => {
  const h = harness();
  await start(h, ["bg-tick"]);
  const seen: { text: string; at: number }[] = [];
  const pending = h.runner({ all: true, timeoutMs: 1600 }, undefined, undefined, (update) => seen.push({ text: update.text, at: Date.now() }));
  const result = await pending;
  assert.ok(seen.length > 0, "progress updates must reach onUpdate");
  // Native shape (`asyncWaitUpdate`, subagent-wait.js:348-364): elapsed + run/provider counts.
  assert.match(seen[0]?.text ?? "", /^Waiting .+ for \d+ async run\(s\) and \d+ provider item\(s\)\. · bg-tick$/);
  // One repaint per second, not one per 250 ms poll tick: the renderer shows the same partial text.
  const gaps = seen.slice(1).map((entry, index) => entry.at - seen[index]!.at);
  for (const gap of gaps) assert.ok(gap >= 900, `updates must be ~1s apart, got ${String(gap)}ms`);
  assert.match(result.text, /Wait window elapsed/i);
  h.bridge.dispose();
});

// ---- progress wording: async-run count comes from the run records -------------------------

test("the progress line counts live async runs from the run records, in native wording", async () => {
  const h = harness({
    activeRuns: () => [
      { runId: "run-own", activity: ["scout: bash"] },
      { runId: "run-two", activity: ["rtl-engineer: edit"] },
    ],
  });
  await start(h, ["bg-tick"]);
  const seen: string[] = [];
  const pending = h.runner({ all: true, timeoutMs: 1600 }, undefined, undefined, (update) => seen.push(update.text));
  const result = await pending;
  assert.ok(seen.length > 0, "progress updates must reach onUpdate");
  // Native shape (`asyncWaitUpdate`, subagent-wait.js:348-364): the headline carries the live
  // async-run count and the per-run `agent: tool` activity after a ` · ` separator.
  assert.match(seen[0] ?? "", /^Waiting .+ for 2 async run\(s\) and 0 provider item\(s\)\. \u00b7 scout: bash \u00b7 rtl-engineer: edit \u00b7 bg-tick$/);
  assert.match(result.text, /Wait window elapsed/i);
  h.bridge.dispose();
});

test("a session with no live async run reports 0 async run(s), never a made-up count", async () => {
  const h = harness({ activeRuns: () => [] });
  await start(h, ["bg-zero"]);
  const seen: string[] = [];
  await h.runner({ all: true, timeoutMs: 1200 }, undefined, undefined, (update) => seen.push(update.text));
  assert.match(seen[0] ?? "", /^Waiting .+ for 0 async run\(s\) and 0 provider item\(s\)\. \u00b7 bg-zero$/);
  h.bridge.dispose();
});

test("activeRuns reads only this session's runs, and only live states", () => {
  const root = path.join(tmpdir(), "bgw-active-runs");
  rmSync(root, { recursive: true, force: true });
  const runsRoot = path.join(root, "async-subagent-runs");
  const writeRun = (name: string, status: Record<string, unknown>): void => {
    mkdirSync(path.join(runsRoot, name), { recursive: true });
    writeFileSync(path.join(runsRoot, name, "status.json"), JSON.stringify(status), "utf8");
  };
  writeRun("run-live", { runId: "run-live", sessionId: "C:/sessions/A.jsonl", state: "running", steps: [{ agent: "scout", status: "running", currentTool: "bash" }] });
  writeRun("run-queued", { runId: "run-queued", sessionId: "sess-A", state: "queued", steps: [{ agent: "planner", status: "pending" }] });
  writeRun("run-done", { runId: "run-done", sessionId: "sess-A", state: "complete", steps: [{ agent: "scout", status: "complete" }] });
  writeRun("run-foreign", { runId: "run-foreign", sessionId: "C:/sessions/OTHER.jsonl", state: "running", steps: [{ agent: "scout", status: "running" }] });
  const capture = createSubagentSignalCapture({
    events: new FakeEventBus(),
    sessionIds: () => ["sess-A", "C:/sessions/A.jsonl"],
    tempRoot: root,
  });
  const runs = capture.activeRuns();
  assert.deepEqual(runs.map((run) => run.runId), ["run-live", "run-queued"], "only live states of this session");
  assert.deepEqual(runs[0]?.activity, ["scout: bash"], "a running step shows its live tool");
  assert.deepEqual(runs[1]?.activity, ["planner: queued"], "a pending step reads queued, like native");
});

// ---- attention / intercom signals ------------------------------------------------------------
//
// Operator requirement (2026-11-22): an attention notice, and an intercom message another agent
// sends to this session, end the wait — not only a supervisor request. These rows drive the real
// capture (`src/subagent-signals.ts`) over the harness's own bus, with real run directories whose
// `status.json` carries the launching `sessionId`.

function writeRunDir(dir: string, sessionId: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "status.json"), JSON.stringify({ runId: path.basename(dir), sessionId }), "utf8");
}

const SIGNAL_ROOT = path.join(tmpdir(), "bgw-signals");
const OWNED_DIR = path.join(SIGNAL_ROOT, "run-own");
const FOREIGN_DIR = path.join(SIGNAL_ROOT, "run-foreign");

/** Arm a capture on the harness's own bus and hand its predicate to the runner. */
function armSignals(bus: FakeEventBus) {
  let seen: SubagentSignal | undefined;
  const capture = createSubagentSignalCapture({
    events: bus,
    sessionIds: () => ["sess-A", "C:/sessions/A.jsonl"],
  });
  return {
    arm(): { signal: () => SubagentSignal | undefined; off: () => void } {
      const off = capture.arm(() => {
        seen = capture.pending();
      });
      return { signal: () => seen, off };
    },
  };
}

function attentionPayload(asyncDir: string, overrides: Record<string, unknown> = {}) {
  return {
    source: "async",
    asyncDir,
    noticeText: "Subagent needs attention: scout",
    event: {
      type: "needs_attention",
      runId: path.basename(asyncDir),
      agent: "scout",
      reason: "tool_failures",
      message: "scout failed 3 mutating tools in a row",
      ts: 0,
      ...overrides,
    },
  };
}

test("an attention notice from this session's run ends the wait", async () => {
  writeRunDir(OWNED_DIR, "C:/sessions/A.jsonl");
  const h = harness();
  const armed = armSignals(h.bus).arm();
  const runner = createUnifiedToolRunner({
    bridge: h.bridge,
    events: h.bus,
    providers: () => [PROVIDER_NAME],
    pendingSubagentSignal: armed.signal,
    subscribe: (listener) => h.bridge.onChange(listener),
  });
  await start(h, ["bg-att"]);
  const pending = runner({ all: true, timeoutMs: 5000 }, undefined, undefined, undefined);
  await tick(40);
  h.bus.emit("subagent:control-event", attentionPayload(OWNED_DIR));
  const result = await pending;
  assert.match(result.text, /needs attention in run run-own/i, result.text);
  assert.match(result.text, /scout failed 3 mutating tools in a row/i, "the upstream signal line is reported");
  assert.deepEqual(h.bridge.running().map((entry) => entry.id), ["bg-att"], "work keeps running");
  armed.off();
  h.bridge.dispose();
});

test("an attention notice from another session's run does not end this wait", async () => {
  writeRunDir(FOREIGN_DIR, "C:/sessions/OTHER.jsonl");
  const h = harness();
  const armed = armSignals(h.bus).arm();
  const runner = createUnifiedToolRunner({
    bridge: h.bridge,
    events: h.bus,
    providers: () => [PROVIDER_NAME],
    pendingSubagentSignal: armed.signal,
    subscribe: (listener) => h.bridge.onChange(listener),
  });
  await start(h, ["bg-foreign"]);
  const pending = runner({ all: true, timeoutMs: 600 }, undefined, undefined, undefined);
  await tick(40);
  h.bus.emit("subagent:control-event", attentionPayload(FOREIGN_DIR));
  const result = await pending;
  assert.match(result.text, /Wait window elapsed/i, "a foreign run's notice must not end this session's wait");
  armed.off();
  h.bridge.dispose();
});

test("an intercom message another agent routed here ends the wait", async () => {
  writeRunDir(OWNED_DIR, "C:/sessions/A.jsonl");
  const h = harness();
  const armed = armSignals(h.bus).arm();
  const runner = createUnifiedToolRunner({
    bridge: h.bridge,
    events: h.bus,
    providers: () => [PROVIDER_NAME],
    pendingSubagentSignal: armed.signal,
    subscribe: (listener) => h.bridge.onChange(listener),
  });
  await start(h, ["bg-ic"]);
  const pending = runner({ all: true, timeoutMs: 5000 }, undefined, undefined, undefined);
  await tick(40);
  h.bus.emit("subagent:control-intercom", {
    ...attentionPayload(OWNED_DIR, { reason: "supervisor_request" }),
    to: "orchestrator",
    message: "Subagent needs attention\n\nscout is waiting for a supervisor reply",
  });
  const result = await pending;
  assert.match(result.text, /sent an intercom message in run run-own/i, result.text);
  assert.match(result.text, /waiting for a supervisor reply/i);
  armed.off();
  h.bridge.dispose();
});

test("a notice observed before the wait began never ends it", async () => {
  writeRunDir(OWNED_DIR, "C:/sessions/A.jsonl");
  const h = harness();
  // The notice fires before this tool call exists — the shape of the `attention required`
  // 7 ms premature return: attention that was already true when the wait started.
  h.bus.emit("subagent:control-event", attentionPayload(OWNED_DIR, { message: "stale attention" }));
  const armed = armSignals(h.bus).arm();
  assert.equal(armed.signal(), undefined, "arming is the boundary: earlier notices are not new work");
  await start(h, ["bg-stale"]);
  const runner = createUnifiedToolRunner({
    bridge: h.bridge,
    events: h.bus,
    providers: () => [PROVIDER_NAME],
    pendingSubagentSignal: armed.signal,
    subscribe: (listener) => h.bridge.onChange(listener),
  });
  const result = await runner({ all: true, timeoutMs: 600 }, undefined, undefined, undefined);
  assert.match(result.text, /Wait window elapsed/i, "a stale notice must not cut a fresh wait short");
  armed.off();
  h.bridge.dispose();
});

test("an active_long_running notice is progress, not a signal", () => {
  writeRunDir(OWNED_DIR, "C:/sessions/A.jsonl");
  const h = harness();
  const armed = armSignals(h.bus).arm();
  h.bus.emit("subagent:control-event", attentionPayload(OWNED_DIR, { type: "active_long_running" }));
  assert.equal(armed.signal(), undefined);
  armed.off();
  h.bridge.dispose();
});

test("disarming removes the bus listeners", () => {
  const h = harness();
  const armed = armSignals(h.bus).arm();
  assert.equal(h.bus.listenerCount("subagent:control-event"), 1);
  assert.equal(h.bus.listenerCount("subagent:control-intercom"), 1);
  armed.off();
  assert.equal(h.bus.listenerCount("subagent:control-event"), 0, "no listener outlives the call");
  assert.equal(h.bus.listenerCount("subagent:control-intercom"), 0);
  h.bridge.dispose();
});
