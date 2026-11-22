/**
 * Automated real-Pi integration test (task-8 "真实 Pi 集成" row).
 *
 * Spawns an actual `pi` process with both extensions loaded (`-e . -e ./scripts/live-e2e-probe.ts`),
 * asks it to call `bgwait_probe` once, and asserts on the `[live-e2e]` evidence lines.
 *
 * What only this can prove:
 *  - a real pi-background-tasks activation answers and names *this* session (ownership)
 *  - a real task launched via the documented EventBus `run` operation becomes provider work
 *  - **native `bg_wait` no longer answers "No active async runs or registered provider work
 *    in this session" while that task runs** — the core requirement
 *  - `bg_wait_unified` resolves the same task by exact id afterwards
 *
 * Run: node scripts/live-e2e.mjs   (needs `pi` on PATH; ~90 s)
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");

const PROMPT =
  "Call the bgwait_probe tool exactly once, then reply with exactly: PROBE_DONE";

/**
 * Launch Pi through its own launcher with an argv array and no shell: a prompt containing
 * quotes and braces must reach Pi byte-for-byte, and `cmd.exe` would re-split it.
 */
function piCommand(args) {
  const launcher =
    process.env["PI_LAUNCHER"] ??
    path.join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? "", ".pi", "agent", "bin", "pi-launcher.js");
  return { command: process.execPath, args: [launcher, ...args] };
}

function runPi(timeoutMs = 240_000) {
  return new Promise((resolve, reject) => {
    // `--installed` verifies the package as installed via settings.json; the default
    // loads it with -e, which also works for a checkout that was never installed.
    const useInstalled = process.argv.includes("--installed");
    const extensionArgs = useInstalled ? ["-e", "./scripts/live-e2e-probe.ts"] : ["-e", ".", "-e", "./scripts/live-e2e-probe.ts"];
    const { command, args } = piCommand(["-p", PROMPT, ...extensionArgs, "--no-session"]);
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
    const match = /^\[live-e2e\] (\S+)=(.*)$/.exec(line);
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
    throw new Error("no [live-e2e] evidence was produced; the probe extension did not run");
  }

  record("pi exited 0", code === 0, `exit=${String(code)}`);
  record("model replied PROBE_DONE", stdout.includes("PROBE_DONE"));
  record("bg_wait is registered in the live session", evidence.get("bg_wait_registered") === "true");
  record("bg_wait_unified is registered in the live session", evidence.get("bg_wait_unified_registered") === "true");
  record(
    "host activation belongs to this session",
    evidence.get("host_session_matches") === "true",
    `activation=${evidence.get("host_activationId") ?? "?"}`,
  );
  record("a real background task was launched", (evidence.get("run_taskId") ?? "<none>") !== "<none>", evidence.get("run_taskId"));
  record("the task is provider work visible to bg_wait", evidence.get("provider_contains_task") === "true", `items=${evidence.get("provider_items")}`);

  const nativeText = String(unquote(evidence.get("native_bg_wait")) ?? "");
  record(
    "native bg_wait no longer says 'No active async runs'",
    nativeText.length > 0 && !/No active async runs/i.test(nativeText),
    nativeText.slice(0, 200),
  );
  record(
    "native bg_wait waited on the provider item and finished",
    /1 provider item\(s\)/i.test(nativeText) && /done/i.test(nativeText),
    nativeText.slice(0, 200),
  );

  const unifiedText = String(unquote(evidence.get("unified_wait")) ?? "");
  record(
    "bg_wait_unified resolved the exact task id",
    unifiedText.length > 0 && /completed exit=0/i.test(unifiedText),
    unifiedText.replace(/\n/g, " | ").slice(0, 220),
  );

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    console.error("\nLive evidence:\n" + stderr.split(/\r?\n/).filter((line) => line.startsWith("[live-e2e]")).join("\n"));
    throw new Error(`${String(failed.length)} live check(s) failed: ${failed.map((check) => check.name).join(", ")}`);
  }
  console.log(`\n${String(checks.length)} live checks passed.`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`live-e2e failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
