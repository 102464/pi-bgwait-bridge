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

/**
 * The same ask with the other blocking reason. Upstream requires no `message` for it
 * (`native-supervisor-channel.js:128`), but a supervisor has to know what is being asked, so
 * the interview payload carries the questions and the request stays blocking exactly as a
 * decision does (`expectsReply = params.reason !== "progress_update"`, :133).
 */
const INTERVIEW_TASK =
  "Call contact_supervisor exactly once with reason \"interview_request\" and this interview payload: {\"title\":\"RTL batch interview\",\"questions\":[{\"id\":\"arm\",\"prompt\":\"which arm should I take for the next RTL batch?\"}]}. Then stop and wait for the reply. After the reply arrives, reply with exactly SIGNALS_OK.";

/**
 * Holds the wait open with real work: a subagent that sleeps for a minute. It trips no
 * attention path (the tool-open threshold upstream is 240 s), so the only signal in the wait
 * is the intercom ask the probe schedules.
 */
const INTERCOM_HOLDER_TASK =
  "Run exactly one bash command that sleeps for 60 seconds (ping -n 61 127.0.0.1 > nul on Windows). Then reply with exactly SIGNALS_OK.";

const ATTENTION_TASK =
  "First use the bash tool three times with a command that must fail: echo x > C:/Users/ldl/AppData/Local/Temp/bgw-attn-missing-dir/f.txt. Each write must fail with a non-zero exit code. Then run one command that sleeps: ping -n 26 127.0.0.1 > nul. Then reply with exactly SIGNALS_OK.";

/**
 * Failing-tool run shaped for deterministic escalation: pi-subagents counts *consecutive* mutating
 * failures (`failedToolAttemptsBeforeAttention`), and parallel calls inside one assistant message
 * do not always count as separate attempts, so each failing call is given its own message.
 */
const ATTENTION_TASK_SEQUENTIAL =
  "Call the bash tool once with a command that must fail: echo x > C:/Users/ldl/AppData/Local/Temp/bgw-attn-missing-dir/f.txt . Wait for the result, then repeat that exact same failing call twice more, one bash call per message. After the third failure, run one bash command that sleeps: ping -n 26 127.0.0.1 > nul. Then reply with exactly SIGNALS_OK.";

/**
 * The same failing-tool run, but launched with `notifyChannels: ["async","intercom"]` — no
 * `event` channel. pi-subagents then writes its control record with `channels` lacking `event`
 * (`subagent-runner.js:2440-2457`), so `deliverControlRecord` skips `subagent:control-event`
 * (`async-job-tracker.js:205-215`) and emits **only** `subagent:control-intercom`. Nothing can
 * shadow the intercom path, so a wait that ends here ended on the intercom channel itself.
 */
const INTERCOM_ONLY_CONTROL = { failedToolAttemptsBeforeAttention: 1, notifyChannels: ["async", "intercom"] };
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
    /**
     * This workspace runs `pi-deferred-context-engine` (DCE), which defers every tool that is not
     * declared active and refuses a deferred tool both from the model and from `executeTool`
     * ("Tool <name> not found"). A scripted scenario has to pin the two tools it uses, so the
     * session is started against a config copy with `bg_wait_unified` and `live_signals_probe`
     * in `alwaysActive`/`neverDefer` (`scripts/live-dce-config.json`, derived from the user's own
     * config so nothing else changes). Without DCE installed this variable is simply ignored.
     */
    const dceConfig = path.join(packageRoot, "scripts", "live-dce-config.json");
    const child = spawn(command, args, {
      cwd: packageRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_DEFERRED_TOOLS_CONFIG: dceConfig },
    });
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

