/**
 * `src/work-watch.ts`: the wait's disk signals must arrive as OS change notifications, not
 * as poll ticks.
 *
 * Two rows at each end of the contract:
 *  - a file written into a watched folder wakes the wait immediately (this is what makes an
 *    intercom ask or a supervisor request observable at all — neither is a Pi message event
 *    while a blocking tool holds the turn);
 *  - a folder that does not exist when the watch starts is armed once it appears, and an
 *    unwatchable path degrades to the poll fallback instead of throwing.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import path from "node:path";
import { createWorkWatch } from "../src/work-watch.ts";

function dir(): string {
  return mkdtempSync(path.join(tmpdir(), "bgw-watch-"));
}

test("a file written into a watched folder wakes the caller without polling", async () => {
  const watched = dir();
  const startedAt = Date.now();
  let wokeAt = -1;
  const watch = createWorkWatch({
    dirs: () => [watched],
    onChange: () => {
      if (wokeAt < 0) wokeAt = Date.now();
    },
  });
  const stop = watch.start();
  assert.deepEqual(watch.watching(), [watched], "the folder must be watched as soon as it exists");
  writeFileSync(path.join(watched, "ask-1.json"), "{}", "utf8");
  for (let waited = 0; wokeAt < 0 && waited < 5_000; waited += 25) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  stop();
  assert.ok(wokeAt >= 0, "fs.watch must report the new file");
  // Generous ceiling: an OS notification is sub-100 ms here; 1.5 s would also pass a poll tick,
  // so the bound is deliberately tighter than the poll interval to prove no timer did this.
  assert.ok(wokeAt - startedAt < 1_500, `wake must not depend on a timer, took ${String(wokeAt - startedAt)}ms`);
  rmSync(watched, { recursive: true, force: true });
});
test("a folder created after the watch starts is armed, and its first file wakes the caller", async () => {
  const parent = dir();
  const late = path.join(parent, "pending-asks"); // pi-intercom creates this dir lazily
  let changes = 0;
  const watch = createWorkWatch({ dirs: () => [late], onChange: () => { changes += 1; } });
  const stop = watch.start();
  assert.deepEqual(watch.watching(), [], "a missing folder is skipped, not watched");
  mkdirSync(late, { recursive: true });
  writeFileSync(path.join(late, "ask-1.json"), "{}", "utf8");
  // Nothing was watching that folder when the file landed, so the refresh that runs on the next
  // caller-driven wake arms it; this row asserts that arming is possible after creation.
  watch.refresh();
  assert.deepEqual(watch.watching(), [late], "refresh must arm a folder that appeared later");
  writeFileSync(path.join(late, "ask-2.json"), "{}", "utf8");
  for (let waited = 0; changes === 0 && waited < 5_000; waited += 25) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  stop();
  assert.ok(changes > 0, "a change in the late folder must reach onChange");
  rmSync(parent, { recursive: true, force: true });
});
test("an unwatchable path is skipped, and disposing closes every watcher", () => {
  const logs: string[] = [];
  const watch = createWorkWatch({
    dirs: () => [path.join(tmpdir(), "bgw-watch-does-not-exist")],
    onChange: () => {},
    log: (line) => logs.push(line),
  });
  const stop = watch.start();
  assert.deepEqual(watch.watching(), [], "a nonexistent folder must not be watched");
  assert.deepEqual(logs, [], "a nonexistent folder is not an error, so nothing is logged");
  stop();
  assert.deepEqual(watch.watching(), [], "dispose must close the watchers");
});
test("start is idempotent after dispose: no watcher is created again", () => {
  const watched = dir();
  const watch = createWorkWatch({ dirs: () => [watched], onChange: () => {} });
  const stop = watch.start();
  assert.equal(watch.watching().length, 1);
  stop();
  assert.deepEqual(watch.watching(), []);
  watch.refresh();
  assert.deepEqual(watch.watching(), [], "a disposed watch never re-arms");
  rmSync(watched, { recursive: true, force: true });
});
