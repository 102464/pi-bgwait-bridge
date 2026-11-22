/**
 * Live probe for the three signal classes that must end `bg_wait_unified` (operator
 * requirement, 2026-11-22). Test-only; not part of the package surface.
 *
 * Must run in `--mode rpc`: that mode reports `hasUI: true`, the only mode in which pi-intercom
 * steers an inbound message into a *busy* session instead of auto-replying and dismissing it
 * (`pi-intercom/index.ts:1360-1384`). A `-p` session is useless for this scenario — its ask is
 * answered by the extension itself and the wait sees nothing.
 *
 * Every scenario logs `[live-signals] key=value` lines on stderr; `scripts/live-signals.mjs`
 * asserts on them.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import path from "node:path";

const log = (line: string): void => console.error(`[live-signals] ${line}`);

function textOf(outcome: unknown): string {
  const content = (outcome as { result?: { content?: unknown } })?.result?.content;
  if (!Array.isArray(content)) return "<no content>";
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

const INTERCOM_CLI =
  process.env["PI_INTERCOM_CLI"] ??
  path.join(
    process.env["USERPROFILE"] ?? process.env["HOME"] ?? "",
    ".pi",
    "agent",
    "npm",
    "node_modules",
    "pi-intercom",
    "cli.mjs",
  );

/**
 * Ask this session a question from *another process* after `delayMs`, over the real broker.
 * Delayed so the ask lands while the wait blocks — an ask that predates the wait is, by design,
 * not a signal (a healthy 40-minute run's old notice must not cut a fresh wait short).
 */
/**
 * Send the ask from another process over the real broker, after `delayMs`.
 *
 * The delay matters twice over: the ask has to land *inside* the wait window (an ask created
 * before the wait armed is, by design, not a signal), and pi-intercom only assigns its own
 * session id after it registers — so the target is read at ask time, not at load time.
 */
function scheduleAsker(getTarget: () => string, text: string, delayMs: number): void {
  const timer = setTimeout(() => {
    const target = getTarget();
    log(`ask_spawned target=${target}`);
    if (target.length === 0) {
      log("ask_error=no intercom session id");
      return;
    }
    const child = spawn(
      process.execPath,
      [INTERCOM_CLI, "ask", "--to", target, "--text", text, "--timeout-ms", "45000", "--json"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (chunk: unknown) => log(`asker_stdout=${JSON.stringify(String(chunk).slice(0, 300))}`));
    child.stderr.on("data", (chunk: unknown) => log(`asker_stderr=${JSON.stringify(String(chunk).slice(0, 300))}`));
    child.on("error", (error: unknown) => log(`asker_error=${JSON.stringify(String(error))}`));
  }, delayMs);
  timer.unref?.();
}

export default function probe(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    log(`hasUI=${String((ctx as { hasUI?: boolean }).hasUI)}`);
    log(`mode=${String((ctx as { mode?: string }).mode)}`);
    log(`intercom_session_id=${String(process.env["PI_INTERCOM_SESSION_ID"] ?? "<unset>")}`);
  });

  pi.registerTool({
    name: "live_signals_probe",
    label: "live signal-class probe",
    description:
      "Run one live scenario against bg_wait_unified: an intercom ask routed in from another process, a subagent attention notice, or a subagent supervisor request. Returns the raw wait text. Test-only.",
    parameters: {
      type: "object",
      properties: {
        scenario: { type: "string", description: "intercom-ask | generic (another scenario's signal)" },
        timeoutMs: { type: "number", description: "Wait window in ms." },
        askDelayMs: { type: "number", description: "Delay before the intercom ask is sent." },
      },
      required: ["scenario"],
      additionalProperties: false,
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const scenario = String((params as { scenario?: unknown }).scenario ?? "");
      const timeoutMs = Number((params as { timeoutMs?: unknown }).timeoutMs ?? 90_000);
      const askDelayMs = Number((params as { askDelayMs?: unknown }).askDelayMs ?? 5_000);
      if (scenario === "intercom-ask") {
        scheduleAsker(
          () => String(process.env["PI_INTERCOM_SESSION_ID"] ?? ""),
          "which arm should I take for the next RTL batch?",
          askDelayMs,
        );
        log(`ask_scheduled target=${String(process.env["PI_INTERCOM_SESSION_ID"] ?? "")} delay_ms=${String(askDelayMs)}`);
      }
      const startedAt = Date.now();
      log(`scenario=${scenario}`);
      log(`wait_started_at=${String(startedAt)}`);
      const unified = textOf(
        await (ctx as { executeTool: Function }).executeTool("bg_wait_unified", {
          all: true,
          timeoutMs,
          stopOnAttention: false,
        }),
      );
      const waitedMs = Date.now() - startedAt;
      log(`waited_ms=${String(waitedMs)}`);
      log(`timeout_ms=${String(timeoutMs)}`);
      log(`unified=${JSON.stringify(unified)}`);
      return { content: [{ type: "text", text: unified }], details: { scenario, waitedMs } };
    },
  });
}
