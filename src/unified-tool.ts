/**
 * `bg_wait_unified` — the exact-id / mixed-scope wait tool.
 *
 * Native `bg_wait` accepts `{all}`, `{}`, `{id}` and `{id,nonBlocking}`. Its provider
 * support is aggregate-only: a snapshot lists running provider items and `bg_wait` waits
 * for all/any of them, but `id` is resolved against subagent runs only
 * (`runsForIds`, `matchesId`) and never against provider items. Two consequences that
 * this tool exists to fix:
 *   - `bg_wait({id: "<bg task id>"})` reports "No active run matched" while the task runs.
 *   - `bg_wait({all:true})` cannot express "wait for exactly these three background
 *     tasks and ignore the two others this session also launched".
 *
 * The tool here waits on the bridge's own authoritative state, so failures are reported
 * per task instead of folded into one aggregate count.
 */
import type { Bridge, TerminalRecord } from "./bridge.ts";
import {
  BG_TERMINAL_CHANNEL,
  DEFAULT_TIMEOUT_MS,
  HOST_CHANGED_CHANNEL,
  SUBAGENT_CONTROL_CHANNEL,
} from "./constants.ts";
import { analyseCompletionPolicy } from "./notification-coordination.ts";
import { describeTerminal, formatDuration, waitForWork, type WaitOutcome } from "./wait-core.ts";
import { isTerminalStatus, type EventBusLike, type WaitTargetTask } from "./types.ts";

// The TypeBox parameter schema lives in `extensions/bgwait-bridge.ts`: `typebox` is a
// host-provided import that Pi aliases, so the pure-TS runner stays dependency-free and
// unit-testable outside Pi.
export type BgWaitUnifiedInput = {
  ids?: string[] | undefined;
  all?: boolean | undefined;
  any?: boolean | undefined;
  timeoutMs?: number | undefined;
  stopOnAttention?: boolean | undefined;
  includeNative?: boolean | undefined;
};

export interface UnifiedToolDeps {
  bridge: Bridge;
  events: EventBusLike;
  now?: () => number;
  /** Names of providers seen in the last pi-subagents snapshot (fail-closed detection). */
  providers?: () => readonly string[];
  hasSupervisorRequest?: () => boolean;
  /** Subscribe to local state changes (bridge.onChange). */
  subscribe?: (listener: () => void) => () => void;
  /** Optional nested native bg_wait call. */
  nativeWait?: (
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: (() => void) | undefined,
  ) => Promise<string>;
}

export interface UnifiedToolResult {
  text: string;
  failed: boolean;
  failedIds: string[];
}

function selectIds(input: BgWaitUnifiedInput, running: readonly WaitTargetTask[], terminal: readonly TerminalRecord[]): {
  ids: string[];
  preTerminal: TerminalRecord[];
  missing: string[];
} {
  if (input.ids && input.ids.length > 0) {
    const ids = [...new Set(input.ids)];
    const preTerminal: TerminalRecord[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const record = terminal.find((entry) => entry.id === id);
      if (record) {
        preTerminal.push(record);
        continue;
      }
      if (!running.some((task) => task.id === id)) missing.push(id);
    }
    return { ids, preTerminal, missing };
  }
  return { ids: running.map((task) => task.id), preTerminal: [], missing: [] };
}

