/**
 * Signals that must end `bg_wait_unified` (operator requirement, 2026-11-22):
 *
 *  1. `attention` — any `needs_attention` control event for a run of *this* session.
 *  2. `intercom` — a control notice another agent routed to this session over intercom
 *     (`subagent:control-intercom`), i.e. a message waiting to be read.
 *  3. `supervisor_request` — a real outstanding ask; that one is answered by
 *     `src/supervisor-probe.ts` from pi-subagents' own request files, because it has a
 *     lifecycle (`requestLifecycle`, native-supervisor-channel.js:446-458) while a bus event
 *     does not.
 *
 * Why a bus capture at all: native `bg_wait` ends on attention only when the caller opts in
 * with `stopOnAttention:true` (subagent-wait.js:638), and it never ends on an intercom notice
 * that is not accompanied by attention. A unified wait that reported `done` while a child had
 * thrown an attention notice (run `b543226f…`, `tool_open_threshold` after a 240 s `bash`) was
 * therefore *correctly* done by native rules and still wrong for the operator.
 *
 * Why "since arm" instead of "is attention pending": native's pre-existing-attention check is
 * what returned `attention required` 7 ms into a wait for a healthy 40-minute run (the
 * regression fixed by defaulting `stopOnAttention` to false). A signal only ends the wait when
 * it is *observed during* the wait, so a stale flag on a still-running child cannot cut a fresh
 * wait short. A pre-existing supervisor request is still a barrier, from the probe.
 *
 * Ownership: a control event names the run it came from. Run records live at
 * `<asyncDir>/status.json` and carry the launching `sessionId` (the session file, observed)
 * — the same fact upstream uses to attribute runs (`requestMatchesOwner`,
 * native-supervisor-channel.js:363-380). A notice whose run is not ours is dropped rather than
 * merged: this process can host several Pi sessions, and an attention notice from a sibling
 * session must not end this session's wait.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SUBAGENT_CONTROL_CHANNEL, SUBAGENT_CONTROL_INTERCOM_CHANNEL } from "./constants.ts";
import { resolveSubagentTempRoot } from "./supervisor-probe.ts";
import type { EventBusLike } from "./types.ts";

export type SubagentSignalKind = "attention" | "intercom" | "intercom_ask";

/**
 * An unanswered pi-intercom ask addressed to this session, read from pi-intercom's own
 * ledger (`src/intercom-probe.ts`). It has no Pi message event behind it while the wait
 * blocks, so it is carried as its own signal kind rather than as `intercom`.
 */
export interface PendingIntercomAsk {
  messageId: string;
  asker: string;
  question: string;
  createdAt: number;
}

export interface SubagentSignal {
  kind: SubagentSignalKind;
  /** Run that raised the notice; the wait reports it so the caller can inspect it. */
  runId: string;
  agent: string;
  /** pi-subagents' reason for a `needs_attention` event (`tool_open_threshold`, `tool_failures`, …). */
  reason?: string | undefined;
  /** Upstream's one-line signal, e.g. `rtl-engineer has had tool 'bash' open for 240s`. */
  message?: string | undefined;
  currentTool?: string | undefined;
  /** Intercom delivery target and body, when the notice was routed over intercom. */
  to?: string | undefined;
  intercomMessage?: string | undefined;
  /** Ask id and verbatim question, when the signal came from pi-intercom's ask ledger. */
  messageId?: string | undefined;
  question?: string | undefined;
  source: "control-event" | "control-intercom" | "intercom-ask";
  observedAt: number;
}

/**
 * One async run of this session that is still live, as its own `status.json` reports it.
 *
 * The unified progress line counts this, because provider items (the native half's own snapshot)
 * cover only what native `bg_wait` contributes and would otherwise print `0 async run(s)` while
 * a subagent is plainly still working.
 */
export interface ActiveSubagentRun {
  runId: string;
  /** `agent: currentTool` lines for the run's active steps, the same shape native prints. */
  activity: readonly string[];
}
export interface SubagentSignalCaptureOptions {
  events: EventBusLike;
  /** This session's accepted identities (runtime id and/or session file). */
  sessionIds: () => readonly string[];
  /** Override the temp root that holds `async-subagent-runs/` (tests). */
  tempRoot?: string;
  now?: () => number;
  log?: (line: string) => void;
  /**
   * Outstanding pi-intercom ask addressed to this session, or `undefined`. Polled on the wait
   * loop's own tick; an ask created before `arm` never counts, exactly like a bus signal.
   */
  pendingAsk?: () => PendingIntercomAsk | undefined;
}

