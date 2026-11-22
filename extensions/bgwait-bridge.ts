/**
 * Extension entry: `pi-bgwait-bridge`.
 *
 * Two additive responsibilities:
 *  1. Register one pi-subagents background-work provider so native `bg_wait` counts this
 *     session's pi-background-tasks jobs. Native `bg_wait` then no longer answers
 *     "No active async runs or registered provider work in this session" while a `bg_run`
 *     task is running, and `all:true` keeps blocking until both kinds finish.
 *  2. Register `bg_wait_unified` for exact-id and mixed-scope waits that the native
 *     provider contract cannot express, with per-task failure reporting.
 *
 * No monkey patching: the provider lands in pi-subagents' documented process-local registry
 * (and is upgraded to the official registration when its module is importable), and every
 * pi-background-tasks interaction is a public EventBus request.
 *
 * The provider is registered at extension load, not at `session_start`: pi-subagents decides
 * whether to declare `bg_wait` in `before_agent_start` by testing
 * `listBackgroundWorkProviders().length > 0`, so a registration deferred to `session_start`
 * would be too late for the first turn. Session identity is therefore resolved lazily
 * through `currentIdentity()`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBridge, type Bridge, type ProviderContext } from "../src/bridge.ts";
import { BG_TERMINAL_CHANNEL, HOST_CHANGED_CHANNEL, PROVIDER_NAME } from "../src/constants.ts";
import { createIntercomProbe } from "../src/intercom-probe.ts";
import { registerProviderSync, upgradeToOfficial, type ProviderShape, type RegisterResult } from "../src/provider-registry.ts";
import { createSubagentSignalCapture, type SubagentSignalCapture } from "../src/subagent-signals.ts";
import { createUnifiedToolRunner } from "../src/unified-tool.ts";
import { createSupervisorProbe } from "../src/supervisor-probe.ts";
import { createWorkWatch } from "../src/work-watch.ts";
import type { WaitTargetTask } from "../src/types.ts";

/**
 * Parameter schema as plain JSON Schema.
 *
 * Pi validates tool arguments as JSON Schema (`docs/extensions.md` §Tool parameter schemas),
 * and Pi's own TypeBox schemas are JSON Schema. Writing it directly keeps this package free
 * of host-provided imports, so the module also loads under `node --test`, where `typebox`
 * is not resolvable, without changing how Pi sees the tool.
 */
const BgWaitUnifiedParams = {
  type: "object",
  properties: {
    ids: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1 },
      description:
        "Exact background task ids to wait for (no prefixes). Omit with all:true to wait for every running background task of this session.",
    },
    all: {
      type: "boolean",
      description: "Wait for every background task that is running at the moment the wait starts.",
    },
    any: { type: "boolean", description: "Return as soon as one selected task reaches a terminal state." },
    timeoutMs: { type: "number", description: "Wait window; the work keeps running afterwards." },
        stopOnAttention: {
      type: "boolean",
      description:
        "Default: attention notices and intercom messages from a subagent of this session end the wait, and so does a real supervisor request. Pass true to also let the native bg_wait end on any attention notice before this tool observes it.",
    },
    includeNative: {
      type: "boolean",
      description:
        "Wait for async subagent runs too. Default: true for session-wide calls (all / any / no ids) and false when exact ids are given; false here opts out entirely.",
    },
  },
  additionalProperties: false,
} as const;

interface Identity {
  sessionId: string;
  sessionFile: string | undefined;
}

interface Runtime {
  bridge: Bridge;
  identity: Identity;
}

const LAUNCHER_TOOLS = new Set([
  "bg_run",
  "bg_delegate",
  "bg_run_pi_attested",
  "fusion_reason",
  "fusion_investigate",
  "fusion_research",
  "fusion_validate",
]);

const debug = (line: string): void => {
  if (process.env["PI_BGWAIT_BRIDGE_DEBUG"]) console.error(`[pi-bgwait-bridge] ${line}`);
};

