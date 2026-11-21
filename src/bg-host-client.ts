/**
 * Host-API client for pi-background-tasks 2.6.10.
 *
 * Why the host surface instead of the extension surface:
 *  - `BgTaskSnapshot` (extension `status` and `terminal`) carries no sessionId, and the
 *    extension `status` operation returns *every* retained task of the activation
 *    (`registry.allTasks()`), so it cannot establish ownership.
 *  - The host surface's `subscribe` and every leased response carry
 *    `{ activationId, sessionId, revision, observedAt, counts }`, where `sessionId` is the
 *    activation's `ctx.sessionManager.getSessionId()` captured at `session_start`.
 *    That is the trusted launch record this bridge keys ownership on.
 *
 * Multiple activations can share one Pi-process EventBus (pi-subagents' background runner
 * hosts child sessions in a single process), so a response naming a different session is
 * rejected as a foreign activation rather than treated as ours.
 */
import { HOST_REQUEST_CHANNEL, HOST_RESPONSE_CHANNEL, HOST_REQUEST_SCHEMA } from "./constants.ts";
import { makeRequestId, type RequestClient } from "./eventbus-client.ts";
import type { EventBusLike, WaitTargetTask } from "./types.ts";

export interface HostFacts {
  activationId: string;
  sessionId: string;
  revision: number;
  observedAt: number;
}

export interface HostSubscription extends HostFacts {
  leaseId: string;
}

export interface HostTaskView {
  task: WaitTargetTask;
  kind?: string;
  seen?: boolean;
}

interface LeaseState {
  leaseId: string;
  activationId: string;
}

export interface HostClientOptions {
  events: EventBusLike;
  requests: RequestClient;
  /** Session identity forms accepted as ours: session file path and/or runtime session id. */
  sessionIds: readonly string[];
  clientId: string;
  now?: () => number;
}

export interface HostClient {
  /** Subscribe (or reuse the live lease) and return the activation's trusted facts. */
  subscribe(): Promise<HostSubscription>;
  /** Paged list of retained tasks of this activation. */
  list(options?: { limit?: number; maxPages?: number }): Promise<{ facts: HostFacts; tasks: WaitTargetTask[] }>;
  /** Exact id lookup; the host never resolves prefixes. */
  detail(taskId: string): Promise<{ facts: HostFacts; view: HostTaskView } | { error: string }>;
  hasLease(): boolean;
  reset(): void;
  dispose(): void;
}

/** The activation answering our requests belongs to another Pi session. */
export class ForeignActivationError extends Error {
  readonly reportedSessionId: string;
  constructor(reportedSessionId: string) {
    super(`host activation reports session ${reportedSessionId}; not this session`);
    this.name = "ForeignActivationError";
    this.reportedSessionId = reportedSessionId;
  }
}

const ERROR_HINTS: Record<string, string> = {
  UNAVAILABLE: "the background-task host has no initialized session context yet",
  ACTIVATION_MISMATCH: "host activation changed; resubscribed",
  LEASE_INVALID: "host lease is not valid in this activation",
  LEASE_LIMIT: "host lease limit reached (8 live leases per activation)",
  NOT_FOUND: "no retained background task has that exact id",
  TOO_LARGE: "host frame exceeded its 256 KiB bound",
  FOREIGN_ACTIVATION: "the answering activation belongs to another session",
};

/**
 * Ignore responses from another session's activation while waiting for our own.
 * pi-background-tasks installs one host service per extension activation, so N sessions in
 * one Pi process means N services listening on the same request channel. Only a frame whose
 * `sessionId` is one of ours (or an error frame, which has no session field) may settle
 * this request; anything else is another activation's answer and is skipped, not failed.
 */
function makeOwnFrameFilter(accepted: readonly string[]) {
  return (frame: Record<string, unknown>): boolean => {
    if (frame["ok"] === false) return true;
    const result = frame["result"];
    if (!result || typeof result !== "object") return true;
    const sessionId = (result as Record<string, unknown>)["sessionId"];
    if (typeof sessionId !== "string" || sessionId.length === 0) return true;
    return accepted.includes(sessionId);
  };
}

type CallResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string; code?: string; retryable: boolean };

