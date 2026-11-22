/**
 * Automated **mixed-scope** real-Pi test: one async subagent + one background task, one
 * native `bg_wait({all:true})` call covering both.
 *
 * This is the row that proves the *bridge* (not just the unified tool): native `bg_wait`
 * itself reports `N async run(s) and M provider item(s)` and blocks until both are done.
 *
 * Run: node scripts/live-mixed.mjs   (needs `pi` on PATH; ~2 min)
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");

const PROMPT =
  'Make exactly two tool calls in this one response: subagent with {"agent":"scout","task":"Reply with exactly SUBSCOPE_OK and nothing else.","async":true}, and bgwait_mixed_probe with {}. Then reply with exactly: MIXED_DONE';

/**
 * Launch Pi through its own launcher with an argv array and no shell: a prompt containing
 * quotes and braces must reach Pi byte-for-byte, and `cmd.exe` would re-split it.
 */
function piCommand(args) {
  const launcher = process.env["PI_LAUNCHER"] ?? path.join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? "", ".pi", "agent", "bin", "pi-launcher.js");
  return { command: process.execPath, args: [launcher, ...args] };
}

function runPi(timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    // `--installed` verifies the package as installed via settings.json; the default
    // loads it with -e, which also works for a checkout that was never installed.
    const useInstalled = process.argv.includes("--installed");
    const extensionArgs = useInstalled ? ["-e", "./scripts/live-mixed-probe.ts"] : ["-e", ".", "-e", "./scripts/live-mixed-probe.ts"];
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

function parseEvidence(stderr, tag) {
  const evidence = new Map();
  for (const line of stderr.split(/\r?\n/)) {
    const match = new RegExp(`^\\[${tag}\\] (\\S+)=(.*)$`).exec(line);
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
  const evidence = parseEvidence(stderr, "live-mixed");
  if (evidence.size === 0) {
    console.error(stderr.slice(0, 4000));
    throw new Error("no [live-mixed] evidence was produced");
  }

  record("pi exited 0", code === 0, `exit=${String(code)}`);
  record("model replied MIXED_DONE", stdout.includes("MIXED_DONE"));
  record("background task launched", (evidence.get("bg_taskId") ?? "<none>") !== "<none>", evidence.get("bg_taskId"));
  record("background task is provider work", Number(evidence.get("provider_items_before_wait") ?? "0") >= 1, `items=${evidence.get("provider_items_before_wait")}`);

  const nativeText = String(unquote(evidence.get("native_mixed_wait")) ?? "");
  const waitedMs = Number(evidence.get("native_mixed_wait_ms") ?? "0");

  record(
    "native bg_wait reported BOTH scopes in one call",
    /1 async run\(s\) and 1 provider item\(s\)/i.test(nativeText),
    nativeText.split("\n")[0]?.slice(0, 180),
  );
  record(
    "native bg_wait waited for both, not just the first to finish",
    /Outcome:[\s\S]*1 complete[\s\S]*1 provider item\(s\) finished|Outcome:[\s\S]*provider item\(s\) finished[\s\S]*1 complete/i.test(
      nativeText,
    ),
    nativeText.split("\n")[0]?.slice(0, 180),
  );
  record(
    "the wait blocked past the subagent's own runtime (background task outlived it)",
    waitedMs >= 12000,
    `waited=${String(waitedMs)}ms`,
  );
  record("the wait ended done, not on timeout", /\bdone\b/i.test(nativeText) && !/Wait window elapsed/i.test(nativeText));

  const unifiedText = String(unquote(evidence.get("unified_by_id_after")) ?? "");
  record(
    "bg_wait_unified then resolves the exact background task id",
    /completed exit=0/i.test(unifiedText),
    unifiedText.replace(/\n/g, " | ").slice(0, 200),
  );

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    console.error("\nLive evidence:\n" + stderr.split(/\r?\n/).filter((line) => line.startsWith("[live-mixed]")).join("\n"));
    throw new Error(`${String(failed.length)} live check(s) failed: ${failed.map((check) => check.name).join(", ")}`);
  }
  console.log(`\n${String(checks.length)} mixed-scope live checks passed.`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`live-mixed failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
