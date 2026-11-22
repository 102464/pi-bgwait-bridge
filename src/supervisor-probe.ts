/**
 * Read-only probe for outstanding subagent supervisor requests.
 *
 * Why a filesystem probe instead of an event flag: pi-subagents resolves a supervisor request
 * in the *parent* tool (`subagent_supervisor({action:"reply"})`, native-supervisor-channel.js:610-620)
 * and in its own poll (`refreshPendingRequests`, :463-470). An extension that merely watched
 * `subagent:control-event` could never learn that a request was answered, so it would latch
 * "pending" forever.
 *
 * The data source is the same one pi-subagents itself uses to decide ownership
 * (`requestMatchesOwner`, :363-380): request files under
 *
 *   <TEMP_ROOT_DIR>/supervisor-channels/<runId>-<agent>-<childIndex>/requests/<requestId>.json
 *
 * with `orchestratorSessionId`, `expectsReply`, `expiresAt`. Reading them is read-only, and a
 * malformed or racing file is treated as "not pending" (the same fail direction as upstream,
 * which counts an unreadable status as not owned).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SupervisorProbeOptions {
  /** Session identities accepted as ours: runtime session id and/or session file path. */
  sessionIds: () => readonly string[];
  /** Override the temp root (tests). Defaults to pi-subagents' own resolution. */
  tempRoot?: string;
  now?: () => number;
}

export interface SupervisorProbe {
  hasPending(): boolean;
  /** Pending request ids, for tool output. */
  pendingIds(): string[];
  root(): string;
}

const MAX_CHANNEL_DIRS = 64;
const MAX_REQUEST_FILES = 128;

function sanitizeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

/**
 * Same resolution pi-subagents uses (`shared/types.js#resolveTempScopeId`): uid on POSIX,
 * else the sanitized USERNAME/USER, else the sanitized home directory.
 */
export function resolveSubagentTempRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["PI_SUBAGENTS_TEMP_ROOT"]?.trim();
  if (configured) return path.resolve(configured);
  const getuid = process.getuid?.bind(process);
  const scope =
    typeof getuid === "function"
      ? `uid-${String(getuid())}`
      : env["USERNAME"]
        ? `user-${sanitizeSegment(env["USERNAME"])}`
        : env["USER"]
          ? `user-${sanitizeSegment(env["USER"])}`
          : env["LOGNAME"]
            ? `user-${sanitizeSegment(env["LOGNAME"])}`
            : env["USERPROFILE"]
              ? `home-${sanitizeSegment(env["USERPROFILE"])}`
              : env["HOME"]
                ? `home-${sanitizeSegment(env["HOME"])}`
                : "shared";
  return path.join(os.tmpdir(), `pi-subagents-${scope}`);
}

export function supervisorChannelRoot(tempRoot: string): string {
  return path.join(tempRoot, "supervisor-channels");
}

interface RequestFile {
  orchestratorSessionId?: unknown;
  expectsReply?: unknown;
  expiresAt?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createSupervisorProbe(options: SupervisorProbeOptions): SupervisorProbe {
  const now = options.now ?? Date.now;
  const root = supervisorChannelRoot(
    options.tempRoot ?? resolveSubagentTempRoot(),
  );
  let cachedAt = -1;
  let cachedIds: string[] = [];

  function scan(): string[] {
    const accepted = options.sessionIds();
    if (accepted.length === 0) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return []; // No supervisor channel root yet: nothing can be pending.
    }
    const ids: string[] = [];
    let scannedDirs = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (scannedDirs >= MAX_CHANNEL_DIRS) break;
      scannedDirs += 1;
      const requestsDir = path.join(root, entry.name, "requests");
      const repliesDir = path.join(root, entry.name, "replies");
      let files: fs.Dirent[];
      try {
        files = fs.readdirSync(requestsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      let scannedFiles = 0;
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".json")) continue;
        if (scannedFiles >= MAX_REQUEST_FILES) break;
        scannedFiles += 1;
        let parsed: unknown;
        try {
          parsed = JSON.parse(fs.readFileSync(path.join(requestsDir, file.name), "utf8"));
        } catch {
          continue; // half-written or removed between readdir and read
        }
        if (!isRecord(parsed)) continue;
        const request = parsed as RequestFile;
        // Upstream treats a request that does not expect a reply as a notice, not a barrier.
        if (request.expectsReply === false) continue;
        const owner = request.orchestratorSessionId;
        if (typeof owner !== "string" || !accepted.includes(owner)) continue;
        const expiresAt = typeof request.expiresAt === "number" ? request.expiresAt : undefined;
        if (expiresAt !== undefined && expiresAt <= now()) continue; // answered or expired
        // `requestLifecycle` (native-supervisor-channel.js:446-458) treats an existing reply
        // file as "resolved" and removes the request on the next poll. Check the reply marker
        // ourselves so a request answered in another turn is never counted again.
        const requestId = file.name.slice(0, -"\u002ejson".length);
        if (fs.existsSync(path.join(repliesDir, `${requestId}.json`))) continue;
        ids.push(requestId);
      }
    }
    return ids;
  }

  function refresh(): string[] {
    const stamp = now();
    if (cachedAt >= 0 && stamp - cachedAt < 250) return cachedIds;
    cachedIds = scan();
    cachedAt = stamp;
    return cachedIds;
  }

  return {
    hasPending: () => refresh().length > 0,
    pendingIds: () => refresh(),
    root: () => root,
  };
}
