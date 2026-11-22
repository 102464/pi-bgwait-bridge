/**
 * Read-only probe for unanswered pi-intercom asks addressed to this session.
 *
 * Why a filesystem probe: `intercom({action:"ask"})` is delivered to a *busy* session as a
 * steered custom message (`pi-intercom/index.ts:1333-1341` → `{deliverAs:"steer"}`), and Pi
 * only emits `message_start`/`message_end` for that message when the agent loop drains its
 * steering queue at a turn boundary — which cannot happen while a blocking tool call (this
 * wait) holds the turn. Live-tested: a `pi.sendMessage({customType:"intercom_message"})`
 * injected 1.5 s into a 120 s wait produced no message event at all, so `message_end` is not
 * a usable signal here.
 *
 * The durable record is pi-intercom's own pending-ask ledger
 * (`broker/broker.ts:1367-1381` `writePendingAskRecord`):
 *
 *   <agentDir>/intercom/pending-asks/<sha256(scopeId)>-<messageId>.json
 *   { askId, messageId, asker:{sessionId,name}, target:{sessionId,name},
 *     question, createdAt, expiresAt }
 *
 * written when the ask is queued and removed when it is answered (`removePendingAskRecord`
 * on reply, `releaseReplyEdge`), cancelled, or pruned past `expiresAt`. So "a record whose
 * `target.sessionId` is this session and whose `expiresAt` is still in the future" is exactly
 * "another agent is blocked waiting for this session to answer".
 *
 * Reading it is read-only, and every failure direction is fail-closed: an unreadable root,
 * a half-written record, or a foreign target is "not pending" (never a false wake-up, and
 * never a throw inside the wait loop).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface IntercomAsk {
  /** Intercom message id of the ask. */
  messageId: string;
  /** Session id / name of the agent waiting for the reply. */
  asker: string;
  /** The question body, verbatim. */
  question: string;
  createdAt: number;
  expiresAt: number | undefined;
}

export interface IntercomProbeOptions {
  /**
   * Identities accepted as this session, resolved on every scan: pi-intercom addresses a
   * session by its intercom id (`resolveConfiguredIntercomSessionId`,
   * `pi-intercom/index.ts:596-598`), which pi-intercom publishes into
   * `process.env.PI_INTERCOM_SESSION_ID` at session start — not by the Pi session id.
   */
  sessionIds: () => readonly string[];
  /** Override the pid-independent intercom dir (tests). */
  intercomDir?: string;
  now?: () => number;
  /** Only asks created at or after this instant count (set by the caller when the wait starts). */
  notBefore?: () => number;
}

export interface IntercomProbe {
  /** The oldest unanswered ask addressed here, if any. */
  pending(): IntercomAsk | undefined;
  /** All unanswered asks, oldest first. */
  pendingAll(): readonly IntercomAsk[];
  root(): string;
}

const MAX_ASK_FILES = 128;
const CACHE_MS = 250;

/**
 * Same resolution pi-intercom uses (`broker/paths.ts:27-35` `getAgentDirPath`):
 * `PI_CODING_AGENT_DIR` when set (absolute or relative to cwd), else `<home>/.pi/agent`.
 */
export function resolveIntercomAgentDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  cwd: string = process.cwd(),
): string {
  const configured = env["PI_CODING_AGENT_DIR"]?.trim();
  if (!configured) return path.join(homeDir, ".pi", "agent");
  return path.isAbsolute(configured) ? configured : path.resolve(cwd, configured);
}

export function intercomPendingAskRoot(agentDir: string = resolveIntercomAgentDir()): string {
  return path.join(agentDir, "intercom", "pending-asks");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

export function createIntercomProbe(options: IntercomProbeOptions): IntercomProbe {
  const now = options.now ?? Date.now;
  const root = intercomPendingAskRoot(options.intercomDir ?? undefined);
  let cachedAt = -1;
  let cached: IntercomAsk[] = [];

  function scan(): IntercomAsk[] {
    const accepted = options.sessionIds().filter((value) => value.length > 0);
    if (accepted.length === 0) return [];
    const normalizedAccepted = new Set(accepted.map(normalize));
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return []; // No ledger yet: nothing can be waiting for an answer.
    }
    const notBefore = options.notBefore?.() ?? -1;
    const asks: IntercomAsk[] = [];
    let scanned = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      if (scanned >= MAX_ASK_FILES) break;
      scanned += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(root, entry.name), "utf8"));
      } catch {
        continue; // removed between readdir and read, or half-written
      }
      if (!isRecord(parsed)) continue;
      const target = parsed["target"];
      if (!isRecord(target)) continue;
      const targetSessionId = target["sessionId"];
      if (typeof targetSessionId !== "string" || !normalizedAccepted.has(normalize(targetSessionId))) continue;
      const messageId = parsed["messageId"];
      if (typeof messageId !== "string" || messageId.length === 0) continue;
      const createdAt = typeof parsed["createdAt"] === "number" ? parsed["createdAt"] : undefined;
      if (createdAt === undefined || createdAt < notBefore) continue;
      const expiresAt = typeof parsed["expiresAt"] === "number" ? parsed["expiresAt"] : undefined;
      if (expiresAt !== undefined && expiresAt <= now()) continue; // answered, cancelled, or pruned
      const asker = parsed["asker"];
      const askerName = isRecord(asker)
        ? typeof asker["name"] === "string" && asker["name"].length > 0
          ? asker["name"]
          : typeof asker["sessionId"] === "string"
            ? asker["sessionId"]
            : "another agent"
        : "another agent";
      const question = typeof parsed["question"] === "string" ? parsed["question"] : "";
      asks.push({ messageId, asker: askerName, question, createdAt, expiresAt });
    }
    return asks.sort((a, b) => a.createdAt - b.createdAt);
  }

  function refresh(): IntercomAsk[] {
    const stamp = now();
    if (cachedAt >= 0 && stamp - cachedAt < CACHE_MS) return cached;
    cached = scan();
    cachedAt = stamp;
    return cached;
  }

  return {
    pending: () => refresh()[0],
    pendingAll: () => refresh(),
    root: () => root,
  };
}