export function createUnifiedToolRunner(deps: UnifiedToolDeps) {
  const now = deps.now ?? Date.now;
  const bridge = deps.bridge;

  return async function run(
    input: BgWaitUnifiedInput,
    signal: AbortSignal | undefined,
    userInputSignal: AbortSignal | undefined,
    onUpdate: ((result: { text: string }) => void) | undefined,
  ): Promise<UnifiedToolResult> {
    await bridge.refreshNow();
    const running = bridge.running();
    const terminal = bridge.terminal();
    const selection = selectIds(input, running, terminal);
    const mode: "all" | "any" = input.any === true ? "any" : "all";
    const timeoutMs = input.timeoutMs !== undefined && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS;

    // Unknown exact ids: ask the host once, by exact id. A task that finished before this
    // wait started is then answered instead of reported as "not found", and a genuinely
    // wrong id is reported immediately rather than waited on.
    const unresolved = [...selection.missing];
    if (unresolved.length > 0) {
      for (const id of unresolved) {
        const lookup = await bridge.lookup(id);
        if (lookup.task === undefined) continue;
        selection.missing = selection.missing.filter((entry) => entry !== id);
        if (isTerminalStatus(lookup.task.status)) {
          const record = bridge.terminalOf(id);
          if (record) selection.preTerminal.push(record);
        }
        selection.ids = [...new Set([...selection.ids, id])];
      }
    }

    if (selection.ids.length === 0) {
      const noWork = bridge.owned()
        ? "No background task of this session is running; nothing to wait for."
        : `No pi-background-tasks activation for this session is verified yet${bridge.lastError() ? ` (${bridge.lastError()})` : ""}; nothing to wait for.`;
      return { text: noWork, failed: false, failedIds: [] };
    }

    const preTerminal = selection.preTerminal;
    // Only ids the bridge actually reports as active are waited on. An id that is neither
    // running nor terminal is "unknown", not "finished": treating it as finished would let a
    // typo satisfy an all-wait instantly and report it as a settled task.
    const knownActive = new Set(running.map((task) => task.id));
    const activeIds = selection.ids.filter(
      (id) => knownActive.has(id) && !preTerminal.some((record) => record.id === id),
    );
    const unknownIds = selection.ids.filter((id) => !knownActive.has(id) && !preTerminal.some((record) => record.id === id));

    // Already-terminal selection: answer immediately, exactly like native bg_wait does for a
    // finished run. `all` still needs the rest; `any` is already satisfied.
    if (mode === "any" && preTerminal.length > 0) {
      return summarise({ mode, elapsedMs: 0, ids: selection.ids, terminal, preTerminal, outcome: { kind: "settled", reason: "any" }, missing: selection.missing, failed: false, failedIds: [] });
    }
    if (activeIds.length === 0) {
      if (preTerminal.length === 0) {
        const text =
          unknownIds.length > 0
            ? `No running or finished background task in this session matches: ${unknownIds.join(", ")}. Nothing to wait for.`
            : bridge.owned()
              ? "No background task of this session is running; nothing to wait for."
              : `No pi-background-tasks activation for this session is verified yet${bridge.lastError() ? ` (${bridge.lastError()})` : ""}; nothing to wait for.`;
        return { text, failed: false, failedIds: [] };
      }
      const failedIds = preTerminal.filter((record) => record.status === "failed").map((record) => record.id);
      const killedIds = preTerminal.filter((record) => record.status === "killed").map((record) => record.id);
      return summarise({ mode, elapsedMs: 0, ids: selection.ids, terminal, preTerminal, outcome: { kind: "settled", reason: "all" }, missing: selection.missing, failed: failedIds.length + killedIds.length > 0, failedIds: [...failedIds, ...killedIds] });
    }

    const startedAt = now();
    let nativeNote = "";
    const nativePromise = input.includeNative && deps.nativeWait
      ? deps.nativeWait({ all: true, stopOnAttention: input.stopOnAttention ?? true, timeoutMs }, signal, undefined).then(
          (text) => {
            nativeNote = text;
          },
          (error: unknown) => {
            nativeNote = `native bg_wait nested call failed: ${error instanceof Error ? error.message : String(error)}`;
          },
        )
      : undefined;

    const outcome: WaitOutcome = await waitForWork(
      { taskIds: activeIds },
      {
        mode,
        timeoutMs,
        signal,
        userInputSignal,
        stopOnAttention: input.stopOnAttention ?? true,
        onTick: ({ elapsedMs, active }) => {
          onUpdate?.({
            text: `Waiting on ${String(active.length)} background task(s) for ${formatDuration(elapsedMs)}: ${active.join(", ")}`,
          });
        },
      },
      {
        events: deps.events,
        now: deps.now,
        activeIds: () => bridge.running().map((task) => task.id),
        terminals: () => bridge.terminal(),
        ...(deps.providers ? { providers: deps.providers } : {}),
        ...(deps.hasSupervisorRequest ? { hasSupervisorRequest: deps.hasSupervisorRequest } : {}),
        ...(deps.subscribe ? { subscribe: deps.subscribe } : {}),
        wakeChannels: [BG_TERMINAL_CHANNEL, HOST_CHANGED_CHANNEL, SUBAGENT_CONTROL_CHANNEL],
      },
    );

    if (nativePromise) await Promise.race([nativePromise, Promise.resolve()]);

    const elapsedMs = now() - startedAt;
    const finalTerminal = bridge.terminal();
    // Completion-notification coordination: a task launched with triggerOnCompletion:true
    // also starts a follow-up turn. Its notification is never suppressed or rewritten here;
    // the risk is reported so a second continuation cannot be mistaken for new work.
    const policies = selection.ids.map((id) => {
      const policy = bridge.policyOf(id);
      return policy ? { id, ...policy } : undefined;
    });
    const coordination = analyseCompletionPolicy(policies.filter((entry): entry is { id: string; notifyOnCompletion: boolean; triggerOnCompletion: boolean } => entry !== undefined));
    const failedIds = finalTerminal
      .filter((record) => selection.ids.includes(record.id) && record.status === "failed")
      .map((record) => record.id);
    const killedIds = finalTerminal
      .filter((record) => selection.ids.includes(record.id) && record.status === "killed")
      .map((record) => record.id);
    const allFailedIds = [...new Set([...failedIds, ...killedIds])];

    return summarise({
      mode,
      elapsedMs,
      ids: selection.ids,
      terminal: finalTerminal,
      preTerminal,
      outcome,
      missing: selection.missing,
      failed: allFailedIds.length > 0,
      failedIds: allFailedIds,
      nativeNote,
      coordinationLines: coordination.lines,
    });
  };
}