export interface SubagentSignalCapture {
  /** Observe from now on; a signal already on the bus before this call never counts. */
  arm(listener: () => void): () => void;
  /** First signal observed since `arm`, if any. */
  pending(): SubagentSignal | undefined;
  /** Everything observed since `arm`, oldest first, for reporting. */
  all(): readonly SubagentSignal[];
  /** Live async runs of this session, read from pi-subagents' own run records. */
  activeRuns(): readonly ActiveSubagentRun[];
  /** True while the capture is observing. */
  armed(): boolean;
  /**
   * Record an intercom message another agent injected into this session's conversation.
   * `intercom({action:"send"|"ask", to})` delivers as a `customType:"intercom_message"`
   * message (pi-intercom `index.ts:1325-1340`) and emits no control event, so a wait that
   * only listened to the subagent bus would see a blocking ask as silence. Returns nothing;
   * a capture that is not armed ignores it.
   */
  observeIntercomMessage(message: { customType?: unknown; details?: unknown; content?: unknown }): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compare session identities across the two forms pi-subagents writes (raw vs path). */
function sameSessionIdentity(a: string, b: string): boolean {
  if (a === b) return true;
  const normalize = (value: string): string => value.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
  return normalize(a) === normalize(b);
}

export function createSubagentSignalCapture(options: SubagentSignalCaptureOptions): SubagentSignalCapture {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  /** Per-run ownership verdicts: a run's launching session never changes. */
  const owned = new Map<string, boolean>();
  let observed: SubagentSignal[] = [];
  let armedAt = -1;
  const runsRoot = path.join(options.tempRoot ?? resolveSubagentTempRoot(), "async-subagent-runs");
  /** Active states, from pi-subagents' own `ACTIVE_STATES` (subagent-wait.js:53). */
  const ACTIVE_RUN_STATES = new Set(["queued", "running"]);
  const MAX_RUN_DIRS = 64;
  /** How a step's own `activityState` is shown: its live tool, else queued, else thinking. */
  function stepActivity(step: Record<string, unknown>): string | undefined {
    const agent = typeof step["agent"] === "string" ? step["agent"] : undefined;
    if (agent === undefined) return undefined;
    const tool = typeof step["currentTool"] === "string" && step["currentTool"].length > 0 ? step["currentTool"] : undefined;
    const status = typeof step["status"] === "string" ? step["status"] : undefined;
    return `${agent}: ${tool ?? (status === "pending" ? "queued" : "thinking…")}`;
  }
  function readActiveRuns(): ActiveSubagentRun[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(runsRoot, { withFileTypes: true });
    } catch {
      return []; // No runs yet: nothing live to count.
    }
    const runs: ActiveSubagentRun[] = [];
    let scanned = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || scanned >= MAX_RUN_DIRS) continue;
      scanned += 1;
      const dir = path.join(runsRoot, entry.name);
      // Ownership first: an unreadable or foreign record is not this session's live work.
      if (!ownsRun(dir)) continue;
      let status: unknown;
      try {
        status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
      } catch {
        continue; // pruned, or half-written during a write/replace
      }
      if (!isRecord(status)) continue;
      const state = typeof status["state"] === "string" ? status["state"] : undefined;
      if (state === undefined || !ACTIVE_RUN_STATES.has(state)) continue;
      const runId = typeof status["runId"] === "string" ? status["runId"] : entry.name;
      const steps = Array.isArray(status["steps"]) ? status["steps"].filter(isRecord) : [];
      const activity = steps
        .filter((step) => typeof step["status"] === "string" && (step["status"] === "pending" || step["status"] === "running"))
        .map(stepActivity)
        .filter((line): line is string => line !== undefined);
      runs.push({ runId, activity: activity.length > 0 ? activity : [`${runId}: ${state}`] });
    }
    return runs.sort((a, b) => a.runId.localeCompare(b.runId));
  }
  let unsubscribe: (() => void) | undefined;
  let listenerRef: (() => void) | undefined;

  function asyncDirOf(payload: Record<string, unknown>, agentDir?: string): string | undefined {
    const dir = payload["asyncDir"];
    if (typeof dir === "string" && dir.length > 0) return dir;
    return agentDir;
  }

  function ownsRun(asyncDir: string | undefined): boolean {
    if (asyncDir === undefined) return false; // nothing to attribute it to: drop, never guess
    const cached = owned.get(asyncDir);
    if (cached !== undefined) return cached;
    const accepted = options.sessionIds();
    if (accepted.length === 0) {
      owned.set(asyncDir, false);
      return false;
    }
    let verdict = false;
    try {
      const raw = fs.readFileSync(path.join(asyncDir, "status.json"), "utf8");
      const status: unknown = JSON.parse(raw);
      const sessionId = isRecord(status) ? status["sessionId"] : undefined;
      if (typeof sessionId === "string" && sessionId.length > 0) {
        verdict = accepted.some((identity) => sameSessionIdentity(identity, sessionId));
      }
    } catch {
      // A run directory that has been pruned or is half-written is not provably ours.
      verdict = false;
    }
    owned.set(asyncDir, verdict);
    return verdict;
  }

  function record(signal: SubagentSignal): void {
    observed.push(signal);
    log(`signal ${signal.kind} run=${signal.runId} agent=${signal.agent}${signal.reason ? ` reason=${signal.reason}` : ""}`);
  }

  function onControlEvent(data: unknown): void {
    if (!isRecord(data)) return;
    const event = data["event"];
    if (!isRecord(event)) return;
    // `active_long_running` is a "still working" notice, not a signal; attention is the ask.
    if (event["type"] !== "needs_attention") return;
    const runId = typeof event["runId"] === "string" ? event["runId"] : undefined;
    if (runId === undefined) return;
    // Native supervisor asks are the probe's job: they have a lifecycle this bus payload lacks.
    // They still count here as attention, which is what the operator asked for; the probe
    // additionally reports a *pre-existing* request before any event fires.
    if (!ownsRun(asyncDirOf(data))) return;
    record({
      kind: "attention",
      runId,
      agent: typeof event["agent"] === "string" ? event["agent"] : "subagent",
      reason: typeof event["reason"] === "string" ? event["reason"] : undefined,
      message: typeof event["message"] === "string" ? event["message"] : undefined,
      currentTool: typeof event["currentTool"] === "string" ? event["currentTool"] : undefined,
      source: "control-event",
      observedAt: now(),
    });
  }

  function onControlIntercom(data: unknown): void {
    if (!isRecord(data)) return;
    const event = data["event"];
    if (!isRecord(event)) return;
    const runId = typeof event["runId"] === "string" ? event["runId"] : undefined;
    if (runId === undefined) return;
    if (!ownsRun(asyncDirOf(data))) return;
    record({
      kind: "intercom",
      runId,
      agent: typeof event["agent"] === "string" ? event["agent"] : "subagent",
      reason: typeof event["reason"] === "string" ? event["reason"] : undefined,
      message: typeof event["message"] === "string" ? event["message"] : undefined,
      currentTool: typeof event["currentTool"] === "string" ? event["currentTool"] : undefined,
      to: typeof data["to"] === "string" ? data["to"] : undefined,
      intercomMessage: typeof data["message"] === "string" ? data["message"] : undefined,
      source: "control-intercom",
      observedAt: now(),
    });
  }

  return {
    arm(listener) {
      unsubscribe?.();
      observed = [];
      armedAt = now();
      listenerRef = listener;
      const offEvent = options.events.on(SUBAGENT_CONTROL_CHANNEL, (data) => {
        if (!isRecord(data) || !isRecord(data["event"])) return;
        if (data["event"]["type"] !== "needs_attention") return;
        onControlEvent(data);
        listener();
      });
      const offIntercom = options.events.on(SUBAGENT_CONTROL_INTERCOM_CHANNEL, (data) => {
        if (!isRecord(data) || !isRecord(data["event"])) return;
        onControlIntercom(data);
        listener();
      });
      unsubscribe = () => {
        offEvent();
        offIntercom();
        unsubscribe = undefined;
        listenerRef = undefined;
        armedAt = -1;
      };
      return unsubscribe;
    },
    armed: () => armedAt >= 0,
    pending() {
      if (armedAt < 0) return undefined;
      // A signal that arrived on the bus during this wait wins: it names the run it came from.
      const observedSoFar = observed.find((signal) => signal.observedAt >= armedAt);
      if (observedSoFar !== undefined) return observedSoFar;
      // Then the durable half: an ask another agent is still waiting on. pi-intercom keeps
      // its ledger record until the reply (or expiry), which is the only evidence that
      // survives a session that is busy inside a blocking tool call.
      const ask = options.pendingAsk?.();
      if (ask === undefined || ask.createdAt < armedAt) return undefined;
      return {
        kind: "intercom_ask",
        runId: ask.messageId,
        agent: ask.asker,
        messageId: ask.messageId,
        question: ask.question,
        source: "intercom-ask",
        observedAt: now(),
      };
    },
    all: () => observed.filter((signal) => armedAt >= 0 && signal.observedAt >= armedAt),
    activeRuns: readActiveRuns,
    observeIntercomMessage(message) {
      if (armedAt < 0) return;
      if (message.customType !== "intercom_message") return;
      const details = isRecord(message.details) ? message.details : undefined;
      const from = details && isRecord(details["from"]) ? details["from"] : undefined;
      record({
        kind: "intercom",
        runId: typeof details?.["message"] === "object" && isRecord(details["message"]) ? String(details["message"]["id"] ?? "intercom") : "intercom",
        agent: typeof from?.["name"] === "string" ? from["name"] : typeof from?.["id"] === "string" ? from["id"] : "intercom peer",
        source: "control-intercom",
        observedAt: now(),
      });
      listenerRef?.();
    },
  };
}
