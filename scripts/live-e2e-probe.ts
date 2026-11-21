/**
 * Live end-to-end probe: real `pi` process, real pi-background-tasks activation, real
 * native `bg_wait` call with provider work in flight.
 *
 * Load with `-e .` (the bridge) plus `-e ./scripts/live-e2e-probe.ts`, then ask the model to
 * call `bgwait_probe`. The tool starts a real background task through the documented
 * extension `run` operation, waits with the native `bg_wait`, then with `bg_wait_unified`,
 * and returns the raw result texts so a harness can assert on them.
 *
 * Diagnostics go to stderr as `[live-e2e] key=value`; the tool result carries the evidence.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BG_REQUEST = "pi-background-tasks:request:v1";
const BG_RESPONSE = "pi-background-tasks:response:v1";
const HOST_REQUEST = "pi-background-tasks:host:request:v1";
const HOST_RESPONSE = "pi-background-tasks:host:response:v1";
const REGISTRY_KEY = Symbol.for("pi-subagents.background-work.v1");

const log = (line: string): void => console.error(`[live-e2e] ${line}`);

export default function probe(pi: ExtensionAPI): void {
  const pending = new Map<string, (frame: Record<string, unknown>) => void>();
  let counter = 0;

  const listen = (channel: string) =>
    pi.events.on(channel, (data: unknown) => {
      const frame = data as Record<string, unknown>;
      const id = frame["request_id"];
      if (typeof id === "string") pending.get(id)?.(frame);
    });
  listen(BG_RESPONSE);
  listen(HOST_RESPONSE);

  const request = (
    channel: string,
    responseChannel: string,
    operation: string,
    payload: Record<string, unknown>,
    schema: string,
    timeoutMs = 10000,
  ) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      counter += 1;
      const id = `live-${String(counter)}`;
      const timer = setTimeout(() => reject(new Error(`timeout on ${operation}`)), timeoutMs);
      pending.set(id, (frame) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(frame);
      });
      pi.events.emit(channel, { schema_version: schema, request_id: id, operation, payload });
    });

  function providerItems(sessionId: string, sessionFile: string | undefined): { id?: string }[] {
    const registered = (globalThis as Record<symbol, unknown>)[REGISTRY_KEY];
    const provider = (
      registered as { providers?: Map<string, { listActiveWork?: (context: unknown) => { id?: string }[] }> } | undefined
    )?.providers?.get("pi-background-tasks");
    try {
      return (
        provider?.listActiveWork?.({
          sessionId,
          sessionIds: [sessionFile ?? sessionId, sessionId],
          nowMs: Date.now(),
        }) ?? []
      );
    } catch {
      return [];
    }
  }

  function textOf(outcome: unknown): string {
    if (!outcome || typeof outcome !== "object") return "<no outcome>";
    const content = (outcome as { result?: { content?: unknown } }).result?.content;
    if (!Array.isArray(content)) return "<no content>";
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
      .filter((text) => text.length > 0)
      .join("\n");
  }

  pi.registerTool({
    name: "bgwait_probe",
    label: "bg_wait live probe",
    description:
      "Start one real background task, then wait for it with native bg_wait and bg_wait_unified in the same session. Returns the raw wait texts. Test-only.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _params, signal, _onUpdate, ctx: ExtensionContext & { executeTool: Function }) {
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
      const evidence: string[] = [
        `sessionId=${sessionId}`,
        `sessionFile=${sessionFile ?? "<none>"}`,
        `bg_wait_registered=${String(pi.getAllTools().some((tool) => tool.name === "bg_wait"))}`,
        `bg_wait_unified_registered=${String(pi.getAllTools().some((tool) => tool.name === "bg_wait_unified"))}`,
      ];

      // 1. Trusted activation record.
      const subscribe = await request(HOST_REQUEST, HOST_RESPONSE, "subscribe", { clientId: "live-e2e" }, "pi-background-tasks.host-request.v1");
      const hostResult = (subscribe["result"] ?? {}) as Record<string, unknown>;
      evidence.push(`host_activationId=${String(hostResult["activationId"])}`);
      evidence.push(`host_session_matches=${String(hostResult["sessionId"] === sessionId)}`);

      // 2. A real task that stays running long enough to be waited on.
      const run = await request(
        BG_REQUEST,
        BG_RESPONSE,
        "run",
        {
          name: "live probe task",
          command: process.platform === "win32" ? "ping -n 4 127.0.0.1 > nul" : "sleep 4",
          isAgent: false,
          notifyOnCompletion: false,
          triggerOnCompletion: false,
        },
        "pi-background-tasks.extension-request.v1",
      );
      const runResult = (run["result"] ?? {}) as Record<string, unknown>;
      const taskId = typeof runResult["id"] === "string" ? runResult["id"] : undefined;
      evidence.push(`run_taskId=${taskId ?? "<none>"}`);
      evidence.push(`run_status=${String(runResult["status"] ?? "<none>")}`);

      await new Promise((resolve) => setTimeout(resolve, 2000));
      const items = providerItems(sessionId, sessionFile);
      evidence.push(`provider_items=${items.length}`);
      evidence.push(`provider_contains_task=${String(taskId !== undefined && items.some((item) => item.id === taskId))}`);

      // 3. Native bg_wait with provider work in flight: must not answer "No active async runs".
      const native = textOf(await (ctx as { executeTool: Function }).executeTool("bg_wait", { all: true, stopOnAttention: false, timeoutMs: 15000 }));
      evidence.push(`native_bg_wait=${JSON.stringify(native)}`);

      // 4. Unified wait by exact id, after the task has finished.
      if (taskId !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        const unified = textOf(await (ctx as { executeTool: Function }).executeTool("bg_wait_unified", { ids: [taskId], timeoutMs: 15000 }));
        evidence.push(`unified_wait=${JSON.stringify(unified)}`);
      }

      for (const line of evidence) log(line);
      return { content: [{ type: "text", text: evidence.join("\n") }], details: { evidence } };
    },
  });
}
