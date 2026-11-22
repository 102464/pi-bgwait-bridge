/**
 * Extension-factory tests: activation wiring, reload, session isolation, dispose.
 *
 * The Pi `ExtensionAPI` is faked with the documented registration surface
 * (`docs/extensions.md` §pi.on / §pi.registerTool / §pi.events), and the session manager is
 * faked with `getSessionId()` / `getSessionFile()`. Everything else is the real bridge.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeBackgroundTaskHost, FakeEventBus, tick, until } from "./doubles.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

interface FakePi {
  events: FakeEventBus;
  handlers: Map<string, ((event: unknown, ctx: unknown) => unknown)[]>;
  tools: { name: string; parameters: unknown; execute: (...args: unknown[]) => Promise<unknown> }[];
  on(name: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  registerTool(definition: { name: string; parameters: unknown; execute: (...args: unknown[]) => Promise<unknown> }): void;
  getAllTools(): { name: string }[];
  getActiveTools(): string[];
  emitTo(name: string, event: unknown, ctx: unknown): Promise<unknown>;
}

function fakePi(): FakePi {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const tools: FakePi["tools"] = [];
  const api: FakePi = {
    events: new FakeEventBus(),
    handlers,
    tools,
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool(definition) {
      tools.push(definition);
    },
    getAllTools: () => tools.map((tool) => ({ name: tool.name })),
    getActiveTools: () => tools.map((tool) => tool.name),
    async emitTo(name, event, ctx) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
  return api;
}

function fakeContext(
  sessionId: string,
  sessionFile: string | undefined,
  cwd = "C:/work",
  /** How the nested native tool answers; the default reports "no native tool". */
  executeTool: (name: string, params: unknown, options?: { signal?: AbortSignal }) => Promise<unknown> = async () => ({
    isError: true,
    result: { content: [{ type: "text", text: "no native tool" }] },
  }),
) {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    },
    executeTool,
  };
}

/** Load the extension module fresh so each test gets its own module-level registries. */
async function loadExtension(): Promise<(pi: FakePi) => void> {
  const module = await import(`../extensions/bgwait-bridge.ts?t=${String(Date.now())}${String(Math.random())}`);
  return module.default as (pi: FakePi) => void;
}

test("factories register the provider synchronously and expose bg_wait_unified", async () => {
  const pi = fakePi();
  const activate = await loadExtension();
  activate(pi as never);

  const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents.background-work.v1")];
  const providers = (registry as { providers: Map<string, unknown> }).providers;
  assert.ok(providers.has("pi-background-tasks"), "provider must be registered before any turn runs");
  assert.equal(typeof pi.tools.find((tool) => tool.name === "bg_wait_unified")?.execute, "function");
  assert.deepEqual(
    pi.handlers.get("session_start")?.length ?? 0,
    1,
    "one session_start handler binds the runtime",
  );
});

test("session_start adopts the session identity and the provider reports its tasks", async () => {
  const pi = fakePi();
  const activate = await loadExtension();
  activate(pi as never);
  const host = new FakeBackgroundTaskHost(pi.events, { sessionId: "sess-A" });
  const ctx = fakeContext("sess-A", "C:/sessions/A.jsonl");
  await pi.emitTo("session_start", { reason: "startup" }, ctx);
  host.upsert({ id: "bg-1", name: "build", command: "npm run build", status: "running", startTime: Date.now(), isAgent: false });

  const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents.background-work.v1")];
  const provider = (registry as { providers: Map<string, { listActiveWork: Function }> }).providers.get(
    "pi-background-tasks",
  );
  await until(() => provider?.listActiveWork({ sessionId: "C:/sessions/A.jsonl", sessionIds: ["C:/sessions/A.jsonl", "sess-A"] }).length === 1, 4000);
  const items = provider?.listActiveWork({ sessionId: "C:/sessions/A.jsonl", sessionIds: ["C:/sessions/A.jsonl", "sess-A"] });
  assert.deepEqual(items?.map((item: { id: string }) => item.id), ["bg-1"]);
  await pi.emitTo("session_shutdown", { reason: "quit" }, ctx);
});

