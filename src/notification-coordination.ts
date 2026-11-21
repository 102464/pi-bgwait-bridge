/**
 * Notification coordination with pi-background-tasks' own completion notifier.
 *
 * Upstream behavior (`src/core/registry.ts:3955`, `src/core/common.ts:383-:419`):
 *
 * ```js
 * this.sendCompletionNotification(frame, { deliverAs: 'followUp', triggerTurn: task.triggerOnCompletion });
 * ```
 *
 * So a task launched with the `bg_run` defaults (`notifyOnCompletion:true`,
 * `triggerOnCompletion:true`) posts a terminal notification **and** asks Pi to start a
 * follow-up agent turn the moment it finishes. If a unified wait is blocking at that time,
 * the session gets two continuations for one event: the wait returns, and the follow-up turn
 * also starts.
 *
 * What this module does — deliberately, because the brief forbids changing another
 * extension's configuration or dropping its notifications:
 *  - It never edits `triggerOnCompletion`, never rewrites `bg_run` arguments, and never
 *    suppresses the notification frame. Those are pi-background-tasks' own decisions.
 *  - It detects the risk per task and reports it in the wait result, carrying the same
 *    terminal facts the notification carries, so a follow-up turn that does start has the
 *    information it needs and nothing was silently lost.
 *  - It recommends the convention (`notifyOnCompletion:true`, `triggerOnCompletion:false`)
 *    for tasks a unified wait will cover.
 */

export interface CompletionPolicy {
  id: string;
  notifyOnCompletion: boolean;
  triggerOnCompletion: boolean;
}

export interface CoordinationReport {
  /** Tasks whose completion will also start a follow-up turn. */
  duplicateWakeRisk: CompletionPolicy[];
  /** Tasks that post a notification without starting a turn: the intended convention. */
  coordinated: CompletionPolicy[];
  /** Tasks with notifications disabled: nothing is delivered, so nothing can collide. */
  silent: CompletionPolicy[];
  lines: string[];
}

function policyOf(task: { id: string; notifyOnCompletion?: unknown; triggerOnCompletion?: unknown }): CompletionPolicy {
  return {
    id: task.id,
    // Upstream defaults are `true` for both (extension.ts:1032-:1033).
    notifyOnCompletion: task.notifyOnCompletion !== false,
    triggerOnCompletion: task.triggerOnCompletion !== false,
  };
}

export function analyseCompletionPolicy(
  tasks: readonly { id: string; notifyOnCompletion?: unknown; triggerOnCompletion?: unknown }[],
): CoordinationReport {
  const duplicateWakeRisk: CompletionPolicy[] = [];
  const coordinated: CompletionPolicy[] = [];
  const silent: CompletionPolicy[] = [];

  for (const task of tasks) {
    const policy = policyOf(task);
    if (!policy.notifyOnCompletion) {
      // `triggerOnCompletion` has no effect while notifications are off (common.ts:417-418).
      silent.push(policy);
    } else if (policy.triggerOnCompletion) {
      duplicateWakeRisk.push(policy);
    } else {
      coordinated.push(policy);
    }
  }

  const lines: string[] = [];
  if (duplicateWakeRisk.length > 0) {
    const ids = duplicateWakeRisk.map((policy) => policy.id).join(", ");
    lines.push(
      `Notification coordination: ${ids} will also start a follow-up turn when it finishes (triggerOnCompletion:true). The notification is not suppressed; if Pi starts that turn, treat it as the same completion this wait already reported and do not re-run the task.`,
      "For tasks a wait will cover, launch with notifyOnCompletion:true and triggerOnCompletion:false.",
    );
  }
  return { duplicateWakeRisk, coordinated, silent, lines };
}

/**
 * Merge policies for the same id seen twice (a launch record and a live snapshot). The live
 * snapshot wins: it reflects the task as pi-background-tasks actually runs it.
 */
export function mergePolicies(
  left: readonly CompletionPolicy[],
  right: readonly CompletionPolicy[],
): CompletionPolicy[] {
  const merged = new Map<string, CompletionPolicy>();
  for (const policy of left) merged.set(policy.id, policy);
  for (const policy of right) merged.set(policy.id, policy);
  return [...merged.values()];
}