export function createHostClient(options: HostClientOptions): HostClient {
  const now = options.now ?? Date.now;
  const accepted = [...options.sessionIds].filter((value) => value.length > 0);
  const accept = makeOwnFrameFilter(accepted);
  /** Session ids seen on frames we skipped because they are not ours. */
  const rejectedSessions = new Set<string>();
  function noteRejected(frame: Record<string, unknown>): void {
    const result = frame["result"];
    if (!result || typeof result !== "object") return;
    const sessionId = (result as Record<string, unknown>)["sessionId"];
    if (typeof sessionId === "string" && sessionId.length > 0) rejectedSessions.add(sessionId);
  }
  let lease: LeaseState | undefined;
  let sequence = 0;
  let disposed = false;

  async function call(operation: string, payload: Record<string, unknown>): Promise<CallResult> {
    if (disposed) return { ok: false, error: "host client disposed", retryable: false };
    rejectedSessions.clear();
    const response = await options.requests.request(
      HOST_REQUEST_CHANNEL,
      HOST_RESPONSE_CHANNEL,
      {
        schema_version: HOST_REQUEST_SCHEMA,
        request_id: makeRequestId("bgw-host"),
        operation,
        payload,
      },
      accepted.length > 0 ? { accept, onRejected: noteRejected } : undefined,
    );
    if (!response.ok) {
      // If the only answers on the channel came from other sessions' activations, say so
      // instead of reporting a bare timeout: that is the actionable diagnosis.
      if (response.timedOut && rejectedSessions.size > 0) {
        return {
          ok: false,
          error: `host activation reports session ${[...rejectedSessions].join(", ")}; not this session`,
          code: "FOREIGN_ACTIVATION",
          retryable: false,
        };
      }
      return { ok: false, error: response.error, retryable: Boolean(response.timedOut) };
    }
    const frame = response.frame;
    if (frame["ok"] === false) {
      const error = frame["error"];
      const code =
        error && typeof error === "object" ? String((error as Record<string, unknown>)["code"] ?? "") : "";
      const message =
        error && typeof error === "object"
          ? String((error as Record<string, unknown>)["message"] ?? JSON.stringify(error))
          : typeof error === "string"
            ? error
            : "host request failed";
      const retryable = code === "ACTIVATION_MISMATCH" || code === "LEASE_INVALID" || code === "UNAVAILABLE";
      if (code === "ACTIVATION_MISMATCH" || code === "LEASE_INVALID") lease = undefined;
      return { ok: false, error: `${ERROR_HINTS[code] ?? message}${code ? ` [${code}]` : ""}`, code, retryable };
    }
    const result = (frame["result"] ?? {}) as Record<string, unknown>;
    // Ownership is decided here, on the trusted launch record. An error frame from a foreign
    // activation is still rejected; a success frame from one is never merged into our scope.
    const reported = result["sessionId"];
    if (accepted.length > 0 && typeof reported === "string" && reported.length > 0 && !accepted.includes(reported)) {
      lease = undefined;
      return {
        ok: false,
        error: `host activation reports session ${reported}; not this session`,
        code: "FOREIGN_ACTIVATION",
        retryable: false,
      };
    }
    return { ok: true, result };
  }

  function factsOf(result: Record<string, unknown>): HostFacts {
    return {
      activationId: String(result["activationId"] ?? ""),
      sessionId: String(result["sessionId"] ?? ""),
      revision: Number(result["revision"] ?? 0),
      observedAt: Number(result["observedAt"] ?? now()),
    };
  }

  async function doSubscribe(): Promise<HostSubscription> {
    const response = await call("subscribe", { clientId: options.clientId });
    if (!response.ok) {
      if (response.code === "FOREIGN_ACTIVATION") throw new ForeignActivationError(response.error);
      throw new Error(`host subscribe failed: ${response.error}`);
    }
    const facts = factsOf(response.result);
    const leaseId = String(response.result["leaseId"] ?? "");
    if (!leaseId || !facts.activationId) throw new Error("host subscribe returned no lease");
    if (accepted.length > 0 && !accepted.includes(facts.sessionId)) {
      throw new ForeignActivationError(facts.sessionId);
    }
    lease = { leaseId, activationId: facts.activationId };
    sequence = 0;
    return { ...facts, leaseId };
  }

  async function ensureLease(): Promise<LeaseState> {
    if (lease) return lease;
    await doSubscribe();
    if (!lease) throw new Error("host lease unavailable");
    return lease;
  }

  /**
   * Run one leased operation, retrying once against a fresh lease when the activation or
   * lease changed (a reload between two snapshots is the normal case).
   */
  async function leased(
    operation: string,
    buildPayload: (live: LeaseState, seq: number) => Record<string, unknown>,
  ): Promise<CallResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const live = await ensureLease();
      sequence += 1;
      const response = await call(operation, buildPayload(live, sequence));
      if (response.ok) return response;
      if (!response.retryable) return response;
      lease = undefined;
    }
    return { ok: false, error: `host ${operation} failed after resubscribe`, retryable: false };
  }

  const client: HostClient = {
    subscribe: doSubscribe,

    async list(listOptions) {
      const limit = Math.min(listOptions?.limit ?? 50, 50);
      const maxPages = listOptions?.maxPages ?? 8;
      const tasks: WaitTargetTask[] = [];
      let facts: HostFacts = { activationId: "", sessionId: "", revision: 0, observedAt: now() };
      let cursor: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const response = await leased("list", (live, seq) => ({
          leaseId: live.leaseId,
          activationId: live.activationId,
          sequence: seq,
          limit,
          ...(cursor !== undefined ? { cursor } : {}),
        }));
        if (!response.ok) throw new Error(`host list failed: ${response.error}`);
        facts = factsOf(response.result);
        const views = response.result["tasks"];
        if (Array.isArray(views)) {
          for (const view of views) {
            const task = (view as HostTaskView | undefined)?.task;
            if (task && typeof task.id === "string") tasks.push(task);
          }
        }
        const next = response.result["nextCursor"];
        if (typeof next !== "string" || next.length === 0) return { facts, tasks };
        cursor = next;
      }
      return { facts, tasks };
    },

    async detail(taskId) {
      const response = await leased("detail", (live, seq) => ({
        leaseId: live.leaseId,
        activationId: live.activationId,
        sequence: seq,
        taskId,
      }));
      if (!response.ok) return { error: response.error };
      const view = response.result["task"];
      if (!view || typeof view !== "object") return { error: "host detail returned no task view" };
      return { facts: factsOf(response.result), view: view as HostTaskView };
    },

    hasLease: () => lease !== undefined,

    reset() {
      lease = undefined;
    },

    dispose() {
      disposed = true;
      lease = undefined;
    },
  };

  return client;
}
