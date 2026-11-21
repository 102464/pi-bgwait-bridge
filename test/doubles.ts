/**
 * Test doubles: a Pi-style EventBus and a pi-background-tasks host service that speaks the
 * exact closed frames of `pi-background-tasks:host:*:v1` (2.6.10).
 *
 * The host double implements only what the bridge consumes: `subscribe`, `list`, `detail`.
 * Frame validation mirrors the real service's closed-object rules so a malformed request
 * fails loudly in tests instead of silently passing.
 */
import { HOST_CHANGED_CHANNEL, HOST_REQUEST_CHANNEL, HOST_RESPONSE_CHANNEL } from "../src/constants.ts";

export interface DoubleTask {
  id: string;
  name?: string;
  command: string;
  status: "running" | "queued" | "completed" | "failed" | "killed";
  startTime: number;
  endTime?: number;
  exitCode?: number | null;
  error?: string;
  outputPath?: string;
  isAgent?: boolean;
  notifyOnCompletion?: boolean;
  triggerOnCompletion?: boolean;
}

export class FakeEventBus {
  readonly channels = new Map<string, Set<(data: unknown) => void>>();
  readonly emitted: { channel: string; data: unknown }[] = [];

  on(channel: string, handler: (data: unknown) => void): () => void {
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  emit(channel: string, data: unknown): void {
    this.emitted.push({ channel, data });
    const set = this.channels.get(channel);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(data);
      } catch {
        /* a throwing subscriber must not break the bus */
      }
    }
  }

  listenerCount(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }
}

export interface FakeHostOptions {
  sessionId: string;
  /** Answer as a different session, to exercise the ownership refusal path. */
  answerWithSessionId?: string;
  /** Start with no host activation (load-order race). */
  offline?: boolean;
}

/**
 * A host double. `tasks` is the retained list for its activation; `activationId` changes
 * on `simulateReload()`.
 */
export class FakeBackgroundTaskHost {
  readonly bus: FakeEventBus;
  readonly sessionId: string;
  readonly answerWithSessionId: string;
  tasks: DoubleTask[] = [];
  activationId = "act-1";
  revision = 0;
  observedAt = 0;
  live = true;
  private leases = new Map<string, { clientId: string; sequence: number }>();
  private requestCount = 0;
  readonly requests: { operation: string; payload: Record<string, unknown> }[] = [];

  constructor(bus: FakeEventBus, options: FakeHostOptions) {
    this.bus = bus;
    this.sessionId = options.sessionId;
    this.answerWithSessionId = options.answerWithSessionId ?? options.sessionId;
    this.live = options.offline !== true;
    bus.on(HOST_REQUEST_CHANNEL, (data) => this.handle(data));
  }

  private nextRequestId(): string {
    this.requestCount += 1;
    return `req-${this.requestCount}`;
  }

  private respond(frame: Record<string, unknown>): void {
    if (!this.live) return;
    this.bus.emit(HOST_RESPONSE_CHANNEL, frame);
  }

  private facts(): Record<string, unknown> {
    return {
      activationId: this.activationId,
      sessionId: this.answerWithSessionId,
      revision: this.revision,
      observedAt: this.observedAt,
    };
  }

