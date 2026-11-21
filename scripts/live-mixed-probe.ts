/**
 * Mixed-scope live probe.
 *
 * The model launches a real async subagent (`subagent({async:true})`) in the **same
 * assistant message** as this tool, so both start together (Pi preflights sibling tool
 * calls sequentially, then runs them concurrently). This tool launches a real background
 * task that runs longer than the subagent, then waits with native `bg_wait({all:true})`.
 *
 * The proof it produces:
 *  - native `bg_wait` reports *both* scopes (`N async run(s) and M provider item(s)`)
 *  - it keeps blocking after the subagent finishes (the elapsed wait exceeds the subagent's
 *    own runtime and matches the background task's)
 *  - it returns only once the background task is terminal
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BG_REQUEST = "pi-background-tasks:request:v1";
const BG_RESPONSE = "pi-background-tasks:response:v1";
const REGISTRY_KEY = Symbol.for("pi-subagents.background-work.v1");

const log = (line: string): void => console.error(`[live-mixed] ${line}`);

export default function probe(pi: ExtensionAPI): void {
  const pending = new Map<string, (frame: Record<string, unknown>) => void>();
  let counter = 0;
  pi.events.on(BG_RESPONSE, (data: unknown) => {
    const frame = data as Record<string, unknown>;
    const id = frame["request_id"];
    if (typeof id === "string") pending.get(id)?.(frame);
  });

  const request = (operation: string, payload: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      counter += 1;
      const id = `mixed-${String(counter)}`;
      const timer = setTimeout(() => reject(new Error(`timeout on ${operation}`)), 10000);
      pending.set(id, (frame) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(frame);
      });
      pi.events.emit(BG_REQUEST, {
        schema_version: "pi-background-tasks.extension-request.v1",
        request_id: id,
        operation,
        payload,
      });
    });

  function textOf(outcome: unknown): string {
    const content = (outcome as { result?: { content?: unknown } })?.result?.content;
    if (!Array.isArray(content)) return "<no content>";
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
      .filter((text) => text.length > 0)
      .join("\n");
  }

  function providerCount(sessionId: string, sessionFile: string | undefined): number {
    const registered = (globalThis as Record<symbol, unknown>)[REGISTRY_KEY];
    const provider = (
      registered as { providers?: Map<string, { listActiveWork?: (context: unknown) => unknown[] }> } | undefined
    )?.providers?.get("pi-background-tasks");
    try {
      return (
        provider?.listActiveWork?.({
          sessionId,
          sessionIds: [sessionFile ?? sessionId, sessionId],
          nowMs: Date.now(),
        }) ?? []
      ).length;
    } catch {
      return -1;
    }
  }

  pi.registerTool({
    name: "bgwait_mixed_probe",
    label: "bg_wait mixed live probe",
    description:
      "Launch one background task and wait for it together with any async subagent the caller launched in the same message. Returns the raw wait texts. Test-only.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _params, _signal, _onUpdate, ctx: ExtensionContext & { executeTool: Function }) {
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
      const evidence: string[] = [`sessionId=${sessionId}`];

      // The background task must outlive the subagent so "subagent finished first, wait
      // kept going" is observable.
      const run = await request("run", {
        name: "mixed probe task",
        command: process.platform === "win32" ? "ping -n 22 127.0.0.1 > nul" : "sleep 21",
        isAgent: false,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const runResult = (run["result"] ?? {}) as Record<string, unknown>;
      const taskId = typeof runResult["id"] === "string" ? runResult["id"] : undefined;
      evidence.push(`bg_taskId=${taskId ?? "<none>"}`);
      evidence.push(`bg_task_started=${String(runResult["status"] ?? "<none>")}`);

      await new Promise((resolve) => setTimeout(resolve, 2000));
      evidence.push(`provider_items_before_wait=${String(providerCount(sessionId, sessionFile))}`);

      // One wait covering both scopes. `all:true` must hold until the background task ends,
      // even though the subagent finishes earlier.
      const startedAt = Date.now();
      const native = textOf(
        await (ctx as { executeTool: Function }).executeTool("bg_wait", {
          all: true,
          stopOnAttention: false,
          timeoutMs: 60000,
        }),
      );
      const waitedMs = Date.now() - startedAt;
      evidence.push(`native_mixed_wait_ms=${String(waitedMs)}`);
      evidence.push(`native_mixed_wait=${JSON.stringify(native)}`);

      if (taskId !== undefined) {
        const unified = textOf(
          await (ctx as { executeTool: Function }).executeTool("bg_wait_unified", { ids: [taskId], timeoutMs: 20000 }),
        );
        evidence.push(`unified_by_id_after=${JSON.stringify(unified)}`);
      }

      for (const line of evidence) log(line);
      return { content: [{ type: "text", text: evidence.join("\n") }], details: { evidence } };
    },
  });
}