test("a second session in the same process does not share the first session's tasks", async () => {
  const pi = fakePi();
  const activate = await loadExtension();
  activate(pi as never);
  const hostA = new FakeBackgroundTaskHost(pi.events, { sessionId: "sess-A" });
  const ctxA = fakeContext("sess-A", "C:/sessions/A.jsonl");
  const ctxB = fakeContext("sess-B", "C:/sessions/B.jsonl");
  await pi.emitTo("session_start", { reason: "startup" }, ctxA);
  hostA.upsert({ id: "bg-A", name: "A", command: "sleep", status: "running", startTime: 1, isAgent: false });
  await tick(120);

  // Session B starts: a fresh bridge must not adopt A's activation (its sessionId differs).
  await pi.emitTo("session_start", { reason: "resume" }, ctxB);
  await tick(120);
  const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents.background-work.v1")];
  const provider = (registry as { providers: Map<string, { listActiveWork: Function }> }).providers.get(
    "pi-background-tasks",
  );
  const forB = provider?.listActiveWork({ sessionId: "C:/sessions/B.jsonl", sessionIds: ["C:/sessions/B.jsonl", "sess-B"] });
  assert.deepEqual(forB, [], "session B must not see session A's task");
  await pi.emitTo("session_shutdown", { reason: "quit" }, ctxB);
});

test("reload re-registers the same provider name without duplicating it", async () => {
  const pi = fakePi();
  const activate = await loadExtension();
  activate(pi as never);
  const ctx = fakeContext("sess-A", "C:/sessions/A.jsonl");
  await pi.emitTo("session_start", { reason: "startup" }, ctx);
  const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents.background-work.v1")];
  const providers = (registry as { providers: Map<string, unknown> }).providers;
  await pi.emitTo("session_shutdown", { reason: "reload" }, ctx);
  // A real reload constructs a fresh extension instance and emits session_start again.
  activate(pi as never);
  await pi.emitTo("session_start", { reason: "reload" }, ctx);
  assert.equal(providers.size, 1, "one registration per name after reload");
  assert.ok(providers.has("pi-background-tasks"));
});

test("session_shutdown unregisters and unsubscribes", async () => {
  const pi = fakePi();
  const activate = await loadExtension();
  activate(pi as never);
  const ctx = fakeContext("sess-A", "C:/sessions/A.jsonl");
  await pi.emitTo("session_start", { reason: "startup" }, ctx);
  const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents.background-work.v1")];
  const providers = (registry as { providers: Map<string, unknown> }).providers;
  assert.ok(providers.has("pi-background-tasks"));
  await pi.emitTo("session_shutdown", { reason: "quit" }, ctx);
  assert.equal(providers.has("pi-background-tasks"), false, "shutdown must unregister");
  assert.equal(pi.events.listenerCount("pi-background-tasks:terminal:v1"), 0, "shutdown must unsubscribe");
});

test("typed streaming input aborts an open unified wait; idle input does not", async () => {
  const pi = fakePi();
  const activate = await loadExtension();
  activate(pi as never);
  const host = new FakeBackgroundTaskHost(pi.events, { sessionId: "sess-A" });
  const ctx = fakeContext("sess-A", "C:/sessions/A.jsonl");
  await pi.emitTo("session_start", { reason: "startup" }, ctx);
  host.upsert({ id: "bg-hold", name: "hold", command: "sleep", status: "running", startTime: 1, isAgent: false });
  await tick(80);
  const tool = pi.tools.find((entry) => entry.name === "bg_wait_unified");
  assert.ok(tool);
  const pending = tool.execute("call-1", { all: true, timeoutMs: 4000 }, undefined, undefined, ctx) as Promise<unknown>;

  await tick(60);
  await pi.emitTo("input", { text: "hello", source: "interactive", streamingBehavior: undefined }, ctx);
  await tick(40);
  // Idle input must not end the wait: the tool call is still open.
  const stillOpen = await Promise.race([
    pending.then(() => "finished"),
    tick(60).then(() => "running"),
  ]);
  assert.equal(stillOpen, "running", "idle input must not abort a wait");

  await pi.emitTo("input", { text: "steer me", source: "interactive", streamingBehavior: "steer" }, ctx);
  const result = (await pending) as { content: { text: string }[]; details: { failed: boolean } };
  assert.match(result.content[0]?.text ?? "", /user sent a new message/i);
  assert.equal(result.details.failed, false);
});

