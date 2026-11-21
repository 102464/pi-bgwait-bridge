/**
 * Bridge behavior tests: ownership, discovery, terminal dedup, reload, cross-session.
 *
 * These cover the pi-background-tasks half of the matrix. Subagent halves live in
 * `subagent-path.test.ts`; the mixed paths live in `unified-wait.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridge } from "../src/bridge.ts";
import { PROVIDER_NAME } from "../src/constants.ts";
import { FakeBackgroundTaskHost, FakeEventBus, until } from "./doubles.ts";

function setup(options?: { sessionId?: string; sessionFile?: string; offline?: boolean; answerWithSessionId?: string }) {
  const bus = new FakeEventBus();
  const sessionId = options?.sessionId ?? "sess-A";
  const sessionFile = options?.sessionFile ?? `C:\\sessions\\${sessionId}.jsonl`;
  const host = new FakeBackgroundTaskHost(bus, {
    sessionId,
    ...(options?.answerWithSessionId ? { answerWithSessionId: options.answerWithSessionId } : {}),
    ...(options?.offline ? { offline: true } : {}),
  });
  const bridge = createBridge({
    events: bus,
    identity: () => ({ sessionId, sessionFile }),
    refreshMs: 1000,
    requestTimeoutMs: 400,
  });
  return { bus, host, bridge, sessionId, sessionFile };
}

function task(id: string, status: "running" | "completed" | "failed" | "killed" = "running") {
  return {
    id,
    name: `task ${id}`,
    command: "sleep 30",
    status,
    startTime: Date.now(),
    isAgent: false,
  } as const;
}

test("only a host activation naming this session establishes ownership", async () => {
  const { bridge, host, sessionId } = setup();
  host.upsert(task("t1"));
  await bridge.refreshNow();
  await until(() => bridge.owned());
  assert.equal(bridge.owned(), true, "activation of this session must be accepted");
  assert.equal(bridge.activation()?.sessionId, sessionId);
});

test("an activation of another session never enters the wait scope", async () => {
  const { bridge, host } = setup({ answerWithSessionId: "sess-OTHER" });
  host.upsert(task("t1"));
  await bridge.refreshNow();
  await until(() => bridge.lastError() !== undefined);
  assert.equal(bridge.owned(), false, "foreign activation must be refused");
  assert.deepEqual(bridge.running(), [], "no foreign task may be reported as running");
  assert.match(bridge.lastError() ?? "", /not this session/);
});

test("listActiveWork reports running owned tasks under the session id the wait asked for", async () => {
  const { bridge, host, sessionFile, sessionId } = setup();
  host.upsert(task("bg-1"));
  host.upsert(task("bg-2"));
  await bridge.refreshNow();
  await until(() => bridge.running().length === 2);
  const byRuntimeId = bridge.provider.listActiveWork({ sessionId, sessionIds: [sessionId], nowMs: Date.now() });
  assert.deepEqual(byRuntimeId.map((item) => item.id).sort(), ["bg-1", "bg-2"]);
  assert.equal(byRuntimeId[0]?.sessionId, sessionId);

  // pi-subagents keys waits on the session *file* when one exists; the provider must match it.
  const byFile = bridge.provider.listActiveWork({ sessionId: sessionFile, sessionIds: [sessionFile, sessionId], nowMs: Date.now() });
  assert.equal(byFile[0]?.sessionId, sessionFile, "item sessionId must be one of the accepted identities");
});

test("a context naming only foreign identities yields no items", async () => {
  const { bridge, host } = setup();
  host.upsert(task("bg-1"));
  await bridge.refreshNow();
  await until(() => bridge.running().length === 1);
  const foreign = bridge.provider.listActiveWork({ sessionId: "other", sessionIds: ["other"], nowMs: Date.now() });
  assert.deepEqual(foreign, []);
});

test("terminal frames are recorded once and failures keep their status", async () => {
  const { bridge, host } = setup();
  host.upsert(task("ok-task"));
  host.upsert(task("bad-task"));
  await bridge.refreshNow();
  await until(() => bridge.running().length === 2);
  // Two identical terminal frames for the same outcome must not double-record.
  host.finish("ok-task", "completed", { exitCode: 0 });
  host.bus.emit("pi-background-tasks:terminal:v1", {
    schema_version: "pi-background-tasks.extension-terminal.v1",
    task: { ...host.tasks.find((t) => t.id === "ok-task"), status: "completed" },
  });
  host.finish("bad-task", "failed", { exitCode: 2, error: "boom" });
  await until(() => bridge.terminal().length === 2);
  assert.deepEqual(bridge.terminal().map((t) => `${t.id}:${t.status}`).sort(), ["bad-task:failed", "ok-task:completed"]);
  assert.equal(bridge.terminalOf("bad-task")?.exitCode, 2);
  assert.equal(bridge.terminalOf("bad-task")?.error, "boom");
  assert.deepEqual(bridge.running(), [], "finished tasks leave the active set");
});

test("a task finished before the wait started is visible as terminal immediately", async () => {
  const { bridge, host } = setup();
  host.upsert(task("early", "completed"));
  await bridge.refreshNow();
  await until(() => bridge.hasTerminal("early"));
  assert.equal(bridge.hasTerminal("early"), true);
  assert.deepEqual(bridge.running(), []);
});

test("reload keeps ownership when the new activation names the same session", async () => {
  const { bridge, host, sessionId } = setup();
  host.upsert(task("bg-1"));
  await bridge.refreshNow();
  await until(() => bridge.running().length === 1);
  const before = bridge.activation()?.activationId;
  host.simulateReload();
  await until(() => bridge.activation()?.activationId !== before, 4000);
  assert.notEqual(bridge.activation()?.activationId, before);
  assert.equal(bridge.activation()?.sessionId, sessionId);
  assert.equal(bridge.owned(), true);
});

test("a session switch drops ownership instead of leaking the previous session's tasks", async () => {
  let identity = { sessionId: "sess-A", sessionFile: "C:\\sessions\\A.jsonl" };
  const bus = new FakeEventBus();
  const host = new FakeBackgroundTaskHost(bus, { sessionId: "sess-A" });
  host.upsert(task("bg-1"));
  const bridge = createBridge({ events: bus, identity: () => identity, refreshMs: 0 });
  await bridge.refreshNow();
  await until(() => bridge.running().length === 1);
  identity = { sessionId: "sess-B", sessionFile: "C:\\sessions\\B.jsonl" };
  bridge.provider.reconcile({ sessionId: "sess-B", sessionIds: ["C:\\sessions\\B.jsonl", "sess-B"], nowMs: Date.now() });
  assert.equal(bridge.owned(), false, "old ownership must be dropped");
  assert.deepEqual(bridge.running(), []);
  bridge.dispose();
});

test("provider identity: name, wake channels, and disposer behavior", async () => {
  const { bridge, bus } = setup();
  assert.equal(bridge.provider.name, PROVIDER_NAME);
  assert.deepEqual([...bridge.provider.wakeChannels].sort(), [
    "pi-background-tasks:host:changed:v1",
    "pi-background-tasks:terminal:v1",
  ]);
  assert.equal(bus.listenerCount("pi-background-tasks:terminal:v1"), 1);
  bridge.dispose();
  assert.equal(bus.listenerCount("pi-background-tasks:terminal:v1"), 0, "dispose must unsubscribe");
});

test("host offline (load-order race) is retried and recovers", async () => {
  const { bridge, host } = setup({ offline: true });
  await bridge.refreshNow();
  assert.equal(bridge.owned(), false);
  host.live = true;
  host.upsert(task("bg-1"));
  await bridge.refreshNow();
  await until(() => bridge.running().length === 1, 4000);
  assert.equal(bridge.owned(), true);
  assert.equal(bridge.running().length, 1);
});
