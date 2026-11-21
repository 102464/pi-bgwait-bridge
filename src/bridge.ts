/**
 * The bridge state machine.
 *
 * Responsibilities:
 *  1. Learn this session's trusted identities (`getSessionId()` + session file).
 *  2. Learn the pi-background-tasks host activation that belongs to this session and
 *     refuse any activation that names a different session.
 *  3. Maintain a cached set of *running, owned* tasks, refreshed by events and by a
 *     bounded poll, so pi-subagents' synchronous `listActiveWork()` always has fresh data.
 *  4. Expose the exact set (ids + terminal states) the unified wait tool needs.
 */
import { createHostClient, type HostClient, type HostFacts } from "./bg-host-client.ts";
import {
  BG_TERMINAL_CHANNEL,
  HOST_CHANGED_CHANNEL,
  PROVIDER_NAME,
  REQUEST_TIMEOUT_MS,
  SUBAGENTS_PROVIDER_REGISTRY_KEY,
} from "./constants.ts";
import { createRequestClient, type RequestClient } from "./eventbus-client.ts";
import { itemSessionId, makeOwnershipRecord, type OwnershipRecord, type SessionIdentity } from "./ownership.ts";
import { isActiveStatus, isTerminalStatus, type EventBusLike, type WaitTargetTask } from "./types.ts";

