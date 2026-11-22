/**
 * Supervisor-request probe tests (`src/supervisor-probe.ts`).
 *
 * The probe answers one question — "is a real subagent supervisor request outstanding for
 * this session?" — from pi-subagents' own request files, because:
 *   - `stopOnAttention:true` is NOT the same question: native `bg_wait` ends on any
 *     `needs_attention` then (subagent-wait.js:638), whose ordinary sources are an open tool
 *     at 240 s and three consecutive tool failures (runs/shared/subagent-control.js:9-12);
 *   - a request is resolved in the parent tool or in pi-subagents' own poll, so an event-flag
 *     listener could never observe the resolution and would latch "pending" forever.
 *
 * Upstream reference points: `requestMatchesOwner` (native-supervisor-channel.js:363-380),
 * `requestLifecycle` (:446-458) and the request file shape written at :139-159.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createSupervisorProbe, resolveSubagentTempRoot, supervisorChannelRoot } from "../src/supervisor-probe.ts";

interface ChannelFixture {
  root: string;
  dir: string;
  cleanup: () => void;
}

function fixture(): ChannelFixture {
  const root = mkdtempSync(path.join(tmpdir(), "bgw-supervisor-"));
  const dir = supervisorChannelRoot(root);
  mkdirSync(dir, { recursive: true });
  return { root, dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeRequest(
  channelDir: string,
  channelName: string,
  requestId: string,
  body: Record<string, unknown>,
): { requestFile: string } {
  const requestsDir = path.join(channelDir, channelName, "requests");
  mkdirSync(requestsDir, { recursive: true });
  const requestFile = path.join(requestsDir, `${requestId}.json`);
  writeFileSync(requestFile, JSON.stringify(body), "utf8");
  return { requestFile };
}

function writeReply(channelDir: string, channelName: string, requestId: string): void {
  const repliesDir = path.join(channelDir, channelName, "replies");
  mkdirSync(repliesDir, { recursive: true });
  writeFileSync(path.join(repliesDir, `${requestId}.json`), JSON.stringify({ type: "subagent.supervisor.reply", requestId }), "utf8");
}

test("a pending request owned by this session is detected", () => {
  const f = fixture();
  writeRequest(f.dir, "run-1-scout-0", "req-1", {
    type: "subagent.supervisor.request",
    id: "req-1",
    reason: "need_decision",
    expectsReply: true,
    orchestratorSessionId: "sess-A",
    runId: "run-1",
    agent: "scout",
    childIndex: 0,
  });
  const probe = createSupervisorProbe({ sessionIds: () => ["sess-A", "C:/s/A.jsonl"], tempRoot: f.root });
  assert.equal(probe.hasPending(), true);
  assert.deepEqual(probe.pendingIds(), ["req-1"]);
  f.cleanup();
});

test("the pending detail is read from the request file, including an interview request", () => {
  // `interview_request` is the other blocking reason (`native-supervisor-channel.js:133`
  // `expectsReply = params.reason !== "progress_update"`), and it usually carries no `message`
  // at all (`:128`). The wait's closing sentence names these fields, so they must come from the
  // file rather than from any bus notice.
  const f = fixture();
  writeRequest(f.dir, "run-2-scout-0", "req-interview", {
    type: "subagent.supervisor.request",
    id: "req-interview",
    reason: "interview_request",
    expectsReply: true,
    orchestratorSessionId: "sess-A",
    runId: "run-2",
    agent: "scout",
    interview: { title: "RTL batch interview" },
  });
  const probe = createSupervisorProbe({ sessionIds: () => ["sess-A"], tempRoot: f.root });
  assert.deepEqual(probe.pendingDetail(), {
    requestId: "req-interview",
    reason: "interview_request",
    runId: "run-2",
    agent: "scout",
  });
  f.cleanup();
});

test("pendingDetail reports nothing when no request is outstanding", () => {
  const f = fixture();
  const probe = createSupervisorProbe({ sessionIds: () => ["sess-A"], tempRoot: f.root });
  assert.equal(probe.pendingDetail(), undefined);
  f.cleanup();
});

test("a request owned by another session is ignored", () => {
  const f = fixture();
  writeRequest(f.dir, "run-1-scout-0", "req-other", {
    expectsReply: true,
    orchestratorSessionId: "sess-OTHER",
  });
  const probe = createSupervisorProbe({ sessionIds: () => ["sess-A"], tempRoot: f.root });
  assert.equal(probe.hasPending(), false);
  f.cleanup();
});

test("a notice that does not expect a reply is not a barrier", () => {
  const f = fixture();
  writeRequest(f.dir, "run-1-scout-0", "req-notice", {
    reason: "progress_update",
    expectsReply: false,
    orchestratorSessionId: "sess-A",
  });
  const probe = createSupervisorProbe({ sessionIds: () => ["sess-A"], tempRoot: f.root });
  assert.equal(probe.hasPending(), false);
  f.cleanup();
});

test("an expired request stops counting even before the upstream poll prunes it", () => {
  const f = fixture();
  writeRequest(f.dir, "run-1-scout-0", "req-expired", {
    expectsReply: true,
    orchestratorSessionId: "sess-A",
    expiresAt: 1_000,
  });
  const probe = createSupervisorProbe({ sessionIds: () => ["sess-A"], tempRoot: f.root, now: () => 5_000 });
  assert.equal(probe.hasPending(), false);
  f.cleanup();
});

test("a request with a reply file already written is treated as answered", () => {
  const f = fixture();
  writeRequest(f.dir, "run-1-scout-0", "req-answered", {
    expectsReply: true,
    orchestratorSessionId: "sess-A",
  });
  writeReply(f.dir, "run-1-scout-0", "req-answered");
  const probe = createSupervisorProbe({ sessionIds: () => ["sess-A"], tempRoot: f.root });
  assert.equal(probe.hasPending(), false, "a resolved request must never keep a wait open");
  f.cleanup();
});

test("after the request file is removed the probe reports nothing pending", () => {
  const f = fixture();
  const { requestFile } = writeRequest(f.dir, "run-1-scout-0", "req-gone", {
    expectsReply: true,
    orchestratorSessionId: "sess-A",
  });
  const probe = createSupervisorProbe({ sessionIds: () => ["sess-A"], tempRoot: f.root });
  assert.equal(probe.hasPending(), true);
  rmSync(requestFile);
  // The 250 ms cache is a wake-latency bound; a later observation must see the removal.
  const later = createSupervisorProbe({ sessionIds: () => ["sess-A"], tempRoot: f.root });
  assert.equal(later.hasPending(), false);
  f.cleanup();
});

test("a malformed request file is ignored instead of throwing", () => {
  const f = fixture();
  const requestsDir = path.join(f.dir, "run-1-scout-0", "requests");
  mkdirSync(requestsDir, { recursive: true });
  writeFileSync(path.join(requestsDir, "broken.json"), "{ not json", "utf8");
  writeFileSync(path.join(requestsDir, "array.json"), "[]", "utf8");
  const probe = createSupervisorProbe({ sessionIds: () => ["sess-A"], tempRoot: f.root });
  assert.equal(probe.hasPending(), false, "unreadable state counts as not-pending, like upstream's not-owned");
  f.cleanup();
});

test("an absent channel root means nothing pending, not an error", () => {
  const probe = createSupervisorProbe({ sessionIds: () => ["sess-A"], tempRoot: path.join(tmpdir(), "bgw-definitely-missing") });
  assert.equal(probe.hasPending(), false);
});

test("with no session identity the probe reports nothing pending", () => {
  const f = fixture();
  writeRequest(f.dir, "run-1-scout-0", "req-1", { expectsReply: true, orchestratorSessionId: "sess-A" });
  const probe = createSupervisorProbe({ sessionIds: () => [], tempRoot: f.root });
  assert.equal(probe.hasPending(), false, "an unidentified session must not latch on someone else's request");
  f.cleanup();
});

test("temp root resolution matches pi-subagents' own scope rules", () => {
  // Same precedence as `shared/types.js#resolveTempScopeId`: configured root, then uid on
  // POSIX, then USERNAME / USER / LOGNAME / home, and every scope segment is sanitized.
  assert.equal(
    resolveSubagentTempRoot({ PI_SUBAGENTS_TEMP_ROOT: "C:/tmp/x" }),
    path.resolve("C:/tmp/x"),
    "a configured root wins",
  );
  if (typeof process.getuid !== "function") {
    assert.equal(
      resolveSubagentTempRoot({ USERNAME: "ldl" }),
      path.join(tmpdir(), "pi-subagents-user-ldl"),
    );
    assert.equal(
      resolveSubagentTempRoot({ USERNAME: "a b/c" }),
      path.join(tmpdir(), "pi-subagents-user-a-b-c"),
      "characters outside [A-Za-z0-9._-] become '-'",
    );
  }
});

test("the probe root ends with the upstream directory name", () => {
  const root = supervisorChannelRoot("C:/tmp/pi-subagents-user-ldl");
  assert.equal(path.basename(root), "supervisor-channels");
  assert.equal(existsSync(root), false, "root() is a path calculation, never a creation");
});
