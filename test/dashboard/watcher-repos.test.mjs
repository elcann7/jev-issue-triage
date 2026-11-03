import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../../dashboard/store.mjs";
import { createWatcher } from "../../dashboard/watcher.mjs";

const okAnalyze = async () => ({ request: {}, response: { usage: { input_tokens: 1, output_tokens: 1 } }, decision: { labels: ["bug", "triaged"] } });
const noTimers = { setTimer: () => ({ unref() {} }), clearTimer: () => {} };

test("watched repo list: the config seed when the store has none; afterwards the store is the source of truth", () => {
  const store = createStore(null);
  const w = createWatcher({ config: { repos: ["seed/one"] }, store, analyze: okAnalyze, fetchIssues: async () => ({ project: {}, issues: [] }), ...noTimers });
  assert.deepEqual(w.repos(), ["seed/one"]);
  w.addRepo("me/two");
  assert.deepEqual(w.repos(), ["seed/one", "me/two"]);
  w.removeRepo("seed/one");
  assert.deepEqual(w.repos(), ["me/two"]);
  assert.deepEqual(store.getWatch(), ["me/two"]);
});

test("the token function is called on every check (a new token is used after GitHub is connected)", async () => {
  let current;
  const seen = [];
  const w = createWatcher({
    config: { repos: ["o/r"] }, store: createStore(null), analyze: okAnalyze,
    fetchIssues: async (repo, limit, opts) => { seen.push(opts.token); return { project: { name: "r", description: "" }, issues: [] }; },
    githubToken: () => current, ...noTimers,
  });
  await w.pollOnce();
  current = "tok";
  await w.pollOnce();
  assert.deepEqual(seen, [undefined, "tok"]);
});

test("a removed repo is no longer checked", async () => {
  const polled = [];
  const store = createStore(null);
  const w = createWatcher({
    config: { repos: ["a/x", "b/y"] }, store, analyze: okAnalyze,
    fetchIssues: async (repo) => { polled.push(repo); return { project: { name: "n", description: "" }, issues: [] }; }, ...noTimers,
  });
  await w.pollOnce();
  w.removeRepo("a/x");
  await w.pollOnce();
  assert.deepEqual(polled, ["a/x", "b/y", "b/y"]);
});
