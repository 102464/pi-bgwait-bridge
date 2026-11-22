/**
 * Probe for the post-reload regression: only an async subagent, no background task, one
 * `bg_wait_unified({all:true})`. Reports the raw tool text on stderr as
 * `[live-subagent-only] unified_all_with_subagent=<json>`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const REGISTRY_KEY = Symbol.for("pi-subagents.background-work.v1");

const log = (line: string): void => console.error(`[live-subagent-only] ${line}`);

export default function probe(pi: ExtensionAPI): void {
  function textOf(outcome: unknown): string {
    const content = (outcome as { result?: { content?: unknown } })?.result?.content;
    if (!Array.isArray(content)) return "<no content>";
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
      .filter((text) => text.length > 0)
      .join("\n");
  }

  function providerItems(sessionId: string, sessionFile: string | undefined): number {
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
    name: "bgwait_subagent_only_probe",
    label: "bg_wait subagent-only probe",
    description:
      "Wait with bg_wait_unified({all:true}) when no background task exists and an async subagent is running (the caller launches it in the same message). Returns the raw wait text. Test-only.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _params, _signal, _onUpdate, ctx: ExtensionContext & { executeTool: Function }) {
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
      // Let the sibling subagent launch first (Pi preflights sequentially, then runs concurrently).
      await new Promise((resolve) => setTimeout(resolve, 800));
      const items = providerItems(sessionId, sessionFile);
      log(`provider_items=${String(items)}`);
      log(`bg_wait_registered=${String(pi.getAllTools().some((tool) => tool.name === "bg_wait"))}`);
      log(`bg_wait_unified_registered=${String(pi.getAllTools().some((tool) => tool.name === "bg_wait_unified"))}`);

      const unified = textOf(
        await (ctx as { executeTool: Function }).executeTool("bg_wait_unified", { all: true, timeoutMs: 60000 }),
      );
      log(`unified_all_with_subagent=${JSON.stringify(unified)}`);
      return { content: [{ type: "text", text: unified }], details: {} };
    },
  });
}