test("the tool reports a failed background task as an error result", async () => {
  const pi = fakePi();
  const activate = await loadExtension();
  activate(pi as never);
  const host = new FakeBackgroundTaskHost(pi.events, { sessionId: "sess-A" });
  const ctx = fakeContext("sess-A", "C:/sessions/A.jsonl");
  await pi.emitTo("session_start", { reason: "startup" }, ctx);
  host.upsert({ id: "bg-fail", name: "build", command: "npm run build", status: "running", startTime: 1, isAgent: false });
  await tick(80);
  const tool = pi.tools.find((entry) => entry.name === "bg_wait_unified");
  const pending = tool?.execute("call-2", { ids: ["bg-fail"], timeoutMs: 2000 }, undefined, undefined, ctx) as Promise<unknown>;
  await tick(40);
  host.finish("bg-fail", "failed", { exitCode: 1, error: "tsc error" });
  const result = (await pending) as { content: { text: string }[]; details: { failed: boolean }; isError?: boolean };
  assert.equal(result.isError, true);
  assert.equal(result.details.failed, true);
  assert.match(result.content[0]?.text ?? "", /bg-fail failed exit=1/i);
});

test("launch provenance accepts task/tasks details from launcher tool results", async () => {
  const pi = fakePi();
  const activate = await loadExtension();
  activate(pi as never);
  const host = new FakeBackgroundTaskHost(pi.events, { sessionId: "sess-A" });
  const ctx = fakeContext("sess-A", "C:/sessions/A.jsonl");
  await pi.emitTo("session_start", { reason: "startup" }, ctx);
  await pi.emitTo(
    "tool_result",
    { toolName: "bg_run", toolCallId: "c1", details: { task: { id: "bg-run-1", status: "running", startTime: 1 } } },
    ctx,
  );
  host.upsert({ id: "bg-run-1", name: "r", command: "sleep", status: "completed", startTime: 1, isAgent: false, endTime: 2, exitCode: 0 });
  // The terminal frame for a launched id is attributed even if the bridge never listed it.
  pi.events.emit("pi-background-tasks:terminal:v1", {
    schema_version: "pi-background-tasks.extension-terminal.v1",
    task: { id: "bg-run-1", status: "completed", startTime: 1, endTime: 2, exitCode: 0 },
  });
  await tick(120);
  const tool = pi.tools.find((entry) => entry.name === "bg_wait_unified");
  const result = (await tool?.execute("call-3", { ids: ["bg-run-1"], timeoutMs: 300 }, undefined, undefined, ctx)) as {
    content: { text: string }[];
  };
  assert.match(result.content[0]?.text ?? "", /bg-run-1 completed/i);
});

