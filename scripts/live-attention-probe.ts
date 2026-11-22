/**
 * Live regression for the `attention required` early return.
 *
 * Reported failure: `bg_wait_unified({all:true})` returned after **7 ms** with
 * `attention required` while the subagent was still working.
 *
 * Root cause: the tool forwarded `stopOnAttention:true` to native `bg_wait`, and
 * `subagent-wait.js:638` ends that wait on *any* `needs_attention` when the flag is true
 * (`(stopOnAttention || hasSupervisorTool(run))` short-circuits the supervisor test). The
 * ordinary sources of `needs_attention` are an open tool at 240 s and three consecutive
 * failing mutating tools (runs/shared/subagent-control.js:9-12).
 *
 * This probe makes the subagent trip that attention path early (three failing `write` calls)
 * and then keep working for ~20 s. A correct unified wait therefore returns when the subagent
 * *finishes*, not with `attention required`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const log = (line: string): void => console.error(`[live-attention] ${line}`);

export default function probe(pi: ExtensionAPI): void {
  function textOf(outcome: unknown): string {
    const content = (outcome as { result?: { content?: unknown } })?.result?.content;
    if (!Array.isArray(content)) return "<no content>";
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
      .filter((text) => text.length > 0)
      .join("\n");
  }

  pi.registerTool({
    name: "bgwait_attention_probe",
    label: "bg_wait attention regression probe",
    description:
      "Wait with bg_wait_unified({all:true}) while a sibling subagent trips the needs_attention path and keeps running. Returns the raw wait text and the elapsed time. Test-only.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _params, _signal, _onUpdate, ctx: ExtensionContext & { executeTool: Function }) {
      // Give the sibling subagent time to start and to trip the failure-attention path
      // (three consecutive failing mutating tools) before the wait begins.
      await new Promise((resolve) => setTimeout(resolve, 25_000));
      const startedAt = Date.now();
      const unified = textOf(
        await (ctx as { executeTool: Function }).executeTool("bg_wait_unified", { all: true, timeoutMs: 120_000 }),
      );
      const waitedMs = Date.now() - startedAt;
      log(`waited_ms=${String(waitedMs)}`);
      log(`unified=${JSON.stringify(unified)}`);
      return { content: [{ type: "text", text: unified }], details: { waitedMs } };
    },
  });
}