/** The line that states why the wait ended (`Wait ended after … because …`). */
function verdictLine(text) {
  return text
    .split(/\r?\n/)
    .find((line) => line.startsWith("Wait ended") || line.startsWith("Wait aborted")) ?? "";
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
  const scenarios = (process.env["LIVE_SIGNALS_SCENARIOS"] ?? "intercom,intercom-control,attention,supervisor,supervisor-interview,idle,any-subagent").split(",");
  const results = [];

  if (scenarios.includes("intercom")) {
    // A live async subagent keeps the wait genuinely open, so the ask that lands 5 s later is
    // arriving *during* a wait over real work rather than into an idle session — an idle
    // session correctly answers "nothing to wait for" at once (see the `idle` scenario).
    results.push(
      await scenario(
        "intercom ask routed from another process",
        `Make exactly two tool calls in this response: (1) subagent with ${JSON.stringify({
          agent: "scout",
          task: INTERCOM_HOLDER_TASK,
          async: true,
        })}, and (2) live_signals_probe with {"scenario":"intercom-ask","timeoutMs":90000,"askDelayMs":5000}. Then reply with exactly SIGNALS_DONE.`,
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

  if (scenarios.includes("intercom-control")) {
    // Real path, nothing forged: pi-subagents' own `subagent:control-intercom` event for an
    // owned run, with the `event` channel withheld so it is the only signal in the wait.
    results.push(
      await scenario(
        "subagent control-intercom message (event channel withheld)",
        `Make exactly two tool calls in this response: (1) subagent with ${JSON.stringify({
          agent: "scout",
          task: ATTENTION_TASK_SEQUENTIAL,
          async: true,
          control: INTERCOM_ONLY_CONTROL,
        })}, and (2) live_signals_probe with {"scenario":"generic","timeoutMs":120000}. Then reply with exactly SIGNALS_DONE.`,
        {
          checks: ({ unified, waitedMs, timeoutMs }) => [
            [
              "the wait ended on the intercom signal, not on its window",
              waitedMs > 0 && timeoutMs > 0 && waitedMs < timeoutMs,
              `waited=${String(waitedMs)}ms timeout=${String(timeoutMs)}ms`,
            ],
            [
              "the text reports an intercom message from the run",
              /sent an intercom message in run \S+/i.test(unified),
              unified.replace(/\n/g, " | ").slice(0, 300),
            ],
            [
              "the attention channel was not the trigger (it was withheld)",
              // Only the *verdict* line decides the signal class; the routed intercom notice
              // below it quotes upstream's own "needs attention" copy by design.
              !/because \S+ needs attention in run/i.test(verdictLine(unified)),
              verdictLine(unified).slice(0, 300),
            ],
          ],
        },
      ),
    );
  }

  if (scenarios.includes("idle")) {
    // The operator's own reproduction (2026-11-22): `bg_wait_unified({all:true,
    // stopOnAttention:true, timeoutMs:1200000})` in a session with no work at all printed
    // `Waiting 5m11s for 0 async run(s) and 0 provider item(s).` and returned only when the
    // window ran out. Native `bg_wait` answers that session immediately, so the unified wait
    // must too: a 20-minute window with nothing in it is not a wait, it is a hang.
    results.push(
      await scenario(
        "idle session, 20-minute window",
        'Make exactly one tool call: live_signals_probe with {"scenario":"idle","timeoutMs":1200000,"stopOnAttention":true}. Then reply with exactly SIGNALS_DONE.',
        {
          checks: ({ unified, waitedMs, timeoutMs }) => [
            [
              "an idle session answers at once instead of riding out the window",
              waitedMs > 0 && waitedMs < 30_000,
              `waited=${String(waitedMs)}ms timeout=${String(timeoutMs)}ms`,
            ],
            [
              "the text states there is nothing to wait for",
              /nothing to wait for|no background task/i.test(unified),
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

  if (scenarios.includes("any-subagent")) {
    // Reported by the operator (`any=true`): with no background task of its own and one async
    // subagent live, the call answered at once and reported a native failure it had itself
    // caused. `any` must wait for the subagent half exactly like `all` does.
    results.push(
      await scenario(
        "any:true with only a subagent",
        `Make exactly two tool calls in this response: (1) subagent with ${JSON.stringify({
          agent: "scout",
          task: "Reply with exactly SCOUT_OK and stop.",
          async: true,
        })}, and (2) live_signals_probe with {"scenario":"any","timeoutMs":120000}. Then reply with exactly SIGNALS_DONE.`,
        {
          checks: ({ unified, waitedMs, timeoutMs }) => [
            [
              "the `any` wait covered the subagent instead of returning at once",
              waitedMs > 1000 && timeoutMs > 0 && waitedMs < timeoutMs,
              `waited=${String(waitedMs)}ms timeout=${String(timeoutMs)}ms`,
            ],
            [
              "the text carries the native answer, not a self-inflicted native failure",
              // Native's settled wordings differ per mode: `all` says `... async run(s) ...`,
              // `any` says `N of M run(s) finished`. What must never appear is a native failure
              // this tool itself caused, or a missing-tool answer.
              !/nested call failed|Operation aborted|Tool bg_wait not found/i.test(unified) &&
                /async run\(s\)|run\(s\) finished|Nothing to wait for/i.test(unified),
              unified.split(String.fromCharCode(10)).join(" | ").slice(0, 300),
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
        "contact_supervisor need_decision request",
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
              "the text names the request file it read",
              // `src/unified-tool.ts` prints `(request <id>, reason <reason>, run <id>, from <agent>)`
              // from `SupervisorRequestDetail`, which only the request directory can supply. The
              // bus notice cannot produce this sentence.
              /needs a supervisor reply \(request \S+, reason need_decision, run \S+/i.test(unified),
              unified.replace(/\n/g, " | ").slice(0, 300),
            ],
            [
              "the verdict line is the supervisor class, not an attention notice",
              /^Wait ended .*needs a supervisor reply/i.test(verdictLine(unified)),
              verdictLine(unified),
            ],
          ],
        },
      ),
    );
  }

  if (scenarios.includes("supervisor-interview")) {
    // The second blocking reason the objective names. Upstream blocks on it identically, and the
    // probe must report it from the same request directory — an interview request that answered
    // only on `subagent:control-event` would be the same defect as `need_decision` on the bus.
    results.push(
      await scenario(
        "contact_supervisor interview_request",
        `Make exactly two tool calls in this response: (1) subagent with ${JSON.stringify({
          agent: "scout",
          task: INTERVIEW_TASK,
          async: true,
        })}, and (2) live_signals_probe with {"scenario":"generic","timeoutMs":120000}. Then reply with exactly SIGNALS_DONE.`,
        {
          checks: ({ unified, waitedMs, timeoutMs }) => [
            [
              "the wait ended on the interview request, not on its window",
              waitedMs > 0 && timeoutMs > 0 && waitedMs < timeoutMs,
              `waited=${String(waitedMs)}ms timeout=${String(timeoutMs)}ms`,
            ],
            [
              "the text names the interview request it read",
              /needs a supervisor reply \(request \S+, reason interview_request, run \S+/i.test(unified),
              unified.replace(/\n/g, " | ").slice(0, 300),
            ],
            [
              "the verdict line is the supervisor class, not an attention notice",
              /^Wait ended .*needs a supervisor reply/i.test(verdictLine(unified)),
              verdictLine(unified),
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
