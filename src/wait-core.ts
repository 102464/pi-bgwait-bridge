/**
 * Event-driven wait loop shared by `bg_wait_unified`.
 *
 * Contract (mirrors pi-subagents' own wait loop):
 *  - Never blocks the Node event loop: one Promise, woken by EventBus channels, a poll
 *    fallback, an abort signal, and a user-input signal.
 *  - Timeout ends the wait window only; it never kills the work.
 *  - Supervisor asks and typed user input end the wait with a distinct outcome.
 *  - `stopOnAttention:false` keeps ordinary idle reminders from ending the wait.
 */
import type { TerminalRecord } from "./bridge.ts";
import { DEFAULT_POLL_MS, MIN_POLL_MS } from "./constants.ts";
import { isActiveStatus, isTerminalStatus, type EventBusLike, type WaitTargetTask } from "./types.ts";

export type WaitOutcome =
  | { kind: "settled"; reason: "all" | "any" }
  | { kind: "timeout" }
  | { kind: "aborted"; reason: string }
  | { kind: "user_input" }
  | { kind: "supervisor_request" }
  | { kind: "provider_disappeared"; provider: string };

export interface WaitScope {
  /** Background task ids this wait is responsible for. */
  readonly taskIds: readonly string[];
  /** Secondary scope: whether subagent work is also waited for, and by which native call id. */
  readonly nativeRunIds?: readonly string[];
}

export interface WaitDeps {
  events: EventBusLike;
  now?: () => number;
  pollIntervalMs?: number;
  /** Live owned running ids. */
  activeIds: () => readonly string[];
  /** Terminal records for this session. */
  terminals: () => readonly TerminalRecord[];
  /** Provider names present in the last snapshot (used for fail-closed detection). */
  providers?: () => readonly string[];
  /** True when a subagent supervisor request is outstanding. */
  hasSupervisorRequest?: () => boolean;
  /** Wakes the loop on state change; returns an unsubscribe. */
  subscribe?: (listener: () => void) => () => void;
  /** Channels that should wake the loop. */
  wakeChannels?: readonly string[];
  /** Optional cap on consecutive no-op wakeups (defensive against event storms). */
  maxIdleTicks?: number;
}

export interface WaitRequest {
  mode: "all" | "any";
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  userInputSignal?: AbortSignal | undefined;
  stopOnAttention?: boolean;
  onTick?: (state: { elapsedMs: number; active: string[]; finished: string[] }) => void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
    if (signal) {
      if (signal.aborted) return done();
      signal.addEventListener("abort", done, { once: true });
    }
  });
}

export async function waitForWork(scope: WaitScope, request: WaitRequest, deps: WaitDeps): Promise<WaitOutcome> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const pollMs = Math.max(MIN_POLL_MS, deps.pollIntervalMs ?? DEFAULT_POLL_MS);
  const initialIds = new Set(scope.taskIds);
  const initialProviders = deps.providers?.() ?? [];
  const stopOnAttention = request.stopOnAttention !== false;

  // Wakes: provider/item state changes plus the wake channels pi-subagents itself listens to.
  let wakeResolve: (() => void) | undefined;
  const wake = () => {
    wakeResolve?.();
  };
  const unsubscribers: Array<() => void> = [];
  const channels = [...new Set(deps.wakeChannels ?? [])];
  for (const channel of channels) {
    try {
      unsubscribers.push(deps.events.on(channel, wake));
    } catch {
      /* an unusable channel only costs latency */
    }
  }
  if (deps.subscribe) unsubscribers.push(deps.subscribe(wake));

  const cleanup = () => {
    for (const unsubscribe of unsubscribers) {
      try {
        unsubscribe();
      } catch {
        /* best effort */
      }
    }
    unsubscribers.length = 0;
  };

  try {
    // Already-terminal before the wait started: report immediately, never hang.
    const finished = () =>
      [...initialIds].filter((id) => {
        const terminal = deps.terminals().find((record) => record.id === id);
        return terminal !== undefined || !deps.activeIds().includes(id);
      });
    const stillActive = () =>
      [...initialIds].filter((id) => {
        const terminal = deps.terminals().find((record) => record.id === id);
        return terminal === undefined && deps.activeIds().includes(id);
      });

    const isDone = (): WaitOutcome | undefined => {
      if (deps.hasSupervisorRequest?.()) return { kind: "supervisor_request" };
      if (request.signal?.aborted) return { kind: "aborted", reason: "signal" };
      const active = stillActive();
      const done = finished();
      if (request.mode === "any") {
        if (done.length > 0) return { kind: "settled", reason: "any" };
        if (initialIds.size === 0) return { kind: "settled", reason: "any" };
        return undefined;
      }
      if (active.length === 0) return { kind: "settled", reason: "all" };
      return undefined;
    };

    const providerLost = (): WaitOutcome | undefined => {
      if (initialProviders.length === 0) return undefined;
      const present = deps.providers?.() ?? [];
      for (const provider of initialProviders) {
        if (!present.includes(provider)) return { kind: "provider_disappeared", provider };
      }
      return undefined;
    };

    let idleTicks = 0;
    while (true) {
      const done = isDone();
      if (done) return done;
      const lost = providerLost();
      if (lost) return lost;

      const active = stillActive();
      request.onTick?.({ elapsedMs: now() - startedAt, active, finished: finished() });

      if (request.userInputSignal?.aborted) return { kind: "user_input" };
      if (now() - startedAt >= request.timeoutMs) {
        if (deps.hasSupervisorRequest?.()) return { kind: "supervisor_request" };
        return { kind: "timeout" };
      }

      // A wakeup that changed nothing for a long stretch is an idle reminder, not new work.
      const slept = new Promise<void>((resolve) => {
        wakeResolve = resolve;
      });
      const timer = sleep(pollMs, request.signal);
      await Promise.race([slept, timer]);
      wakeResolve = undefined;
      idleTicks += 1;
      if (deps.maxIdleTicks !== undefined && idleTicks > deps.maxIdleTicks && active.length === 0 && initialIds.size > 0) {
        return { kind: "settled", reason: "all" };
      }
      if (stopOnAttention && deps.hasSupervisorRequest?.()) return { kind: "supervisor_request" };
    }
  } finally {
    cleanup();
  }
}

/** Human-readable one-liner for a task record. */
export function describeTask(task: WaitTargetTask): string {
  const status = String(task.status);
  if (isActiveStatus(status)) return `${task.id} running`;
  if (isTerminalStatus(status)) {
    const code = task.exitCode !== undefined && task.exitCode !== null ? ` exit=${String(task.exitCode)}` : "";
    const error = typeof task.error === "string" && task.error.length > 0 ? ` error=${task.error.slice(0, 160)}` : "";
    return `${task.id} ${status}${code}${error}`;
  }
  return `${task.id} ${status}`;
}

export function describeTerminal(record: TerminalRecord): string {
  const code = record.exitCode !== undefined && record.exitCode !== null ? ` exit=${String(record.exitCode)}` : "";
  const error = record.error ? ` error=${record.error.slice(0, 160)}` : "";
  return `${record.id} ${record.status}${code}${error}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${String(minutes)}m${String(rest).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h${String(minutes % 60).padStart(2, "0")}m`;
}
