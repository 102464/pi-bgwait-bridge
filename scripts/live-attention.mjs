/**
 * Automated live regression for the `attention required` early return (the "修复了没有" fix).
 *
 * Reported failure: `bg_wait_unified({all:true})` returned after 7 ms with `attention required`
 * while the subagent was still working.
 *
 * Cause: the tool forwarded `stopOnAttention:true`, and native `bg_wait` ends on *any*
 * `needs_attention` when that flag is true (subagent-wait.js:638). Ordinary attention sources
 * are an open tool at 240 s and three consecutive failing mutating tools
 * (runs/shared/subagent-control.js:9-12) — not a supervisor ask.
 *
 * The probe makes the subagent trip that path (three failing writes) and keep working, so a
 * correct wait must run for tens of seconds and end with `done`/`complete`. A regression
 * returns in milliseconds with `attention required`.
 *
 * Run: node scripts/live-attention.mjs   (~2 min)
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");

const SUBAGENT_TASK =
  "First use the write tool three times to create C:/Users/ldl/AppData/Local/Temp/bgw-attention-x.txt with content one, two, three, each WITHOUT reading first so it may fail. Then run a single bash command: ping -n 26 127.0.0.1 > nul. Then reply with exactly SUBSCOPE_OK.";

const PROMPT = `Make exactly two tool calls in this one response: (1) subagent with ${JSON.stringify({
  agent: "scout",
  task: SUBAGENT_TASK,
  async: true,
})}, and (2) bgwait_attention_probe with {}. Then reply with exactly: ATT_DONE`;

function piCommand(args) {
  const launcher =
    process.env["PI_LAUNCHER"] ??
    path.join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? "", ".pi", "agent", "bin", "pi-launcher.js");
  return { command: process.execPath, args: [launcher, ...args] };
}

function runPi(timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const useInstalled = process.argv.includes("--installed");
    const extensionArgs = useInstalled
      ? ["-e", "./scripts/live-attention-probe.ts"]
      : ["-e", ".", "-e", "./scripts/live-attention-probe.ts"];
    const { command, args } = piCommand(["-p", PROMPT, ...extensionArgs, "--no-session"]);
    const child = spawn(command, args, { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`pi did not finish within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function parseEvidence(stderr) {
  const evidence = new Map();
  for (const line of stderr.split(/\r?\n/)) {
    const match = /^\[live-attention\] (\S+)=(.*)$/.exec(line);
    if (match) evidence.set(match[1], match[2]);
  }
  return evidence;
}

function unquote(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function main() {
  const checks = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  };

  const { code, stdout, stderr } = await runPi();
  const evidence = parseEvidence(stderr);
  if (evidence.size === 0) {
    console.error(stderr.slice(0, 4000));
    throw new Error("no [live-attention] evidence was produced");
  }

  const unified = String(unquote(evidence.get("unified")) ?? "");
  const waitedMs = Number(evidence.get("waited_ms") ?? "0");

  record("pi exited 0", code === 0, `exit=${String(code)}`);
  record("model replied ATT_DONE", stdout.includes("ATT_DONE"));
  record(
    "the wait did NOT end on a generic attention notice",
    !/attention required/i.test(unified),
    unified.replace(/\n/g, " | ").slice(0, 220),
  );
  record(
    "the wait ran well past the 7 ms early-return (metrics: it waited for the run)",
    waitedMs >= 15_000,
    `waited=${String(waitedMs)}ms`,
  );
  record(
    "the wait ended done with the subagent complete",
    /1 complete/i.test(unified) && /\bdone\b/i.test(unified),
    unified.replace(/\n/g, " | ").slice(0, 220),
  );
  record("the wait did not hit its own timeout window", !/Wait window elapsed/i.test(unified));

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    console.error("\nLive evidence:\n" + stderr.split(/\r?\n/).filter((line) => line.startsWith("[live-attention]")).join("\n"));
    throw new Error(`${String(failed.length)} live check(s) failed: ${failed.map((check) => check.name).join(", ")}`);
  }
  console.log(`\n${String(checks.length)} attention-regression live checks passed.`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`live-attention failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
