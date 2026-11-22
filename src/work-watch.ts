/**
 * Change-watch for the folders a wait reads, so a signal that lands on disk ends the wait at
 * once instead of on the next poll tick.
 *
 * Why this exists (operator request, 2026-11-22): the three signal classes a unified wait must
 * honour do not all arrive on an event bus.
 *
 *  - pi-subagents' attention / intercom notices do (the two control channels this package
 *    already subscribes to), so they never needed a poll.
 *  - A pi-intercom ask leaves no bus event at all: `sendIncomingBrokerMessage` only *queues*
 *    the message while a blocking tool holds the turn (`agent-session.js:1967-1975`), and
 *    `message_end` fires when the agent loop drains the queue at a turn boundary. The durable
 *    evidence is pi-intercom's pending-ask ledger file (`broker/broker.ts:1367-1381`).
 *  - A supervisor request is likewise a file (`native-supervisor-channel.js:139-159`), and the
 *    reply that resolves it is a second file.
 *
 * So a wait has to read the disk either way. This module turns that read from "every tick"
 * into "when the folder actually changes": `fs.watch` is an OS notification (ReadDirectoryChangesW
 * / inotify / kqueue), not a timer, and it is created `persistent:false` so it can never keep the
 * process alive or outlive the tool call. The per-second poll stays as the fallback — a watch can
 * fail on a platform or a network path, and a missed wake would mean a missed signal.
 *
 * Deliberate limits:
 *  - Non-recursive, like the OS primitive underneath. A folder that appears after the watch
 *    started is picked up on the next wake (`refresh()` re-arms), and a signal inside it is
 *    still seen by the poll fallback.
 *  - Errors are fail-closed: an unwatchable path is skipped, never thrown into the wait.
 */
import * as fs from "node:fs";

export interface WorkWatchOptions {
  /**
   * Folders to observe, resolved on every (re)arm so a folder created mid-wait starts
   * counting. Missing folders are skipped, not watched.
   */
  dirs: () => readonly string[];
  /** Called on every change notification, after newly visible folders have been armed. */
  onChange: () => void;
  /** Diagnostic sink; a watcher that could not be armed says why here. */
  log?: (line: string) => void;
}

export interface WorkWatch {
  /** Arm the watchers and return a disposer that closes them all. Idempotent. */
  start(): () => void;
  /** Re-check `dirs()` and arm any folder that appeared since the last call. */
  refresh(): void;
  /** Folders currently being watched, for diagnostics and tests. */
  watching(): readonly string[];
}

/**
 * One watcher per folder. `fs.watch` reports a write as several notifications on some
 * platforms (rename + change for the same file); the consumer's wake is idempotent, so
 * coalescing is not needed to avoid a loop, only to avoid redundant work.
 */
export function createWorkWatch(options: WorkWatchOptions): WorkWatch {
  const log = options.log ?? (() => {});
  const watchers = new Map<string, fs.FSWatcher>();
  let disposed = false;

  function close(folder: string, watcher: fs.FSWatcher): void {
    if (watchers.get(folder) !== watcher) return;
    watchers.delete(folder);
    try {
      watcher.close();
    } catch {
      /* already closed */
    }
  }

  function arm(folder: string): void {
    if (disposed || watchers.has(folder)) return;
    let watcher: fs.FSWatcher;
    try {
      // Not recursive: the primitive is per-folder, and a recursive watch is not portable.
      watcher = fs.watch(folder, { persistent: false }, () => fire());
    } catch (error) {
      log(`watch skipped for ${folder}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    watchers.set(folder, watcher);
    // The emitter types the payload; no unparsed `unknown` is carried past the boundary.
    watcher.on("error", (error) => {
      log(`watch dropped for ${folder}: ${error.message}`);
      close(folder, watcher);
    });
  }

  /**
   * A notification means "something under one of the watched folders changed". Folders that
   * appeared since the last notification are armed first, so a waiter that starts before a
   * channel folder exists still gets the immediate wake once it does.
   */
  function fire(): void {
    if (disposed) return;
    options.onChange();
    refresh();
  }

  function refresh(): void {
    if (disposed) return;
    for (const folder of options.dirs()) {
      if (watchers.has(folder)) continue;
      try {
        if (!fs.statSync(folder).isDirectory()) continue;
      } catch {
        continue; // not created yet
      }
      arm(folder);
    }
  }

  return {
    start() {
      if (disposed) return () => {};
      refresh();
      return () => {
        disposed = true;
        for (const [folder, watcher] of watchers) close(folder, watcher);
      };
    },
    refresh,
    watching: () => [...watchers.keys()],
  };
}
