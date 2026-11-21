/**
 * Session ownership for native background tasks.
 *
 * pi-background-tasks 2.6.10 `BgTaskSnapshot` has no `sessionId` field (see
 * `src/core/common.ts:221`), so ownership cannot be read off a task. The trusted launch
 * record is the background-task *host activation*: at `session_start` it captures
 * `ctx.sessionManager.getSessionId()` into `currentRegistryCtx` and stamps every
 * `subscribe`/`list`/`detail` response with it (`src/core/host-api.ts:293`,
 * `activationFacts()` at :569).
 *
 * Therefore: a task belongs to this session iff the activation that returned it has a
 * `sessionId` equal to one of this session's identities, *and* the activation's
 * `activationId` is stable across the observations that produced the id set. Everything
 * else — other Pi sessions in the same process, the pi-subagents runner's child sessions,
 * stale activations from a reload — is excluded rather than merged in.
 */

export interface SessionIdentity {
  /** `ctx.sessionManager.getSessionId()` */
  readonly sessionId: string;
  /** `ctx.sessionManager.getSessionFile()` when sessions are persisted. */
  readonly sessionFile?: string | undefined;
}

export interface OwnershipRecord {
  readonly identities: readonly string[];
  readonly activationId: string;
  readonly hostSessionId: string;
  readonly establishedAt: number;
  readonly source: "host-subscribe" | "host-list" | "host-changed";
}

export function identitiesOf(identity: SessionIdentity): string[] {
  const values = [identity.sessionId, identity.sessionFile].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return [...new Set(values)];
}

/**
 * Build the trusted record. Returns `undefined` when the host activation's session id is
 * not one of this session's identities: that activation is not ours and nothing it
 * reports may enter this session's wait scope.
 */
export function makeOwnershipRecord(
  identity: SessionIdentity,
  activation: { activationId: string; sessionId: string },
  nowMs: number,
  source: OwnershipRecord["source"],
): OwnershipRecord | undefined {
  const identities = identitiesOf(identity);
  if (!activation.sessionId || identities.length === 0) return undefined;
  if (!identities.includes(activation.sessionId)) return undefined;
  if (!activation.activationId) return undefined;
  return {
    identities,
    activationId: activation.activationId,
    hostSessionId: activation.sessionId,
    establishedAt: nowMs,
    source,
  };
}

/** True when the activation is still the one this session trusted. */
export function recordMatches(record: OwnershipRecord, activation: { activationId: string; sessionId: string }): boolean {
  return record.activationId === activation.activationId && record.hostSessionId === activation.sessionId;
}

/**
 * The `sessionId` to stamp on a provider item. pi-subagents keeps items whose `sessionId`
 * is any accepted identity form of the *current* session (`snapshotBackgroundWork`), so
 * report the form it asked for. When the wait context offers none of our identities the
 * item is not provably ours and must be dropped.
 */
export function itemSessionId(
  record: OwnershipRecord,
  contextSessionIds: readonly string[] | undefined,
): string | undefined {
  if (contextSessionIds === undefined || contextSessionIds.length === 0) {
    // No context: single-session processes still get the trusted host identity.
    return record.hostSessionId;
  }
  const match = contextSessionIds.find((value) => record.identities.includes(value));
  return match;
}

/** `(provider/session/id)` identity triple used by pi-subagents to deduplicate items. */
export function itemKey(provider: string, sessionId: string, id: string): string {
  return `${provider}\0${sessionId}\0${id}`;
}
