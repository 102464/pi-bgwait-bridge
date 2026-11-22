/**
 * Live regression for the post-reload bug: **only** an async subagent, no background task,
 * one `bg_wait_unified({all:true})` call.
 *
 * The failure it pins: that call used to answer
 * `No background task of this session is running; nothing to wait for.` while a subagent was
 * live, so the model lost the wait entirely.
 *
 * Run: node scripts/live-subagent-only.mjs   (~60 s)
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");

const PROMPT =
  'Make exactly two tool calls in this one response: subagent with {"agent":"scout","task":"Reply with exactly SUBSCOPE_OK and nothing else. Do not use any tools.","async":true}, and bgwait_subagent_only_probe with {}. Then reply with exactly: SUBSCOPE_DONE';

function piCommand(args) {
  const launcher =
    process.env["PI_LAUNCHER"] ??
    path.join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? "", ".pi", "agent", "bin", "pi-launcher.js");
  return { command: process.execPath, args: [launcher, ...args] };
}

function runPi(timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    const useInstalled = process.argv.includes("--installed");
    const extensionArgs = useInstalled
      ? ["-e", "./scripts/live-subagent-only-probe.ts"]
      : ["-e", ".", "-e", "./scripts/live-subagent-only-probe.ts"];
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
    const match = /^\[live-subagent-only\] (\S+)=(.*)$/.exec(line);
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
    throw new Error("no [live-subagent-only] evidence was produced");
  }

  const unified = String(unquote(evidence.get("unified_all_with_subagent")) ?? "");

  record("pi exited 0", code === 0, `exit=${String(code)}`);
  record("model replied SUBSCOPE_DONE", stdout.includes("SUBSCOPE_DONE"));
  record("no background task was running (the reported scenario)", evidence.get("provider_items") === "0", `items=${evidence.get("provider_items")}`);
  record(
    "bg_wait_unified did NOT deny the wait while a subagent ran",
    !/nothing to wait for/i.test(unified),
    unified.replace(/\n/g, " | ").slice(0, 240),
  );
  record(
    "the subagent scope was waited on and its result returned",
    /1 async run\(s\)/i.test(unified) && /1 complete/i.test(unified),
    unified.replace(/\n/g, " | ").slice(0, 240),
  );

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    console.error("\nLive evidence:\n" + stderr.split(/\r?\n/).filter((line) => line.startsWith("[live-subagent-only]")).join("\n"));
    throw new Error(`${String(failed.length)} live check(s) failed: ${failed.map((check) => check.name).join(", ")}`);
  }
  console.log(`\n${String(checks.length)} subagent-only live checks passed.`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`live-subagent-only failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