export default function activate(pi: ExtensionAPI): void {
  const runtimes = new Map<string, Runtime>();
  let current: Identity = { sessionId: "", sessionFile: undefined };
  let currentRuntime: Runtime | undefined;
  /** Provider names observed in the last snapshot, for fail-closed detection. */
  const seenProviders = new Set<string>();
  /** One AbortController per in-flight unified wait, aborted by typed streaming input. */
  const waitControllers = new Map<string, AbortController>();
  /**
   * Signal captures of the waits currently in flight. `intercom({action:"ask"})` from another
   * agent is delivered as a `customType:"intercom_message"` message
   * (pi-intercom `index.ts:1325-1340`) and emits no control event, so the wait can only learn
   * about it from Pi's own message stream.
   */
  const activeCaptures = new Set<SubagentSignalCapture>();

  const identityOf = (ctx: ExtensionContext): Identity => ({
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
  });

  const keyOf = (identity: Identity): string => identity.sessionFile ?? identity.sessionId;

  function runtimeFor(ctx: ExtensionContext): Runtime {
    const identity = identityOf(ctx);
    const key = keyOf(identity);
    const existing = runtimes.get(key);
    current = identity;
    if (existing) {
      currentRuntime = existing;
      return existing;
    }
    const runtime: Runtime = {
      identity,
      bridge: createBridge({ events: pi.events, identity: () => current, log: debug }),
    };
    runtimes.set(key, runtime);
    currentRuntime = runtime;
    debug(`bridge created for ${identity.sessionFile ?? identity.sessionId}`);
    return runtime;
  }

  /** Which runtime a provider call belongs to: match the asked identities, else the active one. */
  function runtimeForContext(context: ProviderContext | undefined): Runtime | undefined {
    if (context?.sessionIds && context.sessionIds.length > 0) {
      for (const runtime of runtimes.values()) {
        const forms = [runtime.identity.sessionId, runtime.identity.sessionFile].filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        );
        if (forms.some((value) => context.sessionIds.includes(value))) return runtime;
      }
      return undefined;
    }
    return currentRuntime;
  }

  // One process-level provider, registered before the first turn can run.
  const provider: ProviderShape = {
    name: PROVIDER_NAME,
    wakeChannels: [BG_TERMINAL_CHANNEL, HOST_CHANGED_CHANNEL],
    listActiveWork(context?: ProviderContext) {
      const runtime = runtimeForContext(context);
      if (!runtime) return [];
      return runtime.bridge.provider.listActiveWork(context);
    },
    reconcile(context: ProviderContext) {
      runtimeForContext(context)?.bridge.provider.reconcile(context);
    },
  };
  let registration: RegisterResult = registerProviderSync(provider);
  debug(`provider "${PROVIDER_NAME}" registered (${registration.mode})`);
  // Upgrade to the official registration when pi-subagents resolves from this module root.
  // Same name → replaces, so this is idempotent and reload-safe.
  void upgradeToOfficial(provider).then((upgraded) => {
    if (!upgraded || upgraded.mode !== "official") {
      if (upgraded?.note) debug(upgraded.note);
      return;
    }
    registration = upgraded;
    debug(`provider "${PROVIDER_NAME}" upgraded to the official registration`);
  });

  pi.on("session_start", (_event, ctx) => {
    runtimeFor(ctx).bridge.refresh();
  });

  pi.on("session_shutdown", () => {
    try {
      registration.dispose();
    } catch {
      /* best effort */
    }
    for (const runtime of runtimes.values()) runtime.bridge.dispose();
    runtimes.clear();
    currentRuntime = undefined;
    waitControllers.clear();
  });

  // Typed streaming input (steer / follow-up) ends an open wait so the message reaches the
  // model now. Idle prompts never abort: they are not typed into a running turn.
  pi.on("input", (event) => {
    const streaming = (event as { streamingBehavior?: string | undefined }).streamingBehavior;
    const source = (event as { source?: string | undefined }).source;
    if (source === "extension" || streaming === undefined) return;
    for (const controller of waitControllers.values()) controller.abort();
  });

  // Provenance: remember the task ids this session's own launchers produced, so a terminal
  // frame can be attributed without trusting an unfiltered snapshot.
  pi.on("tool_result", (event, ctx) => {
    const toolName = (event as { toolName?: string }).toolName;
    if (toolName === undefined || !LAUNCHER_TOOLS.has(toolName)) return;
    const runtime = runtimeFor(ctx);
    for (const task of tasksFromDetails((event as { details?: unknown }).details)) {
      runtime.bridge.noteLaunched(task);
    }
    runtime.bridge.refresh();
  });

  /**
   * Another agent's intercom message is a blocking ask for this session: end the wait so it can
   * be read. Pi marks these messages `role:"custom"`, `customType:"intercom_message"`; a
   * capture ignores anything it observed before its wait was armed, so a backlog is not new work.
   */
  pi.on("message_end", (event) => {
    const message = (event as { message?: unknown }).message;
    if (!message || typeof message !== "object") return;
    const record = message as { role?: unknown; customType?: unknown; details?: unknown; content?: unknown };
    if (record.role !== "custom") return;
    for (const capture of activeCaptures) {
      capture.observeIntercomMessage({
        customType: record.customType,
        details: record.details,
        content: record.content,
      });
    }
  });

  pi.registerTool({
    name: "bg_wait_unified",
    label: "Unified Background Wait",
    description:
      "Wait for this session's native pi-background-tasks work (bg_run and the other bg_* launchers) together with pi-subagents async runs. Pass ids for exact background task ids, or all/any/none for the whole session; a session-wide call also waits for async subagents through the native bg_wait. Native bg_wait alone covers aggregate provider work; this tool adds exact ids, mixed scope, and per-task failure reporting. A timeout ends the wait window only; the work keeps running.",
    promptSnippet:
      "Wait for this session's background work: exact background task ids, or the whole session (background tasks plus async subagents); per-task failure results",
    promptGuidelines: [
      "Use bg_wait_unified when you need to wait for a specific bg_run task id, or for a mix of bg_run tasks and async subagents in one blocking call.",
      "Pass ids for exact background tasks, or all:true to wait for every background task running when the wait starts plus any async subagent. any:true returns on the first terminal state.",
      "A session-wide call with no ids (all/any) also waits for async subagents, so it is safe to call right after a reload when only a subagent is running.",
      "The wait window ends without killing anything; call again to keep waiting. A failed or killed task is reported as a failure, never as success.",
      "For tasks a unified wait will cover, launch with notifyOnCompletion:true and triggerOnCompletion:false so completion does not also start a second agent turn.",
    ],
    parameters: BgWaitUnifiedParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const runtime = runtimeFor(ctx);
      const controller = new AbortController();
      waitControllers.set(toolCallId, controller);
      // One probe per call so its 250 ms cache is actually used: the wait loop asks this
       // question on every tick, and a fresh probe per tick would rescan the channel root.
      const supervisor = createSupervisorProbe({
        sessionIds: () =>
          [runtime.identity.sessionFile, runtime.identity.sessionId].filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          ),
      });
      /**
       * The other two signal classes: an attention notice, and an intercom message another
       * agent routed here. Both are captured from pi-subagents' own control-event bus during
       * this wait only, attributed to a run of this session by its launch `sessionId`.
       */
      const signals = createSubagentSignalCapture({
        events: pi.events,
        sessionIds: () =>
          [runtime.identity.sessionFile, runtime.identity.sessionId].filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          ),
        /**
         * The durable half of an intercom message: pi-intercom addresses a session by its
         * intercom id (`resolveConfiguredIntercomSessionId`, index.ts:596-598), which it
         * publishes into `PI_INTERCOM_SESSION_ID` at session start — read lazily because the
         * extension loads before that. A steered ask is invisible while this tool blocks the
         * turn (`agent-session.js:1967-1975` only queues it), so the ledger record is the
         * only evidence a wait can see.
         */
        pendingAsk: () => intercom.pending(),
      });
      /**
       * One probe per call, so its own 250 ms scan cache is reused across the wait's ticks.
       * pi-intercom addresses a session by its intercom id (`resolveConfiguredIntercomSessionId`,
       * index.ts:596-598), which it publishes into `PI_INTERCOM_SESSION_ID` at session start —
       * read lazily because the extension loads before that.
       */
      const intercomIds = (): string[] =>
        [process.env["PI_INTERCOM_SESSION_ID"], runtime.identity.sessionId].filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        );
      const intercom = createIntercomProbe({ sessionIds: intercomIds });
      /**
       * The disk half of the wait's signals arrives as an OS change notification, not a poll
       * tick (operator request, 2026-11-22). A steered intercom ask and a supervisor request
       * both live only in a file while this tool holds the turn, so the folders pi-intercom and
       * pi-subagents write are watched; the wait loop's own poll stays as the fallback.
       */
      let armed: (() => void) | undefined;
      try {
        // Armed before the wait begins and cleared in `finally`: a notice that fired before
        // this call is not new work, and no listener outlives the tool call.
        armed = signals.arm(() => {});
        activeCaptures.add(signals);
        const runner = createUnifiedToolRunner({
          bridge: runtime.bridge,
          events: pi.events,
          providers: () => [...seenProviders],
          // A real supervisor request is what ends this wait; generic attention notices do not.
          // The probe reads pi-subagents' own request files, the same data `requestMatchesOwner`
          // uses, so a request answered in an earlier turn is not counted again.
          hasSupervisorRequest: () => supervisor.hasPending(),
          /**
           * Attention / intercom signals end this wait too (operator requirement). The capture
           * is armed on the first tick, so a stale notice that fired before the call is not
           * treated as new work (that is the `attention required` premature-return regression).
           */
          pendingSubagentSignal: () => signals.pending(),
          // Live async runs of this session: the progress line counts them, so it cannot print
          // `0 async run(s)` while a subagent of this session is plainly still working.
          activeRuns: () => signals.activeRuns(),
          subscribe: (listener) => runtime.bridge.onChange(listener),
          /**
           * The disk half of the wait's signals arrives as an OS change notification instead of
           * a poll tick. `supervisor` and `intercom` are the probes that answer the two
           * predicates, and their folders are exactly where a request/ask/reply file lands —
           * so a change there invalidates the cached verdicts and wakes the loop at once. The
           * loop's own poll stays as the fallback for an unwatchable path.
           */
          externalWake: (wake) => {
            const watch = createWorkWatch({
              dirs: () => [intercom.watchedDir(), ...supervisor.watchedDirs()],
              onChange: () => {
                intercom.invalidate();
                supervisor.invalidate();
                wake();
              },
            });
            return watch.start();
          },
          nativeWait: async (waitParams, nestedSignal) => {
            if (!pi.getAllTools().some((tool) => tool.name === "bg_wait")) {
              return "native bg_wait is not registered in this session; skipped.";
            }
            /**
             * `ctx.executeTool` resolves against the *active* tool set, and this workspace runs
             * `pi-deferred-context-engine`: `bg_wait` is deferred by default, so the nested call
             * came back `native bg_wait failed: Tool bg_wait not found` and the async-run scope
             * was silently dropped. Registering the tool is not enough — it has to be active for
             * this run, so it is activated immediately before the call (the same promotion the
             * model gets from `search_tools`, done here because this call is not model-issued).
             */
            const active = pi.getActiveTools();
            if (!active.includes("bg_wait")) pi.setActiveTools([...active, "bg_wait"]);
            const outcome = await ctx.executeTool("bg_wait", waitParams, { signal: nestedSignal });
            const text = textOf(outcome);
            // The native tool can be blocked or disabled; its no-work answer must not be
            // reported as a completed subagent wait. An abort this tool caused by returning
            // its own answer is not a failure: the async scope simply keeps running.
            if ((outcome as { isError?: boolean } | undefined)?.isError === true) {
              /**
               * Aborting the nested call is how this tool retires the native half after it has
               * already answered, and the native failure text depends on where it was cut off:
               * `Wait aborted` when it was still polling, `Operation aborted` when the abort
               * landed inside its own tool execution. Both are this tool's own release, not a
               * failure of the async-run scope, so the abort itself decides the wording — a
               * genuine native failure cannot coincide with an abort we issued.
               */
              if (nestedSignal?.aborted === true) {
                return "native bg_wait released when this wait ended, so the async-run scope keeps running.";
              }
              return `native bg_wait failed: ${text}`;
            }
            return text;
          },
        });
        const result = await runner(
          params as never,
          signal,
          controller.signal,
          (update) => onUpdate?.({ content: [{ type: "text", text: update.text }], details: {} }),
        );
        runtime.bridge.refresh();
        for (const name of providerNames()) seenProviders.add(name);
        return {
          content: [{ type: "text", text: result.text }],
          details: { failed: result.failed, failedIds: result.failedIds },
          ...(result.failed ? { isError: true } : {}),
        };
      } finally {
        activeCaptures.delete(signals);
        armed?.();
        waitControllers.delete(toolCallId);
      }
    },
  });
}

function tasksFromDetails(details: unknown): WaitTargetTask[] {
  if (!details || typeof details !== "object") return [];
  const found: WaitTargetTask[] = [];
  const task = (details as { task?: unknown }).task;
  if (isTask(task)) found.push(task);
  const tasks = (details as { tasks?: unknown }).tasks;
  if (Array.isArray(tasks)) for (const entry of tasks) if (isTask(entry)) found.push(entry);
  return found;
}

function isTask(value: unknown): value is WaitTargetTask {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";
}

function textOf(outcome: unknown): string {
  if (!outcome || typeof outcome !== "object") return "native bg_wait returned no text";
  const content = (outcome as { result?: { content?: unknown } }).result?.content;
  if (!Array.isArray(content)) {
    return (outcome as { isError?: boolean }).isError ? "native bg_wait failed" : "native bg_wait returned no text";
  }
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : "native bg_wait returned no text";
}

/** Read provider names from the process-local registry without importing pi-subagents. */
function providerNames(): string[] {
  const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents.background-work.v1")];
  if (!registry || typeof registry !== "object") return [];
  const providers = (registry as { providers?: Map<string, unknown> }).providers;
  if (!(providers instanceof Map)) return [];
  return [...providers.keys()];
}
