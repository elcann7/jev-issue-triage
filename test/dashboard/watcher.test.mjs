import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../dashboard/store.mjs";
import { createWatcher } from "../../dashboard/watcher.mjs";

const mkIssues = (nums) => ({ project: { name: "r", description: "d" }, issues: nums.map((n) => ({ number: n, title: `Issue ${n}`, body: "b", url: `https://github.com/o/r/issues/${n}`, existingLabels: [] })) });
const okAnalyze = async () => ({ request: {}, response: { usage: { input_tokens: 1000, output_tokens: 100 } }, decision: { labels: ["bug", "triaged"] } });

function setup(over = {}) {
  const store = over.store || createStore(null);
  const calls = { fetch: 0, analyze: 0 };
  const watcher = createWatcher({
    config: { repos: ["o/r"], pollMinutes: 5, maxNewPerPoll: 10, dailyMaxRequests: 300, ...(over.config || {}) },
    fetchIssues: over.fetchIssues || (async () => { calls.fetch++; return mkIssues([3, 2, 1]); }),
    analyze: over.analyze || (async (...a) => { calls.analyze++; return okAnalyze(...a); }),
    store,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  return { watcher, store, calls };
}

test("only NEW issues are analyzed; the second check sends nothing", async () => {
  const { watcher, calls } = setup();
  assert.equal((await watcher.pollOnce()).analyzed, 3);
  assert.equal(calls.analyze, 3);
  assert.equal((await watcher.pollOnce()).analyzed, 0);
  assert.equal(calls.analyze, 3, "must not be analyzed again");
});

test("when a new issue arrives only it is analyzed", async () => {
  let batch = [2, 1];
  const { watcher, calls } = setup({ fetchIssues: async () => mkIssues(batch) });
  await watcher.pollOnce();
  batch = [3, 2, 1];
  await watcher.pollOnce();
  assert.equal(calls.analyze, 3);
});

test("daily limit: analysis stops when exceeded", async () => {
  const { watcher, calls } = setup({ config: { dailyMaxRequests: 2 } });
  await watcher.pollOnce();
  assert.equal(calls.analyze, 2);
  assert.equal(watcher.status().limitReached, true);
  await watcher.pollOnce();
  assert.equal(calls.analyze, 2);
});

test("pause: the check does nothing; resume: it works", async () => {
  const { watcher, calls } = setup();
  watcher.pause();
  assert.equal((await watcher.pollOnce()).skipped, "paused");
  assert.equal(calls.fetch, 0);
  watcher.resume();
  await watcher.pollOnce();
  assert.equal(calls.analyze, 3);
});

test("an analysis error on one issue does not stop the others, and the error shows in status", async () => {
  let n = 0;
  const { watcher, store } = setup({ analyze: async () => { if (++n === 2) throw new Error("Jev down"); return okAnalyze(); } });
  const r = await watcher.pollOnce();
  assert.equal(r.analyzed, 2);
  assert.equal(store.list().length, 2);
  assert.match(watcher.status().lastError, /Analysis failed/);
});

test("GitHub error: does not stop, the error is in status; the next check recovers", async () => {
  let fail = true;
  const { watcher } = setup({ fetchIssues: async () => { if (fail) throw new Error("rate limit"); return mkIssues([1]); } });
  await watcher.pollOnce();
  assert.match(watcher.status().lastError, /Could not read o\/r/);
  fail = false;
  assert.equal((await watcher.pollOnce()).analyzed, 1);
  assert.equal(watcher.status().lastError, null);
});

test("persistence: after a restart the same issue is not analyzed again (file)", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "jev-store-")), "store.json");
  const a = setup({ store: createStore(path) });
  await a.watcher.pollOnce();
  const b = setup({ store: createStore(path) });
  await b.watcher.pollOnce();
  assert.equal(b.calls.analyze, 0);
  assert.equal(b.store.today().requests, 3, "the daily counter is persisted too");
});

test("list returns light items (without data), get returns full; status computes the cost", async () => {
  const { watcher } = setup();
  await watcher.pollOnce();
  const light = watcher.list(10);
  assert.equal(light.length, 3);
  assert.ok(!("data" in light[0]));
  assert.ok(watcher.get("o/r#1").data);
  const st = watcher.status();
  assert.equal(st.today.requests, 3);
  assert.ok(Math.abs(st.today.cost_usd - (3000 * 0.042) / 1e6) < 1e-12);
});

test("store: when maxItems is exceeded the oldest are removed; a corrupt file starts empty", async () => {
  const { writeFileSync } = await import("node:fs");
  const path = join(mkdtempSync(join(tmpdir(), "jev-store-")), "s.json");
  writeFileSync(path, "{not json");
  const s = createStore(path, { maxItems: 2 });
  assert.equal(s.list().length, 0);
  for (let i = 1; i <= 3; i++) s.put({ key: `k${i}`, analyzedAt: i });
  assert.deepEqual(s.list().map((x) => x.key), ["k3", "k2"]);
});
