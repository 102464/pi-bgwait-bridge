/**
 * Automated live regression for the `attention required` early return (the "修复了没有" fix).
 *
 * Reported failure: `bg_wait_unified({all:true})` returned after 7 ms with `attention required`
 * while the subagent was still working.
 *
 * Since 2026-11-22 a notice observed *during* the wait does end it (operator requirement, see
 * `scripts/live-signals.mjs`). What this script still guards is the other half of the rule: a
 * notice that predates the wait must not cut it short, so the 25 s sleep lets the subagent trip
 * the failure path first and the wait then has to run to the subagent's completion.
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
    /**
     * DCE (`pi-deferred-context-engine`) is enabled in this workspace: a deferred tool is refused
     * both from the model and from `executeTool` ("Tool <name> not found"). A scripted scenario
     * cannot promote anything, so the session starts against a config copy that pins the tools
     * this harness uses (`scripts/live-dce-config.json`, derived from the user's config).
     */
    const child = spawn(command, args, {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_DEFERRED_TOOLS_CONFIG: path.join(packageRoot, "scripts", "live-dce-config.json") },
    });
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

/**
 * Parse the durations `formatDuration` (`src/wait-core.ts:250-259`) prints: `123ms`, `42s`,
 * `1m04s`, `1h02m`. Returns `NaN` for anything else so the guard fails closed.
 */
function parseNativeDuration(text) {
  const ms = /^(\d+)ms$/.exec(text);
  if (ms) return Number(ms[1]);
  const secs = /^(\d+(?:\.\d+)?)s$/.exec(text);
  if (secs) return Number(secs[1]) * 1000;
  const mins = /^(\d+)m(\d+)s$/.exec(text);
  if (mins) return (Number(mins[1]) * 60 + Number(mins[2])) * 1000;
  const hours = /^(\d+)h(\d+)m$/.exec(text);
  if (hours) return (Number(hours[1]) * 60 + Number(hours[2])) * 60 * 1000;
  return Number.NaN;
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
    "a pre-existing notice does not end a fresh wait",
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
  /**
   * Sync guard: the tool must return when the native half answered, not after it.
   *
   * An earlier build kept a signal loop alive beside the native half whose `isDone()` never
   * settles an empty id scope, so the call returned only when its own window expired: the
   * evidence read `waited=120222ms` while the native note said `Waited 34.6s …; done`. The text
   * assertions above all passed on that build, because the text was the native one. Comparing
   * the measured wait against the duration the native half itself reports is what catches it.
   *
   * The native note uses `formatDuration`, so past a minute it reads `1m4s` or `1h02m` rather
   * than a plain seconds count; an earlier version of this guard could not parse those and
   * reported `native=?s` (a spurious failure at 65 s of a 64 s native wait).
   */
  const nativeWait = /Native wait: Waited (\d+h\d+m|\d+m\d+s|\d+(?:\.\d+)?s|\d+ms)/i.exec(unified);
  const nativeMs = nativeWait ? parseNativeDuration(nativeWait[1]) : Number.NaN;
  record(
    "the wait returned with the native answer instead of riding out its window",
    Number.isFinite(nativeMs) && waitedMs <= nativeMs + 20_000,
    `waited=${String(waitedMs)}ms native=${nativeWait ? nativeWait[1] : "?"}`,
  );

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
