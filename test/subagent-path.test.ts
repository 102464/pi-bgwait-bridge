/**
 * Subagent-path tests: the provider contract as pi-subagents 0.89.2 consumes it.
 *
 * `bg_wait` calls `snapshotBackgroundWork(sessionIds)` → for every provider
 * `reconcile(...)` then `listActiveWork(...)`, validates each item ({id, sessionId} only),
 * deduplicates by `provider\0sessionId\0id`, and keeps only items whose sessionId is one of
 * the accepted identity forms. These tests exercise that exact pipeline.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridge } from "../src/bridge.ts";
import { SUBAGENTS_PROVIDER_REGISTRY_KEY, PROVIDER_NAME } from "../src/constants.ts";
import { registerProviderSync } from "../src/provider-registry.ts";
import { FakeBackgroundTaskHost, FakeEventBus, until } from "./doubles.ts";

interface Item {
  id: string;
  sessionId: string;
}

/** Reimplementation of pi-subagents' validation + filtering, so provider output is checked as it is consumed. */
function snapshot(providers: { name: string; wakeChannels?: readonly string[]; listActiveWork(context?: { sessionId: string; sessionIds: readonly string[] }): readonly Item[]; reconcile?(context: { sessionId: string; sessionIds: readonly string[]; nowMs: number }): void }[], sessionIds: string[]) {
  const accepted = [...new Set(sessionIds)];
  const first = accepted[0];
  if (first === undefined) throw new Error("snapshot needs a session id");
  const items: { provider: string; id: string; sessionId: string }[] = [];
  const identities = new Set<string>();
  for (const provider of providers) {
    provider.reconcile?.({ sessionId: first, sessionIds: [...accepted], nowMs: Date.now() });
    const active = provider.listActiveWork({ sessionId: first, sessionIds: [...accepted], nowMs: Date.now() });
    assert.ok(Array.isArray(active), "listActiveWork must return an array");
    for (const raw of active) {
      // Unknown fields fail upstream; replicate that strictness.
      const keys = Object.keys(raw);
      for (const key of keys) {
        assert.ok(key === "id" || key === "sessionId", `provider item has unknown field ${key}`);
      }
      assert.equal(typeof raw.id, "string");
      assert.equal(typeof raw.sessionId, "string");
      const identity = `${provider.name}\u0000${raw.sessionId}\u0000${raw.id}`;
      assert.ok(!identities.has(identity), `duplicate item ${raw.id}`);
      identities.add(identity);
      if (accepted.includes(raw.sessionId)) items.push({ provider: provider.name, ...raw });
    }
  }
  return { providers: providers.map((provider) => provider.name), items };
}

function makeBridge(options?: { sessionFile?: string; sessionId?: string }) {
  const bus = new FakeEventBus();
  const sessionId = options?.sessionId ?? "sess-A";
  const sessionFile = options?.sessionFile ?? "C:/sessions/A.jsonl";
  const host = new FakeBackgroundTaskHost(bus, { sessionId });
  const bridge = createBridge({
    events: bus,
    identity: () => ({ sessionId, sessionFile }),
    refreshMs: 1000,
    requestTimeoutMs: 400,
  });
  const dispose = registerProviderSync(bridge.provider);
  return { bus, host, bridge, sessionId, sessionFile, registration: dispose };
}

test("registration uses the documented registry key and is reload-safe", async () => {
  const first = makeBridge();
  const registry = (globalThis as Record<symbol, unknown>)[Symbol.for(SUBAGENTS_PROVIDER_REGISTRY_KEY)];
  assert.ok(registry && typeof registry === "object", "registry must exist at the documented symbol");
  const providers = (registry as { providers: Map<string, unknown> }).providers;
  assert.ok(providers instanceof Map);
  assert.ok(providers.has(PROVIDER_NAME));

  // A second registration with the same name replaces the callback (pi-subagents semantics).
  const second = makeBridge();
  assert.equal(providers.get(PROVIDER_NAME), second.bridge.provider);
  // The old disposer must not remove the replacement.
  first.registration.dispose();
  assert.equal(providers.get(PROVIDER_NAME), second.bridge.provider, "stale disposer must not unregister the replacement");
  // The new disposer removes only itself.
  second.registration.dispose();
  assert.equal(providers.has(PROVIDER_NAME), false);
  first.bridge.dispose();
  second.bridge.dispose();
});

test("an owned running task appears in the snapshot with an accepted sessionId", async () => {
  const { host, bridge, sessionFile, sessionId, registration } = makeBridge();
  host.upsert({ id: "bg-1", name: "build", command: "npm run build", status: "running", startTime: Date.now(), isAgent: false });
  await bridge.refreshNow();
  await until(() => bridge.running().length === 1);
  const result = snapshot([bridge.provider], [sessionFile, sessionId]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.id, "bg-1");
  assert.equal(result.items[0]?.provider, PROVIDER_NAME);
  assert.ok([sessionFile, sessionId].includes(result.items[0]?.sessionId ?? ""));
  registration.dispose();
  bridge.dispose();
});

test("no running work means an empty snapshot, so bg_wait can say nothing to wait for", async () => {
  const { bridge, registration } = makeBridge();
  await bridge.refreshNow();
  await until(() => bridge.owned());
  assert.deepEqual(snapshot([bridge.provider], ["C:/sessions/A.jsonl", "sess-A"]).items, []);
  registration.dispose();
  bridge.dispose();
});

test("a task of another session never appears even when both activations answer", async () => {
  const bus = new FakeEventBus();
  const mine = new FakeBackgroundTaskHost(bus, { sessionId: "sess-A" });
  const theirs = new FakeBackgroundTaskHost(bus, { sessionId: "sess-B" });
  mine.upsert({ id: "bg-mine", name: "mine", command: "sleep", status: "running", startTime: 1, isAgent: false });
  theirs.upsert({ id: "bg-theirs", name: "theirs", command: "sleep", status: "running", startTime: 2, isAgent: false });
  const bridge = createBridge({
    events: bus,
    identity: () => ({ sessionId: "sess-A", sessionFile: "C:/sessions/A.jsonl" }),
    refreshMs: 1000,
    requestTimeoutMs: 400,
  });
  await bridge.refreshNow();
  await until(() => bridge.running().length === 1, 2000);
  const ids = snapshot([bridge.provider], ["C:/sessions/A.jsonl", "sess-A"]).items.map((item) => item.id);
  assert.deepEqual(ids, ["bg-mine"], "only this session's task may be reported");
  bridge.dispose();
});

test("wakeChannels contain exactly the terminal and host-change channels", async () => {
  const { bridge, registration } = makeBridge();
  assert.deepEqual([...bridge.provider.wakeChannels].sort(), [
    "pi-background-tasks:host:changed:v1",
    "pi-background-tasks:terminal:v1",
  ]);
  registration.dispose();
  bridge.dispose();
});

test("the provider never throws into pi-subagents' poll loop", async () => {
  const { bridge, registration } = makeBridge();
  // No activation, no session file: listActiveWork must still be synchronous and total.
  const items = bridge.provider.listActiveWork({ sessionId: "x", sessionIds: ["x"], nowMs: Date.now() });
  assert.deepEqual(items, []);
  assert.equal(typeof bridge.provider.listActiveWork({ sessionId: "x", sessionIds: ["x"], nowMs: 0 }).length, "number");
  registration.dispose();
  bridge.dispose();
});