test("an intercom message from another agent ends an open unified wait", async () => {
  const pi = fakePi();
  const activate = await loadExtension();
  activate(pi as never);
  const host = new FakeBackgroundTaskHost(pi.events, { sessionId: "sess-A" });
  const ctx = fakeContext("sess-A", "C:/sessions/A.jsonl");
  await pi.emitTo("session_start", { reason: "startup" }, ctx);
  host.upsert({ id: "bg-ic", name: "build", command: "npm run build", status: "running", startTime: 1, isAgent: false });
  await tick(80);
  const tool = pi.tools.find((entry) => entry.name === "bg_wait_unified");
  assert.ok(tool);
  const pending = tool.execute("call-ic", { all: true, timeoutMs: 4000 }, undefined, undefined, ctx) as Promise<unknown>;
  await tick(60);
  // The shape pi-intercom injects (`index.ts:1325-1340`): role "custom" + customType.
  await pi.emitTo(
    "message_end",
    {
      message: {
        role: "custom",
        customType: "intercom_message",
        content: "**From scout** — need a decision on the SATA lane",
        display: true,
        details: { from: { id: "sess-child", name: "scout" }, message: { id: "msg-1", expectsReply: true } },
      },
    },
    ctx,
  );
  const result = (await pending) as { content: { text: string }[] };
  assert.match(result.content[0]?.text ?? "", /intercom message/i, result.content[0]?.text ?? "");
  assert.match(result.content[0]?.text ?? "", /scout/i);
  // The background task keeps running: a wait never kills work.
  assert.deepEqual(host.tasks.map((entry) => entry.status), ["running"]);
});

test("an attention control event from this session's run ends an open unified wait", async () => {
  const pi = fakePi();
  const activate = await loadExtension();
  activate(pi as never);
  const host = new FakeBackgroundTaskHost(pi.events, { sessionId: "sess-A" });
  const ctx = fakeContext("sess-A", "C:/sessions/A.jsonl");
  await pi.emitTo("session_start", { reason: "startup" }, ctx);
  host.upsert({ id: "bg-att", name: "build", command: "npm run build", status: "running", startTime: 1, isAgent: false });
  await tick(80);
  const tool = pi.tools.find((entry) => entry.name === "bg_wait_unified");
  assert.ok(tool);
  const pending = tool.execute("call-att", { all: true, timeoutMs: 4000 }, undefined, undefined, ctx) as Promise<unknown>;
  await tick(60);
  pi.events.emit("subagent:control-event", {
    source: "async",
    asyncDir: await ownedRunDir("sess-A"),
    event: {
      type: "needs_attention",
      runId: "run-att",
      agent: "rtl-engineer",
      reason: "tool_open_threshold",
      message: "rtl-engineer has had tool 'bash' open for 240s",
      ts: 0,
    },
  });
  const result = (await pending) as { content: { text: string }[] };
  assert.match(result.content[0]?.text ?? "", /needs attention in run run-att/i, result.content[0]?.text ?? "");
  assert.match(result.content[0]?.text ?? "", /has had tool 'bash' open for 240s/i);
});

/**
 * A run directory owned by the given session: the capture attributes a control event by the
 * launching `sessionId` in `status.json`, the same fact upstream uses (`requestMatchesOwner`).
 */