export interface BridgeOptions {
  events: EventBusLike;
  /** Resolve the current session identities; re-read on every call so reloads stay correct. */
  identity: () => SessionIdentity;
  now?: () => number;
  /** Background refresh interval; 0 disables the timer. */
  refreshMs?: number;
  /** Round-trip timeout for one EventBus request; tests shorten it. */
  requestTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface TerminalRecord {
  id: string;
  status: "completed" | "failed" | "killed";
  exitCode?: number | null | undefined;
  error?: string | undefined;
  name?: string | undefined;
  endedAt: number;
  /** Completion/delivery policy captured while the task was live. */
  notifyOnCompletion?: boolean | undefined;
  triggerOnCompletion?: boolean | undefined;
}

export type WaitListener = () => void;

export interface ProviderContext {
  sessionId: string;
  sessionIds: readonly string[];
  nowMs: number;
}

export interface Bridge {
  readonly provider: {
    name: string;
    wakeChannels: readonly string[];
    listActiveWork(context?: ProviderContext): readonly { id: string; sessionId: string }[];
    reconcile(context?: ProviderContext): void;
  };
  running(): readonly WaitTargetTask[];
  /** Terminal records observed for this session, deduplicated by id + status. */
  terminal(): readonly TerminalRecord[];
  hasTerminal(id: string): boolean;
  terminalOf(id: string): TerminalRecord | undefined;
  /** Record an id launched through this session (provenance for terminal-event filtering). */
  noteLaunched(task: WaitTargetTask): void;
  isLaunched(id: string): boolean;
  /** Completion/delivery policy of the given ids, whether running or already terminal. */
  policyOf(id: string): { notifyOnCompletion: boolean; triggerOnCompletion: boolean } | undefined;
  /**
   * Authoritative lookup for one exact id against the host activation (never a prefix).
   * Used when the cache has not seen the task: it may have finished before the wait started.
   */
  lookup(id: string): Promise<{ task?: WaitTargetTask; owned: boolean; error?: string }>;
  refresh(): void;
  refreshNow(): Promise<void>;
  owned(): boolean;
  activation(): HostFacts | undefined;
  lastError(): string | undefined;
  onChange(listener: WaitListener): () => void;
  describe(): string;
  dispose(): void;
}

/** Provider names already registered in the process-local pi-subagents registry. */
export function readRegisteredProviders(): string[] {
  const registry = (globalThis as Record<symbol, unknown>)[Symbol.for(SUBAGENTS_PROVIDER_REGISTRY_KEY)];
  if (!registry || typeof registry !== "object") return [];
  const providers = (registry as { providers?: Map<string, unknown> }).providers;
  if (!(providers instanceof Map)) return [];
  return [...providers.keys()];
}

function isTerminalStatusName(status: string): status is TerminalRecord["status"] {
  return status === "completed" || status === "failed" || status === "killed";
}

export function createBridge(options: BridgeOptions): Bridge {
  const events = options.events;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const refreshMs = options.refreshMs ?? 1500;
  const requests: RequestClient = createRequestClient(events, options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);

  let record: OwnershipRecord | undefined;
  let activation: HostFacts | undefined;
  let host: HostClient | undefined;
  let lastError: string | undefined;
  let disposed = false;
  let inFlight: Promise<void> | undefined;
  let queued = false;

  const running = new Map<string, WaitTargetTask>();
  const terminals = new Map<string, TerminalRecord>();
  const launchPolicies = new Map<string, { notifyOnCompletion: boolean; triggerOnCompletion: boolean }>();
  const launched = new Set<string>();
  const listeners = new Set<WaitListener>();
  const unsubscribers: Array<() => void> = [];

  function identities(): string[] {
    const identity = options.identity();
    return [identity.sessionId, identity.sessionFile].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  }

  function emitChange(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        log(`change listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  function notePolicy(task: WaitTargetTask): void {
    launchPolicies.set(task.id, {
      // Upstream defaults are true for both (pi-background-tasks extension.ts:1032-:1033).
      notifyOnCompletion: task.notifyOnCompletion !== false,
      triggerOnCompletion: task.triggerOnCompletion !== false,
    });
  }

  function noteTerminal(task: WaitTargetTask): boolean {
    const status = String(task.status);
    if (!isTerminalStatusName(status)) return false;
    running.delete(task.id);
    const existing = terminals.get(task.id);
    // Deduplication key is id + status: a repeated terminal frame for the same outcome is a no-op.
    if (existing && existing.status === status) return false;
    terminals.set(task.id, {
      id: task.id,
      status,
      ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
      ...(typeof task.error === "string" ? { error: task.error } : {}),
      ...(typeof task.name === "string" ? { name: task.name } : {}),
      ...(launchPolicies.get(task.id) ? launchPolicies.get(task.id) : {}),
      endedAt: typeof task.endTime === "number" ? task.endTime : now(),
    });
    return true;
  }

  function applySnapshot(tasks: readonly WaitTargetTask[]): boolean {
    let changed = false;
    const seenActive = new Set<string>();
    for (const task of tasks) {
      if (!task || typeof task.id !== "string") continue;
      // Terminal truth wins over an older in-flight snapshot: a list response issued before
      // the task finished must never resurrect it as running.
      if (terminals.has(task.id)) {
        running.delete(task.id);
        continue;
      }
      if (isActiveStatus(String(task.status))) {
        seenActive.add(task.id);
        notePolicy(task);
        const previous = running.get(task.id);
        running.set(task.id, task);
        if (!previous) changed = true;
      } else if (noteTerminal(task)) {
        changed = true;
      }
    }
    // A task that leaves the active set without a terminal frame is no longer waitable.
    for (const id of [...running.keys()]) {
      if (!seenActive.has(id)) {
        running.delete(id);
        if (!terminals.has(id) && launched.has(id)) {
          // Its terminal state was never observed; report it as killed rather than as success.
          terminals.set(id, { id, status: "killed", endedAt: now() });
        }
        changed = true;
      }
    }
    return changed;
  }

  async function doRefresh(): Promise<void> {
    if (disposed) return;
    try {
      // The host client is created lazily but unconditionally: ownership can also arrive
      // through a `ready`/`changed` frame before the first subscribe, and a subscribe-only
      // path would then never have a client to list with.
      host =
        host ??
        createHostClient({
          events,
          requests,
          sessionIds: identities(),
          clientId: clientIdFor(),
          now,
        });
      if (!record || !host.hasLease()) {
        try {
          const subscription = await host.subscribe();
          const built = makeOwnershipRecord(
            options.identity(),
            { activationId: subscription.activationId, sessionId: subscription.sessionId },
            now(),
            "host-subscribe",
          );
          if (!built) {
            lastError = `host activation ${subscription.activationId} reports session ${subscription.sessionId}; not this session`;
            host.reset();
          } else {
            record = built;
            activation = {
              activationId: subscription.activationId,
              sessionId: subscription.sessionId,
              revision: subscription.revision,
              observedAt: subscription.observedAt,
            };
            lastError = undefined;
            emitChange();
          }
        } catch (error) {
          // Load order: the host service may not be initialized yet. Retried by poll and events.
          lastError = error instanceof Error ? error.message : String(error);
          if (lastError.includes("not this session")) record = undefined;
        }
      }
      if (record && host.hasLease()) {
        const listed = await host.list();
        activation = listed.facts;
        if (applySnapshot(listed.tasks)) emitChange();
        lastError = undefined;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  function kickRefresh(): void {
    if (disposed) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = doRefresh().finally(() => {
      inFlight = undefined;
      if (queued) {
        queued = false;
        kickRefresh();
      }
    });
  }

  function clientIdFor(): string {
    return `pi-bgwait-bridge:${options.identity().sessionId}`.slice(0, 128);
  }

  // ---- Event wiring -------------------------------------------------------

  unsubscribers.push(
    events.on(BG_TERMINAL_CHANNEL, (data: unknown) => {
      if (disposed || !data || typeof data !== "object") return;
      const task = (data as Record<string, unknown>)["task"];
      if (!task || typeof task !== "object") return;
      const candidate = task as WaitTargetTask;
      if (typeof candidate.id !== "string") return;
      if (!launched.has(candidate.id) && !running.has(candidate.id) && !terminals.has(candidate.id)) {
        // Ownership unknown: let the authoritative host list decide, never guess.
        kickRefresh();
        return;
      }
      if (noteTerminal(candidate)) emitChange();
    }),
  );

  unsubscribers.push(
    events.on(HOST_CHANGED_CHANNEL, (data: unknown) => {
      if (disposed || !data || typeof data !== "object") return;
      const frame = data as Record<string, unknown>;
      const sessionId = frame["sessionId"];
      const activationId = frame["activationId"];
      if (typeof sessionId !== "string" || typeof activationId !== "string") return;
      if (!identities().includes(sessionId)) return; // another session's activation
      if (!record) {
        const built = makeOwnershipRecord(options.identity(), { activationId, sessionId }, now(), "host-changed");
        if (built) {
          record = built;
          activation = {
            activationId,
            sessionId,
            revision: Number(frame["revision"] ?? 0),
            observedAt: Number(frame["observedAt"] ?? now()),
          };
          emitChange();
        }
      }
      kickRefresh();
    }),
  );
  // Deferred first refresh keeps the extension factory synchronous.
  if (typeof queueMicrotask === "function") queueMicrotask(() => kickRefresh());
  else setTimeout(() => kickRefresh(), 0);

  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  if (refreshMs > 0) {
    refreshTimer = setInterval(() => kickRefresh(), refreshMs);
    if (typeof refreshTimer === "object" && refreshTimer && "unref" in refreshTimer) refreshTimer.unref();
  }

  const provider: Bridge["provider"] = {
    name: PROVIDER_NAME,
    wakeChannels: [BG_TERMINAL_CHANNEL, HOST_CHANGED_CHANNEL] as readonly string[],
    // Synchronous by contract: pi-subagents calls this inside its own poll loop.
    listActiveWork(context?: ProviderContext): readonly { id: string; sessionId: string }[] {
      kickRefresh();
      if (!record) return [];
      const sessionId = itemSessionId(record, context?.sessionIds);
      if (sessionId === undefined) return [];
      return [...running.values()].map((task) => ({ id: task.id, sessionId }));
    },
    reconcile(context?: ProviderContext): void {
      kickRefresh();
      if (record && context?.sessionIds && !record.identities.some((value) => context.sessionIds.includes(value))) {
        // Session switched under us: drop ownership instead of leaking another session's work.
        record = undefined;
        activation = undefined;
        running.clear();
        launched.clear();
        emitChange();
      }
    },
  };

  function describe(): string {
    const activeIds = [...running.keys()];
    const parts = [
      `provider=${PROVIDER_NAME}`,
      record ? `activation=${record.activationId}` : "activation=<unverified>",
      `running=${activeIds.length}`,
    ];
    if (activeIds.length > 0) parts.push(`ids=${activeIds.join(",")}`);
    if (terminals.size > 0) {
      parts.push(`terminal=${[...terminals.values()].map((t) => `${t.id}:${t.status}`).join(",")}`);
    }
    if (lastError) parts.push(`lastError=${lastError}`);
    return parts.join(" ");
  }

  return {
    provider,
    running: () => [...running.values()],
    terminal: () => [...terminals.values()],
    hasTerminal: (id) => terminals.has(id),
    terminalOf: (id) => terminals.get(id),
    noteLaunched: (task) => {
      if (typeof task.id === "string") {
        launched.add(task.id);
        notePolicy(task);
      }
    },
    isLaunched: (id) => launched.has(id),
    policyOf: (id) => launchPolicies.get(id),
    lookup: async (id) => {
      if (disposed) return { owned: false, error: "bridge disposed" };
      host =
        host ??
        createHostClient({
          events,
          requests,
          sessionIds: identities(),
          clientId: clientIdFor(),
          now,
        });
      try {
        if (!record || !host.hasLease()) await host.subscribe();
        const detail = await host.detail(id);
        if ("error" in detail) return { owned: record !== undefined, error: detail.error };
        // The detail response carries the same trusted launch record as subscribe/list;
        // a foreign activation is refused here instead of being adopted.
        const built = makeOwnershipRecord(
          options.identity(),
          { activationId: detail.facts.activationId, sessionId: detail.facts.sessionId },
          now(),
          "host-list",
        );
        if (!built) {
          return { owned: false, error: `host activation reports session ${detail.facts.sessionId}; not this session` };
        }
        record = built;
        const task = detail.view.task;
        if (isActiveStatus(String(task.status))) {
          notePolicy(task);
          running.set(task.id, task);
        } else {
          notePolicy(task);
          noteTerminal(task);
        }
        return { task, owned: true };
      } catch (error) {
        return { owned: record !== undefined, error: error instanceof Error ? error.message : String(error) };
      }
    },
    refresh: () => kickRefresh(),
    refreshNow: () => {
      kickRefresh();
      return inFlight ?? Promise.resolve();
    },
    owned: () => record !== undefined,
    activation: () => activation,
    lastError: () => lastError,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    describe,
    dispose: () => {
      disposed = true;
      if (refreshTimer !== undefined) clearInterval(refreshTimer);
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe();
        } catch {
          /* best effort */
        }
      }
      unsubscribers.length = 0;
      listeners.clear();
      host?.dispose();
      requests.dispose();
    },
  };
}
