/**
 * pi-intercom pending-ask probe tests (`src/intercom-probe.ts`).
 *
 * The probe answers one question — "is another agent blocked waiting for this session to
 * answer?" — from pi-intercom's own ask ledger, because a steered ask produces no Pi message
 * event while this tool holds the turn (`agent-session.js:1967-1975`).
 *
 * Upstream reference points: `writePendingAskRecord` (broker/broker.ts:1367-1381), the
 * `pending-asks` dir constant (:31), removal on reply (:1157 `releaseReplyEdge`) and the
 * expiry prune (:1396+ `prunePendingAskRecords`).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createIntercomProbe, intercomPendingAskRoot, resolveIntercomAgentDir } from "../src/intercom-probe.ts";
import { createSubagentSignalCapture } from "../src/subagent-signals.ts";
import type { EventBusLike } from "../src/types.ts";

interface Ledger {
  /** The pi-intercom agent dir the probe resolves `<agentDir>/intercom/pending-asks` from. */
  dir: string;
  root: string;
  cleanup: () => void;
}

function ledger(): Ledger {
  const dir = mkdtempSync(path.join(tmpdir(), "bgw-intercom-"));
  const root = intercomPendingAskRoot(dir);
  mkdirSync(root, { recursive: true });
  return { dir, root, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeAsk(
  root: string,
  name: string,
  body: {
    messageId?: string;
    targetSessionId?: unknown;
    createdAt?: number;
    expiresAt?: number;
    question?: string;
    askerName?: string;
  } = {},
): string {
  const createdAt = body.createdAt ?? 1;
  const file = path.join(root, name);
  writeFileSync(
    file,
    JSON.stringify({
      askId: body.messageId ?? "ask-1",
      messageId: body.messageId ?? "ask-1",
      asker: { sessionId: "peer-session", name: body.askerName ?? "peer" },
      target: { sessionId: body.targetSessionId ?? "mine", name: "this-session" },
      question: body.question ?? "which arm should I take?",
      createdAt,
      ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
    }),
    "utf8",
  );
  return file;
}

function bus(): EventBusLike {
  return {
    on: () => () => {},
    emit: () => {},
  };
}

test("an unanswered ask addressed to this session is pending, with the question verbatim", () => {
  const l = ledger();
  writeAsk(l.root, "abc-ask-1.json", { messageId: "ask-1", question: "which arm should I take?" });
  const probe = createIntercomProbe({ sessionIds: () => ["mine"], intercomDir: l.dir });
  const ask = probe.pending();
  assert.equal(ask?.messageId, "ask-1");
  assert.equal(ask?.asker, "peer");
  assert.equal(ask?.question, "which arm should I take?");
  l.cleanup();
});

test("an ask addressed to another session is not ours", () => {
  const l = ledger();
  writeAsk(l.root, "abc-ask-1.json", { targetSessionId: "theirs" });
  const probe = createIntercomProbe({ sessionIds: () => ["mine"], intercomDir: l.dir });
  assert.equal(probe.pending(), undefined);
  l.cleanup();
});

test("an ask whose expiresAt has passed is not pending (answered, cancelled, or pruned)", () => {
  const l = ledger();
  writeAsk(l.root, "abc-ask-1.json", { createdAt: 100, expiresAt: 1000 });
  const probe = createIntercomProbe({
    sessionIds: () => ["mine"],
    intercomDir: l.dir,
    now: () => 5000,
  });
  assert.equal(probe.pending(), undefined);
  l.cleanup();
});

test("an empty or missing ledger is not pending and never throws", () => {
  const l = ledger();
  const probe = createIntercomProbe({ sessionIds: () => ["mine"], intercomDir: l.dir });
  assert.equal(probe.pending(), undefined);
  const absent = createIntercomProbe({
    sessionIds: () => ["mine"],
    intercomDir: path.join(l.dir, "absent-agent"),
  });
  assert.equal(absent.pending(), undefined);
  l.cleanup();
});

test("a malformed record is skipped, and the next good one still answers", () => {
  const l = ledger();
  writeFileSync(path.join(l.root, "bad.json"), "{ not json", "utf8");
  writeFileSync(path.join(l.root, "array.json"), "[]", "utf8");
  writeAsk(l.root, "abc-ask-2.json", { messageId: "ask-2", createdAt: 20 });
  const probe = createIntercomProbe({ sessionIds: () => ["mine"], intercomDir: l.dir });
  const asks = probe.pendingAll();
  assert.equal(asks.length, 1);
  assert.equal(asks[0]?.messageId, "ask-2");
  l.cleanup();
});

test("the oldest ask wins, so a queue is reported in arrival order", () => {
  const l = ledger();
  writeAsk(l.root, "abc-ask-late.json", { messageId: "ask-late", createdAt: 900 });
  writeAsk(l.root, "abc-ask-early.json", { messageId: "ask-early", createdAt: 100 });
  const probe = createIntercomProbe({ sessionIds: () => ["mine"], intercomDir: l.dir });
  assert.equal(probe.pending()?.messageId, "ask-early");
  l.cleanup();
});

test("intercom identities match across separator case, like run ownership does", () => {
  const l = ledger();
  writeAsk(l.root, "abc-ask-1.json", { targetSessionId: "C:/Users/ldl/Some-Session" });
  const probe = createIntercomProbe({
    sessionIds: () => ["c:\\users\\ldl\\some-session"],
    intercomDir: l.dir,
  });
  assert.equal(probe.pending()?.messageId, "ask-1");
  l.cleanup();
});

test("agent-dir resolution follows PI_CODING_AGENT_DIR, then ~/.pi/agent", () => {
  assert.equal(
    resolveIntercomAgentDir({ PI_CODING_AGENT_DIR: "/abs/agent" }, "/home/x", "/cwd"),
    "/abs/agent",
  );
  assert.equal(resolveIntercomAgentDir({}, "/home/x", "/cwd"), path.join("/home/x", ".pi", "agent"));
  assert.equal(intercomPendingAskRoot("/abs/agent"), path.join("/abs/agent", "intercom", "pending-asks"));
});

test("an ask observed before the wait was armed never ends it", () => {
  const l = ledger();
  writeAsk(l.root, "abc-ask-1.json", { messageId: "ask-1", createdAt: 100 });
  const capture = createSubagentSignalCapture({
    events: bus(),
    sessionIds: () => ["mine"],
    now: () => 5000,
    pendingAsk: () =>
      createIntercomProbe({
        sessionIds: () => ["mine"],
        intercomDir: l.dir,
        now: () => 5000,
      }).pending(),
  });
  capture.arm(() => {});
  // The ledger record predates this wait: it is a backlog, not new work.
  assert.equal(capture.pending(), undefined);
  l.cleanup();
});

test("an ask that arrives while the wait runs ends it as an intercom_ask signal", () => {
  const l = ledger();
  let clock = 100;
  const probe = createIntercomProbe({
    sessionIds: () => ["mine"],
    intercomDir: l.dir,
    now: () => clock,
  });
  const capture = createSubagentSignalCapture({
    events: bus(),
    sessionIds: () => ["mine"],
    now: () => clock,
    pendingAsk: () => probe.pending(),
  });
  capture.arm(() => {});
  assert.equal(capture.pending(), undefined); // nothing in the ledger yet
  clock = 200;
  writeAsk(l.root, "abc-ask-9.json", { messageId: "ask-9", createdAt: 200, question: "status?" });
  clock = 500; // past the probe's 250 ms scan cache (the wait loop polls at 1000 ms)
  const signal = capture.pending();
  assert.equal(signal?.kind, "intercom_ask");
  assert.equal(signal?.runId, "ask-9");
  assert.equal(signal?.agent, "peer");
  assert.equal(signal?.question, "status?");
  assert.equal(signal?.source, "intercom-ask");
  l.cleanup();
});
