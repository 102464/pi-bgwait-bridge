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
  DEFAULT_POLL_MS,
  DEFAULT_TIMEOUT_MS,
  HOST_CHANGED_CHANNEL,
  SUBAGENT_CONTROL_CHANNEL,
  SUBAGENT_CONTROL_INTERCOM_CHANNEL,
} from "./constants.ts";
import { analyseCompletionPolicy } from "./notification-coordination.ts";
import type { SubagentSignal } from "./subagent-signals.ts";
import type { SupervisorRequestDetail } from "./supervisor-probe.ts";
import { describeTerminal, formatDuration, waitForWork, type WaitOutcome } from "./wait-core.ts";
import type { ActiveSubagentRun } from "./subagent-signals.ts";
import { isTerminalStatus, type EventBusLike, type WaitTargetTask } from "./types.ts";

/**
 * Bus channels that can end this wait. Signals (attention, intercom) come from pi-subagents'
 * own control events; `BG_TERMINAL_CHANNEL`/`HOST_CHANGED_CHANNEL` are ordinary task state.
 */
const SIGNAL_CHANNELS = [
  BG_TERMINAL_CHANNEL,
  HOST_CHANGED_CHANNEL,
  SUBAGENT_CONTROL_CHANNEL,
  SUBAGENT_CONTROL_INTERCOM_CHANNEL,
];

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
  /** The outstanding request from its file, so the closing sentence can name it. */
  supervisorRequestDetail?: () => SupervisorRequestDetail | undefined;
  /**
   * A subagent signal captured during the wait (attention / intercom notice from another agent).
   * Native `bg_wait` never ends on one of these unless `stopOnAttention:true`, so the unified
   * wait owns the decision, and only for a run this session launched.
   */
  pendingSubagentSignal?: () => SubagentSignal | undefined;
  /**
   * Live async runs of this session, from pi-subagents' own run records. The progress line counts
   * them: the native half's provider items cover only what native `bg_wait` contributes, so a
   * subagent that is plainly still working would otherwise be reported as `0 async run(s)`.
   */
  activeRuns?: () => readonly ActiveSubagentRun[];
  /** Subscribe to local state changes (bridge.onChange). */
  subscribe?: (listener: () => void) => () => void;
  /** Wake the loop on a disk signal (intercom ledger, supervisor request files). */
  externalWake?: (wake: () => void) => () => void;
  /** Poll fallback interval; a test sets it high to prove a wake does not come from a tick. */
  pollIntervalMs?: number;
  /**
   * Called on every wait tick with a `mutating` flag that turns true exactly once per wait.
   *
   * This is not part of the wait semantics. It exists because a live scenario has to act
   * *during* a blocking wait (route an intercom ask from a sibling session, write a supervisor
   * request file), and the progress tick is the only code that runs periodically inside the
   * wait. Nothing is scheduled without a consumer opting in.
   */
  onProgress?: (state: { elapsedMs: number; active: readonly string[]; mutating: boolean }) => void;
  /**
   * Nested native `bg_wait` call. Session-wide calls include the subagent scope through it
   * by default (see `wantsNativeScope`): the native tool owns async runs, and background task
   * ids are what this tool adds on top.
   */
  nativeWait?: (
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: (() => void) | undefined,
  ) => Promise<string>;
}

/**
 * Whether this call should also wait for the subagent scope.
 *
 * Explicit `ids` mean "exactly these background tasks", so the native scope stays out unless
 * `includeNative:true` asks for it. A session-wide call (`all`, `any`, or no ids) is the
 * unified case this tool exists for: after a reload the only waiting work may be a subagent,
 * and returning "no background task is running" for that would report nothing while a run is
 * live. So the native scope is included by default there.
 */
