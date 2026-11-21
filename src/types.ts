/** Minimal host types this bridge needs. Kept local so the package runs without host imports. */

export interface EventBusLike {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}

export interface Clock {
  now(): number;
}

export interface WaitTargetTask {
  id: string;
  name?: string;
  command?: string;
  status: string;
  startTime: number;
  endTime?: number;
  exitCode?: number | null;
  error?: string;
  outputPath?: string;
  isAgent?: boolean;
  triggerOnCompletion?: boolean;
  notifyOnCompletion?: boolean;
  reloadSurvival?: { sessionId?: string } | undefined;
  [key: string]: unknown;
}

export function isActiveStatus(status: string): boolean {
  return status === "running" || status === "queued";
}

export function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

/** `noUncheckedIndexedAccess` friendly first element. */
export function first<T>(values: readonly T[]): T | undefined {
  return values.length > 0 ? values[0] : undefined;
}
