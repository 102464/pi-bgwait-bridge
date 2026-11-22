/**
 * Live verification for the three signal classes the operator requires to end
 * `bg_wait_unified` (2026-11-22):
 *
 *   1. `attention`     — a subagent of this session raises a `needs_attention` notice.
 *   2. `intercom`       — another agent routes a message/ask to this session over pi-intercom.
 *   3. `contact_supervisor` — a subagent writes a real supervisor request file.
 *
 * Each scenario must end the wait *before* its own window, i.e. `waited_ms < timeout_ms`; a wait
 * that only ends because the window ran out proves nothing.
 *
 * Why `--mode rpc`: pi-intercom steers a message into a *busy* session only when the extension
 * context reports `hasUI: true` (`pi-intercom/index.ts:1360-1384`). `-p`, `--mode json` and
 * `--mode rpc` are the non-interactive modes Pi accepts, and only rpc reports `hasUI: true`, so
 * it is the one non-interactive mode in which a pending ask survives the wait instead of being
 * auto-answered and dismissed.
 *
 * Run: node scripts/live-signals.mjs            (package loaded from this working tree)
 *      node scripts/live-signals.mjs --installed   (the package as installed in settings.json)
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");

const SUPERVISOR_TASK =
  "Call contact_supervisor exactly once with reason \"need_decision\" and the message \"which arm should I take for the next RTL batch?\". Then stop and wait for the reply. After the reply arrives, reply with exactly SIGNALS_OK.";

const ATTENTION_TASK =
  "First use the bash tool three times with a command that must fail: echo x > C:/Users/ldl/AppData/Local/Temp/bgw-attn-missing-dir/f.txt. Each write must fail with a non-zero exit code. Then run one command that sleeps: ping -n 26 127.0.0.1 > nul. Then reply with exactly SIGNALS_OK.";
function piCommand(args) {
  const launcher =
    process.env["PI_LAUNCHER"] ??
    path.join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? "", ".pi", "agent", "bin", "pi-launcher.js");
  return { command: process.execPath, args: [launcher, ...args] };
}

function runRpc(prompt, { timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const useInstalled = process.argv.includes("--installed");
    const extensionArgs = useInstalled
      ? ["-e", "./scripts/live-signals-probe.ts"]
      : ["-e", ".", "-e", "./scripts/live-signals-probe.ts"];
    const { command, args } = piCommand(["--mode", "rpc", ...extensionArgs, "--no-session"]);
    const child = spawn(command, args, { cwd: packageRoot, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`rpc session did not finish within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      // `agent_settled` means Pi has no remaining automatic work for this run.
      if (stdout.includes('"type":"agent_settled"') || stdout.includes('"type": "agent_settled"')) {
        setTimeout(() => finish({ stdout, stderr }), 400);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => finish({ stdout, stderr }));
    child.stdin.write(`${JSON.stringify({ id: "req-1", type: "prompt", message: prompt })}\n`);
  });
}

function parseEvidence(stderr, prefix) {
  const evidence = new Map();
  for (const line of stderr.split(/\r?\n/)) {
    const match = new RegExp(`^\\[${prefix}\\] (\\S+)=(.*)$`).exec(line);
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

async function scenario(name, prompt, { prefix = "live-signals", checks }) {
  return (async () => {
    const result = await runRpc(prompt);
    const evidence = parseEvidence(result.stderr, prefix);
    if (evidence.size === 0) {
      console.error(result.stderr.slice(0, 6000));
      throw new Error(`${name}: no [${prefix}] evidence produced (stdout=${result.stdout.slice(0, 2000)})`);
    }
    const lines = result.stderr.split(/\r?\n/).filter((line) => line.startsWith(`[${prefix}]`));
    const unified = String(unquote(evidence.get("unified")) ?? "");
    const waitedMs = Number(evidence.get("waited_ms") ?? "0");
    const timeoutMs = Number(evidence.get("timeout_ms") ?? "0");
    // Evidence lines are reported verbatim, including the asker's own output: the harness must
    // show *how* the sibling process tried to deliver the message, not only that it failed.
    console.log(`\n== ${name} ==`);
    for (const line of lines) console.log(`  │ ${line}`);
    const outcomes = checks({ unified, waitedMs, timeoutMs, evidence, result });
    for (const [label, ok, detail] of outcomes) {
      if (ok === undefined) continue;
      console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
    }
    return { name, outcomes, unified, waitedMs, timeoutMs, evidence };
  })();
}

async function main() {
  const scenarios = (process.env["LIVE_SIGNALS_SCENARIOS"] ?? "intercom,attention,supervisor").split(",");
  const results = [];

  if (scenarios.includes("intercom")) {
    results.push(
      await scenario(
        "intercom ask routed from another process",
        "Make exactly one tool call in this response: live_signals_probe with {\"scenario\":\"intercom-ask\",\"timeoutMs\":90000,\"askDelayMs\":5000}. Then reply with exactly SIGNALS_DONE.",
        {
          checks: ({ unified, waitedMs, timeoutMs }) => [
            ["pi reported hasUI", undefined],
            [
              "the wait ended on the intercom signal, not on its window",
              waitedMs > 0 && timeoutMs > 0 && waitedMs < timeoutMs,
              `waited=${String(waitedMs)}ms timeout=${String(timeoutMs)}ms`,
            ],
            [
              "the text names the intercom ask",
              /waiting for a reply over intercom|Intercom ask|intercom message/i.test(unified),
              unified.replace(/\n/g, " | ").slice(0, 260),
            ],
          ],
        },
      ),
    );
  }

  if (scenarios.includes("attention")) {
    results.push(
      await scenario(
        "subagent attention notice",
        `Make exactly two tool calls in this response: (1) subagent with ${JSON.stringify({
          agent: "scout",
          task: ATTENTION_TASK,
          async: true,
        })}, and (2) live_signals_probe with {"scenario":"generic","timeoutMs":120000}. Then reply with exactly SIGNALS_DONE.`,
        {
          checks: ({ unified, waitedMs, timeoutMs }) => [
            [
              "the wait ended on the attention signal, not on its window",
              waitedMs > 0 && timeoutMs > 0 && waitedMs < timeoutMs,
              `waited=${String(waitedMs)}ms timeout=${String(timeoutMs)}ms`,
            ],
            [
              "the text names the run and the agent",
              /needs attention in run/i.test(unified),
              unified.replace(/\n/g, " | ").slice(0, 260),
            ],
          ],
        },
      ),
    );
  }

  if (scenarios.includes("supervisor")) {
    // A real request: the child calls `contact_supervisor({reason:"need_decision"})`, which is a
    // blocking supervisor tool (`isBlockingSupervisorTool`, runs/shared/supervisor-wait-timer.js:2-9),
    // so pi-subagents writes its own request file into its own channel dir. Nothing is forged here.
    results.push(
      await scenario(
        "contact_supervisor request",
        `Make exactly two tool calls in this response: (1) subagent with ${JSON.stringify({
          agent: "scout",
          task: SUPERVISOR_TASK,
          async: true,
        })}, and (2) live_signals_probe with {"scenario":"generic","timeoutMs":120000}. Then reply with exactly SIGNALS_DONE.`,
        {
          checks: ({ unified, waitedMs, timeoutMs }) => [
            [
              "the wait ended on the supervisor request, not on its window",
              waitedMs > 0 && timeoutMs > 0 && waitedMs < timeoutMs,
              `waited=${String(waitedMs)}ms timeout=${String(timeoutMs)}ms`,
            ],
            [
              "the text says a subagent needs a supervisor reply",
              // The bus path says "<agent> is waiting for a supervisor reply", the file path says
              // "a subagent needs a supervisor reply"; both are the same ask.
              /needs a supervisor reply|waiting for a supervisor reply/i.test(unified),
              unified.replace(/\n/g, " | ").slice(0, 260),
            ],
          ],
        },
      ),
    );
  }

  await Promise.all(results);
  const collected = await Promise.all(results);
  const failed = collected.reduce(
    (total, result) => total + result.outcomes.filter(([, ok]) => ok === false).length,
    0,
  );
  if (failed > 0) {
    console.error(`\n${String(failed)} live signal check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll live signal checks passed (${String(results.length)} scenario(s)).`);
  process.exit(0);
}

main().then(
  () => undefined,
  (error) => {
    console.error(`live-signals failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