  private handle(data: unknown): void {
    if (!this.live) return;
    if (!data || typeof data !== "object") return;
    const frame = data as Record<string, unknown>;
    const requestId = String(frame["request_id"] ?? "");
    const operation = String(frame["operation"] ?? "");
    const payload = (frame["payload"] ?? {}) as Record<string, unknown>;
    this.requests.push({ operation, payload });
    if (frame["schema_version"] !== "pi-background-tasks.host-request.v1") {
      this.respond({ schema_version: "pi-background-tasks.host-response.v1", request_id: requestId, operation, ok: false, error: { code: "INVALID_REQUEST", message: "bad schema_version" } });
      return;
    }
    switch (operation) {
      case "subscribe": {
        const clientId = payload["clientId"];
        if (typeof clientId !== "string" || clientId.length === 0) {
          this.respond({ schema_version: "pi-background-tasks.host-response.v1", request_id: requestId, operation, ok: false, error: { code: "INVALID_REQUEST", message: "clientId" } });
          return;
        }
        let leaseId = [...this.leases.entries()].find(([, value]) => value.clientId === clientId)?.[0];
        if (leaseId === undefined) {
          leaseId = `lease-${String(this.leases.size + 1)}`;
          this.leases.set(leaseId, { clientId, sequence: 0 });
        }
        this.respond({
          schema_version: "pi-background-tasks.host-response.v1",
          request_id: requestId,
          operation,
          ok: true,
          result: { ...this.facts(), leaseId },
        });
        return;
      }
      case "list":
      case "detail": {
        const leaseId = String(payload["leaseId"] ?? "");
        const lease = this.leases.get(leaseId);
        if (!lease) {
          this.respond({ schema_version: "pi-background-tasks.host-response.v1", request_id: requestId, operation, ok: false, error: { code: "LEASE_INVALID", message: "unknown lease" } });
          return;
        }
        if (payload["activationId"] !== this.activationId) {
          this.respond({ schema_version: "pi-background-tasks.host-response.v1", request_id: requestId, operation, ok: false, error: { code: "ACTIVATION_MISMATCH", message: "stale activation" } });
          return;
        }
        const sequence = payload["sequence"];
        if (typeof sequence !== "number" || sequence <= lease.sequence) {
          this.respond({ schema_version: "pi-background-tasks.host-response.v1", request_id: requestId, operation, ok: false, error: { code: "STALE_REQUEST", message: "sequence" } });
          return;
        }
        lease.sequence = sequence;
        if (operation === "detail") {
          const taskId = String(payload["taskId"] ?? "");
          const task = this.tasks.find((candidate) => candidate.id === taskId);
          if (!task) {
            this.respond({ schema_version: "pi-background-tasks.host-response.v1", request_id: requestId, operation, ok: false, error: { code: "NOT_FOUND", message: "no such task" } });
            return;
          }
          this.respond({
            schema_version: "pi-background-tasks.host-response.v1",
            request_id: requestId,
            operation,
            ok: true,
            result: { task: { task: { ...task }, kind: "shell", seen: false, canRerun: true, canReadResult: false, truncatedFields: [] } },
          });
          return;
        }
        const limit = typeof payload["limit"] === "number" ? Math.min(payload["limit"], 50) : 50;
        this.respond({
          schema_version: "pi-background-tasks.host-response.v1",
          request_id: requestId,
          operation,
          ok: true,
          result: {
            ...this.facts(),
            tasks: this.tasks.slice(0, limit).map((task) => ({ task: { ...task }, kind: "shell", seen: false, canRerun: true, canReadResult: false, truncatedFields: [] })),
            nextCursor: this.tasks.length > limit ? "cursor-1" : null,
          },
        });
        return;
      }
      default:
        this.respond({ schema_version: "pi-background-tasks.host-response.v1", request_id: requestId, operation, ok: false, error: { code: "UNKNOWN_OPERATION", message: `unsupported ${operation}` } });
    }
  }

  /** Add or replace a task and publish a coalesced change frame for this session. */
  upsert(task: DoubleTask): void {
    const index = this.tasks.findIndex((candidate) => candidate.id === task.id);
    if (index >= 0) this.tasks[index] = task;
    else this.tasks.unshift(task);
    this.revision += 1;
    this.observedAt += 1;
    this.bus.emit(HOST_CHANGED_CHANNEL, {
      schema_version: "pi-background-tasks.host-changed.v1",
      kind: "changed",
      ...this.facts(),
    });
  }

  /** Publish the terminal frame the real registry emits for a finished task. */
  finish(id: string, status: "completed" | "failed" | "killed", extra: Partial<DoubleTask> = {}): DoubleTask {
    const task = this.tasks.find((candidate) => candidate.id === id);
    if (!task) throw new Error(`unknown task ${id}`);
    const finished: DoubleTask = { ...task, ...extra, status, endTime: Date.now() };
    this.upsert(finished);
    this.bus.emit("pi-background-tasks:terminal:v1", {
      schema_version: "pi-background-tasks.extension-terminal.v1",
      task: { ...finished },
    });
    return finished;
  }

  /** Simulate `/reload`: a fresh activation for the same session. */
  simulateReload(): void {
    this.activationId = `act-${Math.random().toString(36).slice(2, 8)}`;
    this.leases.clear();
    this.revision = 0;
    this.upsertPublishReady();
  }

  private upsertPublishReady(): void {
    this.bus.emit(HOST_CHANGED_CHANNEL, {
      schema_version: "pi-background-tasks.host-changed.v1",
      kind: "ready",
      ...this.facts(),
    });
  }

  /** Another Pi session in the same process, with its own activation. */
  static sibling(bus: FakeEventBus, sessionId: string): FakeBackgroundTaskHost {
    return new FakeBackgroundTaskHost(bus, { sessionId });
  }
}

/** Advance real timers by awaiting a few macrotasks; avoids fake-clock complexity. */
export function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until `predicate` holds or the budget expires. */
export async function until(predicate: () => boolean, budgetMs = 3000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < budgetMs) {
    if (predicate()) return true;
    await tick(10);
  }
  return predicate();
}