export function wantsNativeScope(input: BgWaitUnifiedInput): boolean {
  if (input.includeNative === false) return false;
  if (input.includeNative === true) return true;
  return !(input.ids !== undefined && input.ids.length > 0);
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
    const useNative = wantsNativeScope(input) && deps.nativeWait !== undefined;
    /**
     * What the native half should stop on.
     *
     * Native `bg_wait` treats `stopOnAttention:true` as "end on *any* needs_attention", not just
     * a supervisor ask (subagent-wait.js:638 short-circuits `hasSupervisorTool`). Its ordinary
     * sources are an open tool at 240 s and three consecutive tool failures
     * (runs/shared/subagent-control.js:9-12), so forwarding `true` by default made a healthy
     * long-running subagent end the wait after a few milliseconds.
     *
     * `false` is safe here: a real supervisor request is an unconditional barrier upstream
     * (subagent-wait.js:634-637), independent of `stopOnAttention`. Only an explicit
     * `stopOnAttention:true` opts into the wider native behaviour.
     */
    const nativeStopOnAttention = input.stopOnAttention === true;

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

    let nativeNote = "";
    let nativePending: Promise<void> | undefined;
    /**
     * The native half's lifetime is deliberately shorter than its own window.
     *
     * Its window is `timeoutMs`, and by contract a timeout ends the window, never the work —
     * so it would keep blocking for the whole window even after this tool has already decided
     * to return (a signal that ended the wait, a settled selection, an unknown id). Without
     * this the tool call stayed open for minutes after reporting its answer, which is exactly
     * the "ended, but the call did not come back" shape of the reported bug.
     */
    let nativeReleased = false;
    const nativeLifetime = new AbortController();
    const abortNative = (): void => {
      if (nativeLifetime.signal.aborted) return;
      nativeReleased = true;
      nativeLifetime.abort();
    };
    if (signal?.aborted === true) abortNative();
    else signal?.addEventListener("abort", abortNative, { once: true });
    // Started before any early return so the subagent scope is still covered when this
    // session has no background task of its own (the post-reload case).
    const startNative = (): void => {
      if (!useNative || nativePending) return;
      nativePending = Promise.resolve(
        deps.nativeWait?.(
          {
            ...(mode === "any" ? { all: false } : { all: true }),
            stopOnAttention: nativeStopOnAttention,
            timeoutMs,
          },
          nativeLifetime.signal,
          undefined,
        ),
      ).then(
        (text) => {
          const answer = text ?? "";
          // The native half reports "Wait aborted" when this tool released it after its own
          // answer; that is not an error, so it is not dressed up as one.
          nativeNote = nativeReleased && /^\s*Wait aborted/i.test(answer)
            ? "native bg_wait released when this wait ended, so the async-run scope keeps running."
            : answer;
        },
        (error: unknown) => {
          nativeNote = `native bg_wait nested call failed: ${error instanceof Error ? error.message : String(error)}`;
        },
      );
    };

    // One repaint per second, not one per poll tick: the renderer shows the same partial
    // result, so a faster cadence is pure noise. Native `bg_wait`'s own live status
    // (`asyncWaitUpdate`, subagent-wait.js:348-364) is the wording this mirrors.
    const UPDATE_INTERVAL_MS = DEFAULT_POLL_MS;
    let lastUpdateAt = -UPDATE_INTERVAL_MS;
    let lastUpdateText = "";
    let mutated = false;
    const emitSignalProgress = (elapsedMs: number, providerItems: number): void => {
      // A live scenario may need to act *during* this wait (route an intercom ask, write a
      // supervisor request file). This hook runs on every tick, so it is where such an action
      // is scheduled; `mutating` is true once per wait.
      const mutating = !mutated;
      mutated = true;
      if (onUpdate !== undefined && elapsedMs - lastUpdateAt >= UPDATE_INTERVAL_MS) {
        const runs = deps.activeRuns?.() ?? [];
        // Native wording, same nouns: `async run(s)` are async subagent runs only, and
        // `provider item(s)` are background tasks still running (subagent-wait.js:348-364).
        // Both are measured live — never an existence test (`deps.pendingSubagentSignal` is
        // always wired in production, so counting it printed a phantom run) and never a
        // fold of finished records into the run count.
        const parts = [
          `Waiting ${formatDuration(elapsedMs)} for ${String(runs.length)} async run(s) and ${String(providerItems)} provider item(s).`,
          ...runs.flatMap((run) => [...run.activity]),
          ...[...activeIdRef.value],
        ].filter((part) => part.length > 0);
        const text = parts.join(" · ");
        if (text !== lastUpdateText) {
          lastUpdateAt = elapsedMs;
          lastUpdateText = text;
          onUpdate({ text });
        }
      }
      deps.onProgress?.({ elapsedMs, active: [...activeIdRef.value], mutating });
    };
    const activeIdRef: { value: readonly string[] } = { value: [] };

    const preTerminal = selection.preTerminal;
    // Only ids the bridge actually reports as active are waited on. An id that is neither
    // running nor terminal is "unknown", not "finished": treating it as false would let a
    // typo satisfy an all-wait instantly and report it as a settled task.
    const knownActive = new Set(running.map((task) => task.id));
    const activeIds = selection.ids.filter(
      (id) => knownActive.has(id) && !preTerminal.some((record) => record.id === id),
    );
    const unknownIds = selection.ids.filter((id) => !knownActive.has(id) && !preTerminal.some((record) => record.id === id));
    activeIdRef.value = activeIds;
    /**
     * Background tasks native `bg_wait` counts as `provider item(s)`: the running items of
     * this scope, live. Finished records are never folded in, and an exact-id wait counts
     * only the ids it covers.
     */
    const providerItemCount = (): number =>
      input.ids !== undefined && input.ids.length > 0 ? activeIdRef.value.length : bridge.running().length;

    // Already-terminal selection: answer immediately, exactly like native bg_wait does for a
    // finished run. `all` still needs the rest; `any` is already satisfied.
    if (mode === "any" && preTerminal.length > 0) {
      return summarise({ mode, elapsedMs: 0, ids: selection.ids, terminal, preTerminal, outcome: { kind: "settled", reason: "any" }, missing: selection.missing, failed: false, failedIds: [] });
    }
    if (activeIds.length === 0) {
      if (preTerminal.length === 0 && selection.ids.length > 0) {
        const text =
          unknownIds.length > 0
            ? `No running or finished background task in this session matches: ${unknownIds.join(", ")}.`
            : "No background task of this session is running.";
        if (useNative) {
          startNative();
          await nativePending;
          return { text: joinNotes(text, nativeNote), failed: false, failedIds: [] };
        }
        return { text: `${text} Nothing to wait for.`, failed: false, failedIds: [] };
      }
      if (preTerminal.length === 0) {
        const noWork = bridge.owned()
          ? "No background task of this session is running; nothing to wait for."
          : `No pi-background-tasks activation for this session is verified yet${bridge.lastError() ? ` (${bridge.lastError()})` : ""}; nothing to wait for.`;
        if (!useNative) return { text: noWork, failed: false, failedIds: [] };
        // No background task, but a session-wide wait still covers async subagents: delegate
        // that scope to the native tool instead of claiming there is nothing to wait for — and
        // keep this tool's own loop alive beside it, because the three signals the operator
        // requires (attention, intercom, supervisor) are invisible to the native tool. Without
        // the loop the reported case — `all:true` in a session whose work is an async subagent —
        // would sit on the native half and never notice any of them.
        startNative();
        const emptyStartedAt = now();
        /**
         * The signal loop is kept alive only *while* there is something to observe, and the
         * native half's own answer ends it.
         *
         * Without this the loop rode out the whole window: `isDone()` returns `undefined`
         * whenever the id set is empty (`wait-core.ts:157`), so in the reported case (one
         * async subagent, no background task) the native half printed
         * `Waited 3m12s for 1 async run(s); done` and the tool stayed blocked until the
         * 40-minute window expired. The async scope native covers is settled the moment it
         * answers, so that answer is this loop's terminal condition.
         */
        const emptyLifetime = new AbortController();
        const forwardAbort = (): void => emptyLifetime.abort();
        if (signal?.aborted === true) forwardAbort();
        else signal?.addEventListener("abort", forwardAbort, { once: true });
        let nativeAnsweredFirst = false;
        const emptyLoop = waitForWork({ taskIds: [] }, { mode, timeoutMs, signal: emptyLifetime.signal, userInputSignal, onTick: ({ elapsedMs }) => { emitSignalProgress(elapsedMs, 0); }, holdEmptyScope: true }, {
          events: deps.events,
          now: deps.now,
          activeIds: () => bridge.running().map((task) => task.id),
          terminals: () => bridge.terminal(),
          ...(deps.providers ? { providers: deps.providers } : {}),
          ...(deps.hasSupervisorRequest ? { hasSupervisorRequest: deps.hasSupervisorRequest } : {}),
          ...(deps.supervisorRequestDetail ? { supervisorRequestDetail: deps.supervisorRequestDetail } : {}),
          ...(deps.pendingSubagentSignal ? { pendingSubagentSignal: deps.pendingSubagentSignal } : {}),
          ...(deps.subscribe ? { subscribe: deps.subscribe } : {}),
          ...(deps.externalWake ? { externalWake: deps.externalWake } : {}),
          ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
          wakeChannels: SIGNAL_CHANNELS,
        });
        const emptyOutcome = await Promise.race([
          emptyLoop,
          // `nativePending` resolves with the native half's text, success or failure: either
          // way its scope is settled, so this loop has no further work to observe.
          (nativePending ?? Promise.resolve()).then((): "native" => "native"),
        ]);
        /**
         * Only a *settled* answer from the native half ends this loop: `; done`, `Nothing to
         * wait for`, or its own release note. Its window running out (`…; timeout`) does not —
         * that answer carries no information about the work, and treating it as terminal would
         * drop the signal this loop exists to observe (the row that caught it had native answer
         * `timeout` at once while the attention notice arrived 60 ms later).
         *
         * This is also what fixes the operator's idle-session report: `all:true` in a session
         * with no work used to print `Waiting 5m11s for 0 async run(s) and 0 provider item(s).`
         * because an empty id scope is never "done" by state (`wait-core.ts:157`). Native
         * `bg_wait` answers that session with `Nothing to wait for` at once, and that answer is
         * settled, so the loop now ends with it instead of riding out a 20-minute window.
         */
        const nativeSaysDone = isDoneAnswer(nativeNote);
        if (emptyOutcome === "native" && nativeSaysDone) {
          nativeAnsweredFirst = true;
          emptyLifetime.abort(); // wakes the loop; its outcome is then discarded below
        }
        const loopOutcome = emptyOutcome === "native" ? await emptyLoop : emptyOutcome;
        signal?.removeEventListener("abort", forwardAbort);
        abortNative();
        if (nativePending) await nativePending;
        if (!nativeAnsweredFirst && (loopOutcome.kind === "aborted" || loopOutcome.kind === "timeout")) {
          // The loop ended on its own (tool abort or window): report that, not the native text.
          return {
            text: joinNotes("No background task of this session is running.", nativeNote || "Native wait returned no text."),
            failed: loopOutcome.kind === "aborted",
            failedIds: [],
          };
        }
        /**
         * A signal ends the wait even when the native half already answered `timeout`: the
         * operator's requirement is that attention / intercom / supervisor ends the wait,
         * and native's window expiring carries no information about the work.
         */
        if (!nativeAnsweredFirst && (loopOutcome.kind === "subagent_signal" || loopOutcome.kind === "supervisor_request")) {
          const ended = summarise({
            mode,
            elapsedMs: now() - emptyStartedAt,
            ids: [],
            terminal,
            preTerminal,
            outcome: loopOutcome,
            missing: selection.missing,
            failed: false,
            failedIds: [],
            nativeNote,
          });
          // `summarise` already appends the native note; adding it here too printed it twice.
          return { ...ended, text: `No background task of this session is running.\n\n${ended.text}` };
        }
        return {
          text: joinNotes("No background task of this session is running.", nativeNote || "Native wait returned no text."),
          failed: false,
          failedIds: [],
        };
      }
      const failedIds = preTerminal.filter((record) => record.status === "failed").map((record) => record.id);
      const killedIds = preTerminal.filter((record) => record.status === "killed").map((record) => record.id);
      const settled = summarise({ mode, elapsedMs: 0, ids: selection.ids, terminal, preTerminal, outcome: { kind: "settled", reason: "all" }, missing: selection.missing, failed: failedIds.length + killedIds.length > 0, failedIds: [...failedIds, ...killedIds] });
      if (useNative) {
        startNative();
        await nativePending;
        return { ...settled, text: joinNotes(settled.text, nativeNote) };
      }
      return settled;
    }

    const startedAt = now();
    startNative();


    // Progress cadence/wording come from `emitSignalProgress` above; the per-wait text differs
    // only in the still-running ids it appends, which are this wait's own task ids.

    const outcome: WaitOutcome = await waitForWork(
      { taskIds: activeIds },
      {
        mode,
        timeoutMs,
        signal,
        userInputSignal,
        onTick: ({ elapsedMs }) => {
          emitSignalProgress(elapsedMs, providerItemCount());
        },
      },
      {
        events: deps.events,
        now: deps.now,
        activeIds: () => bridge.running().map((task) => task.id),
        terminals: () => bridge.terminal(),
        ...(deps.providers ? { providers: deps.providers } : {}),
        ...(deps.hasSupervisorRequest ? { hasSupervisorRequest: deps.hasSupervisorRequest } : {}),
        ...(deps.supervisorRequestDetail ? { supervisorRequestDetail: deps.supervisorRequestDetail } : {}),
        ...(deps.pendingSubagentSignal ? { pendingSubagentSignal: deps.pendingSubagentSignal } : {}),
        ...(deps.subscribe ? { subscribe: deps.subscribe } : {}),
        ...(deps.externalWake ? { externalWake: deps.externalWake } : {}),
        ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
        wakeChannels: SIGNAL_CHANNELS,
      },
    );

    // This tool has its answer. Abort the native half instead of waiting out its window: the
    // async-run scope it covers is already settled for this wait, and leaving it blocking
    // would hold the tool call open long after the returned text.
    abortNative();
    if (nativePending) await nativePending;
    signal?.removeEventListener("abort", abortNative);

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

/**
 * Whether the nested native `bg_wait` answer means "the async scope is settled".
 *
 * Native prints `Waited <duration> for N async run(s) and M provider item(s); done` when the
 * wait settled, and `; timeout` / `; aborted` when its own window or an abort ended it. Only
 * the settled form may end the unified wait's empty-scope loop: a `timeout` carries no
 * information about the work, and the loop still has three signals to observe.
 */
function isDoneAnswer(nativeText: string): boolean {
  const text = nativeText.trim();
  /**
   * The native tool's settled wordings, each captured from a real session:
   *   all   → `Waited 37m1s for 1 async run(s); done. Outcome: 1 complete.`
   *   any   → `Waited 22.1s; 1 of 1 run(s) finished. Outcome: 1 complete.` / `No runs remain in flight.`
   *   idle  → `No active async runs or registered provider work in this session. Nothing to wait for.`
   *   release → `… released when this wait ended, so the async-run scope keeps running.`
   *
   * A `;`-suffix heuristic is not enough: the any-mode answer ends with a trailing advisory
   * (`…observed; inspect status if a notification is not visible yet.`), so the last `;` is not
   * the outcome marker and the loop rode out its whole window after the subagent had finished.
   */
  if (/nothing to wait for/i.test(text)) return true;
  if (/released when this wait ended/i.test(text)) return true;
  if (/;\s*done\b/i.test(text)) return true;
  if (/\d+\s+of\s+\d+\s+run\(s\)\s+finished/i.test(text)) return true;
  if (/no runs remain in flight/i.test(text)) return true;
  // `; timeout`, `Wait window elapsed …` and `still active` carry no information about the work.
  return false;
}

function joinNotes(primary: string, secondary: string): string {
  return secondary.length > 0 ? `${primary}\n\nNative wait: ${secondary}` : primary;
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
    case "supervisor_request": {
      // The request id comes from the request file, not from the bus notice: it is the evidence
      // that the directory was read (the notice itself lands ~130 ms before the file exists).
      const request = input.outcome.request;
      const facts: string[] = [];
      if (request !== undefined) {
        facts.push(`request ${request.requestId}`);
        if (request.reason !== undefined) facts.push(`reason ${request.reason}`);
        if (request.runId !== undefined) facts.push(`run ${request.runId}`);
        if (request.agent !== undefined) facts.push(`from ${request.agent}`);
      }
      const detail = facts.length > 0 ? ` (${facts.join(", ")})` : "";
      lines.push(
        `Wait ended after ${formatDuration(input.elapsedMs)} because a subagent needs a supervisor reply${detail}. Work keeps running.`,
      );
      break;
    }
    case "subagent_signal": {
      const signal = input.outcome.signal;
      const detail = signal.message ? ` Signal: ${signal.message}.` : "";
      const reason = signal.reason ? ` (${signal.reason})` : "";
      if (signal.kind === "intercom_ask") {
        lines.push(
          `Wait ended after ${formatDuration(input.elapsedMs)} because ${signal.agent} is waiting for a reply over intercom (ask ${signal.runId}). Work keeps running.`,
        );
        if (signal.question) lines.push("", "Intercom ask:", signal.question);
        break;
      }
      lines.push(
        signal.kind === "intercom"
          ? `Wait ended after ${formatDuration(input.elapsedMs)} because ${signal.agent} sent an intercom message in run ${signal.runId}${reason}.${detail} Work keeps running.`
          : `Wait ended after ${formatDuration(input.elapsedMs)} because ${signal.agent} needs attention in run ${signal.runId}${reason}.${detail} Work keeps running.`,
      );
      if (signal.kind === "intercom" && signal.intercomMessage) {
        lines.push("", "Intercom notice:", signal.intercomMessage);
      }
      break;
    }
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