async function ownedRunDir(sessionId: string): Promise<string> {
  const dir = path.join(tmpdir(), "bgw-ext-signals", `run-${String(Math.random()).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "status.json"), JSON.stringify({ sessionId }), "utf8");
  return dir;
}

test("an `any` wait for a subagent alone does not answer before the native scope settles", async () => {
  // Reported by the operator (`any=true`): with no background task of its own and one async
  // subagent live, the call answered at once with `No background task of this session is
  // running.` and `Native wait: native bg_wait failed: Operation aborted` — `any` treated an
  // empty id scope as a first completion, retired the native half before it observed the run,
  // and reported the abort it had itself caused as a native failure.
  const pi = fakePi();
  const activate = await loadExtension();
  activate(pi as never);
  // The native tool has to be *registered* for the extension to attempt the nested call at all.
  pi.tools.push({ name: "bg_wait", parameters: {}, execute: async () => ({}) });
  const seen: Record<string, unknown>[] = [];
  const ctx = fakeContext("sess-A", "C:/sessions/A.jsonl", "C:/work", async (name, params, options) => {
    seen.push({ name, params });
    const signal = options?.signal;
    // A live async run that settles 260 ms into the nested wait: only the native half can see it.
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ result: { content: [{ type: "text", text: "Waited 0.3s for 1 async run(s); done." }] } }), 260);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("Operation aborted"));
        },
        { once: true },
      );
    });
  });
  await pi.emitTo("session_start", { reason: "startup" }, ctx);
  const tool = pi.tools.find((entry) => entry.name === "bg_wait_unified");
  assert.ok(tool);
  const startedAt = Date.now();
  const result = (await tool.execute("call-any", { any: true, includeNative: true, timeoutMs: 4000 }, undefined, undefined, ctx)) as {
    content: { text: string }[];
  };
  const elapsed = Date.now() - startedAt;
  const text = result.content[0]?.text ?? "";
  assert.ok(elapsed >= 200, `an empty background scope must not satisfy \`any\` (${String(elapsed)}ms)`);
  assert.match(text, /1 async run\(s\); done/, "the native answer must be passed through");
  assert.doesNotMatch(text, /Operation aborted/, "the native half was not aborted before it answered");
  assert.equal(seen[0]?.name, "bg_wait");
  assert.equal((seen[0]?.params as { all?: boolean }).all, false, "`any` forwards all:false to the native half");
});

test("a native wait released by this tool's own abort is a release note, not a failure", async () => {
  // The abort lands inside the native tool's execution here (`Operation aborted`), while the
  // earlier shape (`Wait aborted`) came from its polling loop. Both are this tool retiring the
  // nested call after its own answer, so neither may be reported as a native failure.
  const pi = fakePi();
  const activate = await loadExtension();
  activate(pi as never);
  // The native tool has to be *registered* for the extension to attempt the nested call at all.
  pi.tools.push({ name: "bg_wait", parameters: {}, execute: async () => ({}) });
  const host = new FakeBackgroundTaskHost(pi.events, { sessionId: "sess-A" });
  let aborted = false;
  const ctx = fakeContext("sess-A", "C:/sessions/A.jsonl", "C:/work", async (name, _params, options) => {
    assert.equal(name, "bg_wait");
    const signal = options?.signal;
    // Never answers on its own: only this tool's release ends it, so the native failure text is
    // the one a real abort inside its execution produces.
    // `ctx.executeTool` reports a tool failure as an outcome with `isError:true`, not by
    // throwing (the throw path is the host's own dispatch failure). This is the shape the live
    // session reported: `native bg_wait failed: Operation aborted`.
    return await new Promise((resolve) => {
      const answerAsAborted = (): void => {
        aborted = true;
        resolve({ isError: true, result: { content: [{ type: "text", text: "Operation aborted" }] } });
      };
      if (signal?.aborted === true) answerAsAborted();
      else signal?.addEventListener("abort", answerAsAborted, { once: true });
    });
  });
  await pi.emitTo("session_start", { reason: "startup" }, ctx);
  host.upsert({ id: "bg-rel", name: "build", command: "npm run build", status: "running", startTime: 1, isAgent: false });
  await tick(80);
  const tool = pi.tools.find((entry) => entry.name === "bg_wait_unified");
  assert.ok(tool);
  const pending = tool.execute("call-rel", { all: true, timeoutMs: 3000 }, undefined, undefined, ctx) as Promise<unknown>;
  await tick(60);
  host.finish("bg-rel", "completed", { exitCode: 0 });
  const result = (await pending) as { content: { text: string }[] };
  const text = result.content[0]?.text ?? "";
  assert.ok(aborted, "this tool must retire the nested call once it has its answer");
  assert.match(text, /bg-rel completed/i);
  assert.match(text, /released when this wait ended/i, "the abort is a release note");
  assert.doesNotMatch(text, /Operation aborted/, "the native failure text is not reported");
  assert.doesNotMatch(text, /nested call failed/i);
});