interface SummariseInput {
  mode: "all" | "any";
  elapsedMs: number;
  ids: readonly string[];
  terminal: readonly TerminalRecord[];
  preTerminal: readonly TerminalRecord[];
  outcome: WaitOutcome;
  missing: readonly string[];
  failed: boolean;
  failedIds: readonly string[];
  nativeNote?: string;
  coordinationLines?: readonly string[];
}

function summarise(input: SummariseInput): UnifiedToolResult {
  const records = new Map<string, TerminalRecord>();
  for (const record of input.preTerminal) records.set(record.id, record);
  for (const record of input.terminal) if (input.ids.includes(record.id) && !records.has(record.id)) records.set(record.id, record);
  const lines: string[] = [];
  const finished = [...records.values()];
  const stillRunning = input.ids.filter((id) => !records.has(id));

  switch (input.outcome.kind) {
    case "settled":
      lines.push(
        input.mode === "any"
          ? `Waited ${formatDuration(input.elapsedMs)}; first completion reached.`
          : `Waited ${formatDuration(input.elapsedMs)} for ${String(input.ids.length)} background task(s); all settled.`,
      );
      break;
    case "timeout":
      lines.push(
        `Wait window elapsed after ${formatDuration(input.elapsedMs)} with ${String(stillRunning.length)} task(s) still running: ${stillRunning.join(", ")}. The work keeps going; call bg_wait_unified again.`,
      );
      break;
    case "user_input":
      lines.push(`Wait ended after ${formatDuration(input.elapsedMs)} because the user sent a new message. Work keeps running.`);
      break;
    case "supervisor_request":
      lines.push(`Wait ended after ${formatDuration(input.elapsedMs)} because a subagent needs a supervisor reply. Work keeps running.`);
      break;
    case "aborted":
      lines.push(`Wait aborted after ${formatDuration(input.elapsedMs)}.`);
      break;
    case "provider_disappeared":
      lines.push(
        `Wait ended after ${formatDuration(input.elapsedMs)}: background-work provider "${input.outcome.provider}" disappeared while this wait tracked its tasks, so completion cannot be confirmed.`,
      );
      break;
  }

  if (finished.length > 0) {
    lines.push("", "Results:");
    for (const record of finished) lines.push(`- ${describeTerminal(record)}`);
  }
  if (stillRunning.length > 0 && input.outcome.kind === "settled") {
    // Only reachable for `any`, where the rest of the selection keeps running by design.
    lines.push("", `Still running: ${stillRunning.join(", ")}`);
  }
  if (input.missing.length > 0) {
    lines.push("", `Not found in this session (never launched here, or already pruned): ${input.missing.join(", ")}`);
  }
  if (input.nativeNote) lines.push("", `Native wait: ${input.nativeNote}`);
  if (input.coordinationLines && input.coordinationLines.length > 0) {
    lines.push("", ...input.coordinationLines);
  }
  if (input.failed) {
    lines.push("", `Failure: ${input.failedIds.join(", ")} did not complete successfully.`);
  }

  return { text: lines.join("\n"), failed: input.failed, failedIds: [...input.failedIds] };
}
