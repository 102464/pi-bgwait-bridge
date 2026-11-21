/**
 * Generic request/response correlator over a Pi EventBus.
 *
 * Both pi-background-tasks surfaces are "emit a closed request frame, listen for a response
 * frame that echoes `request_id`" protocols with no return channel of their own. This module
 * is the only place that turns that into a Promise.
 *
 * Settlement is guarded by a per-request `settled` flag, not by map membership: the response
 * handler removes the entry before settling, so a map-membership check would drop the result
 * and leave the caller waiting for its timeout (observed as an 8s hang in the first test run).
 */
import type { EventBusLike } from "./types.ts";

export interface RequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal | undefined;
  /**
   * Filter for response frames. Returning `false` ignores that frame and keeps waiting.
   *
   * Needed because several pi-background-tasks activations can share one Pi-process
   * EventBus (pi-subagents' runner hosts child sessions in one process): every activation
   * answers the same host request channel, so a request may receive more than one response.
   * Ignoring a foreign frame is different from failing on it — failing would abandon a
   * request our own activation is about to answer.
   */
  readonly accept?: (frame: Record<string, unknown>) => boolean;
  /** Called for every frame `accept` rejects, so a caller can name the cause on timeout. */
  readonly onRejected?: (frame: Record<string, unknown>) => void;
}

export type RequestSettlement =
  | { ok: true; frame: Record<string, unknown> }
  | { ok: false; error: string; timedOut?: boolean };

export interface RequestClient {
  request(
    requestChannel: string,
    responseChannel: string,
    frame: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<RequestSettlement>;
  /** Number of unresolved round trips; used by tests to assert no leaks. */
  pendingCount(): number;
  dispose(): void;
}

interface PendingEntry {
  settled: boolean;
  accept?: ((frame: Record<string, unknown>) => boolean) | undefined;
  reject?: ((frame: Record<string, unknown>) => void) | undefined;
  timer: ReturnType<typeof setTimeout>;
  finish: (value: RequestSettlement) => void;
}

let counter = 0;

export function makeRequestId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createRequestClient(events: EventBusLike, defaultTimeoutMs: number): RequestClient {
  const pending = new Map<string, PendingEntry>();
  const subscriptions = new Map<string, () => void>();

  function ensureSubscription(responseChannel: string): void {
    if (subscriptions.has(responseChannel)) return;
    subscriptions.set(
      responseChannel,
      events.on(responseChannel, (data: unknown) => {
        if (!data || typeof data !== "object") return;
        const frame = data as Record<string, unknown>;
        const requestId = frame["request_id"];
        if (typeof requestId !== "string") return;
        const entry = pending.get(requestId);
        if (!entry || entry.settled) return;
        if (entry.accept && !entry.accept(frame)) {
          entry.reject?.(frame);
          return;
        }
        // Frame-level success/failure stays inside the frame: callers need the typed
        // `error.code` (LEASE_INVALID, ACTIVATION_MISMATCH) to decide whether to resubscribe.
        // `ok: false` here means transport failure only.
        entry.finish({ ok: true, frame });
      }),
    );
  }

  return {
    request(requestChannel, responseChannel, frame, options) {
      ensureSubscription(responseChannel);
      const requestId = frame["request_id"];
      if (typeof requestId !== "string" || requestId.length === 0) {
        return Promise.resolve({ ok: false, error: "request frame needs a non-empty request_id" });
      }
      const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
      if (options?.signal?.aborted) return Promise.resolve({ ok: false, error: "request aborted" });

      return new Promise<RequestSettlement>((resolve) => {
        const entry: PendingEntry = {
          settled: false,
          ...(options?.accept ? { accept: options.accept } : {}),
          ...(options?.onRejected ? { reject: options.onRejected } : {}),
          timer: undefined as unknown as ReturnType<typeof setTimeout>,
          finish: (value) => resolve(value),
        };
        const finish = (value: RequestSettlement) => {
          if (entry.settled) return;
          entry.settled = true;
          pending.delete(requestId);
          clearTimeout(entry.timer);
          options?.signal?.removeEventListener("abort", onAbort);
          resolve(value);
        };
        entry.finish = finish;
        const onAbort = () => finish({ ok: false, error: "request aborted" });
        const timer = setTimeout(() => {
          finish({ ok: false, error: `no response on ${responseChannel} within ${timeoutMs}ms`, timedOut: true });
        }, timeoutMs);
        entry.timer = timer;
        if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
        options?.signal?.addEventListener("abort", onAbort, { once: true });
        pending.set(requestId, entry);
        try {
          events.emit(requestChannel, frame);
        } catch (error) {
          finish({ ok: false, error: `request emit failed: ${error instanceof Error ? error.message : String(error)}` });
        }
      });
    },

    pendingCount() {
      return pending.size;
    },

    dispose() {
      for (const entry of pending.values()) {
        entry.settled = true;
        clearTimeout(entry.timer);
      }
      pending.clear();
      for (const unsubscribe of subscriptions.values()) {
        try {
          unsubscribe();
        } catch {
          /* best effort */
        }
      }
      subscriptions.clear();
    },
  };
}
