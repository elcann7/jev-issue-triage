import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../dashboard/store.mjs";
import { createWatcher, parseSettings } from "../../dashboard/watcher.mjs";
import { createServer } from "../../dashboard/server.mjs";
import { QUESTIONS } from "../../src/questions.mjs";

const okAnalyze = async () => ({ request: {}, response: { usage: { input_tokens: 1000, output_tokens: 10 } }, decision: { labels: ["bug", "triaged"] } });
const mkIssues = (n) => ({ project: { name: "r", description: "" }, issues: Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `I${i + 1}`, body: "b", url: null, existingLabels: [] })) });

test("parseSettings: valid values are accepted, bounds are inclusive", () => {
  assert.deepEqual(parseSettings({ dailyMaxRequests: 1, maxNewPerPoll: 100, pollMinutes: 60, feedLimit: 500 }), { dailyMaxRequests: 1, maxNewPerPoll: 100, pollMinutes: 60, feedLimit: 500 });
  assert.deepEqual(parseSettings({ dailyMaxRequests: "300" }), { dailyMaxRequests: 300 }, "a numeric string is accepted");
  assert.deepEqual(parseSettings({}), {});
});

test("parseSettings: out-of-range, fractional, text and invalid feedLimit are rejected (400)", () => {
  for (const bad of [{ dailyMaxRequests: 0 }, { dailyMaxRequests: 2001 }, { maxNewPerPoll: 101 }, { pollMinutes: 0 }, { pollMinutes: 61 }, { dailyMaxRequests: 2.5 }, { dailyMaxRequests: "abc" }, { dailyMaxRequests: null }, { feedLimit: 77 }]) {
    assert.throws(() => parseSettings(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
});

test("store: settings are written to the file and survive reopening", () => {
  const path = join(mkdtempSync(join(tmpdir(), "jev-set-")), "s.json");
  const a = createStore(path);
  assert.equal(a.getSettings(), null);
  a.setSettings({ dailyMaxRequests: 900 });
  assert.deepEqual(createStore(path).getSettings(), { dailyMaxRequests: 900 });
});

test("watcher: changes to the daily limit and the per-check count apply immediately", async () => {
  const asked = [];
  const store = createStore(null);
  const w = createWatcher({
    config: { repos: ["o/r"], dailyMaxRequests: 300, maxNewPerPoll: 10 }, store, analyze: okAnalyze,
    fetchIssues: async (repo, limit) => { asked.push(limit); return mkIssues(5); },
    setTimer: () => ({ unref() {} }), clearTimer: () => {},
  });
  await w.pollOnce();
  assert.equal(asked[0], 10);
  w.updateSettings({ maxNewPerPoll: 40, dailyMaxRequests: 6 });
  assert.equal(w.settings().maxNewPerPoll, 40);
  assert.equal(w.status().today.limit, 6);
  await w.pollOnce();
  assert.equal(asked[1], 40, "the new count is used on the next check");
  assert.equal(w.status().limitReached, false);
  w.updateSettings({ dailyMaxRequests: 5 });
  assert.equal(w.status().limitReached, true, "5 issues are already analyzed and the limit is 5");
  await w.pollOnce();
  assert.equal(asked.length, 2, "no GitHub request is sent once the limit is reached");
});

test("watcher: updateSettings updates partially, earlier settings remain; an invalid value changes nothing", () => {
  const store = createStore(null);
  const w = createWatcher({ config: { repos: [] }, store, analyze: okAnalyze, fetchIssues: async () => mkIssues(0), setTimer: () => ({ unref() {} }), clearTimer: () => {} });
  w.updateSettings({ dailyMaxRequests: 800 });
  w.updateSettings({ pollMinutes: 15 });
  assert.equal(w.settings().dailyMaxRequests, 800);
  assert.equal(w.settings().pollMinutes, 15);
  assert.throws(() => w.updateSettings({ dailyMaxRequests: -1 }), (e) => e.status === 400);
  assert.equal(w.settings().dailyMaxRequests, 800);
});

test("watcher: when the interval changes, the next check is rescheduled with the new delay", async () => {
  const delays = [];
  const w = createWatcher({
    config: { repos: [] }, store: createStore(null), analyze: okAnalyze, fetchIssues: async () => mkIssues(0),
    setTimer: (fn, ms) => { delays.push(ms); return { unref() {} }; }, clearTimer: () => {},
  });
  w.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(delays.at(-1), 5 * 60_000);
  w.updateSettings({ pollMinutes: 20 });
  assert.equal(delays.at(-1), 20 * 60_000);
});

// ---- server ----
function fakeAnswers(over = {}) {
  const answers = {};
  for (const k of Object.keys(QUESTIONS)) answers[k] = { type: QUESTIONS[k].type, noul: 0.05 };
  Object.assign(answers, over);
  answers.severity = { type: "score", probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 } };
  return { model: "m", answers, usage: { input_tokens: 100, output_tokens: 1 } };
}
async function start(server = {}, askJev) {
  const s = createServer({ askJev: askJev || (async () => fakeAnswers({ is_bug: { type: "noul", noul: 0.95 } })), indexHtml: "x", examples: {}, hasKey: true, ...server });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${s.address().port}`, close: () => { s.closeAllConnections?.(); s.close(); } };
}
const post = (base, path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("server: POST /api/settings saves and shows up in status; an invalid value gives 400; a foreign origin gives 403", async () => {
  const store = createStore(null);
  const watcher = createWatcher({ config: { repos: [] }, store, analyze: okAnalyze, fetchIssues: async () => mkIssues(0), setTimer: () => ({ unref() {} }), clearTimer: () => {} });
  const s = await start({ watcher, store });
  const ok = await post(s.base, "/api/settings", { dailyMaxRequests: 1500, maxNewPerPoll: 50 });
  assert.equal(ok.status, 200);
  const st = (await ok.json()).status;
  assert.equal(st.settings.dailyMaxRequests, 1500);
  assert.equal(st.today.limit, 1500);
  assert.equal((await post(s.base, "/api/settings", { dailyMaxRequests: 99999 })).status, 400);
  assert.equal((await post(s.base, "/api/settings", { feedLimit: 7 })).status, 400);
  assert.equal((await post(s.base, "/api/settings", { dailyMaxRequests: 10 }, { Origin: "https://evil.example" })).status, 403);
  assert.equal(watcher.settings().dailyMaxRequests, 1500, "a foreign origin cannot change settings");
  s.close();
});

test("server: watcher yoxdursa /api/settings 404", async () => {
  const s = await start();
  assert.equal((await post(s.base, "/api/settings", { dailyMaxRequests: 10 })).status, 404);
  s.close();
});

test("server: the feed list length is cut according to feedLimit", async () => {
  const store = createStore(null);
  for (let i = 1; i <= 60; i++) store.put({ key: `o/r#${i}`, repo: "o/r", number: i, title: `T${i}`, url: null, existingLabels: [], analyzedAt: i, labels: ["bug"], data: {} });
  const watcher = createWatcher({ config: { repos: [] }, store, analyze: okAnalyze, fetchIssues: async () => mkIssues(0), setTimer: () => ({ unref() {} }), clearTimer: () => {} });
  const s = await start({ watcher, store });
  assert.equal((await (await fetch(s.base + "/api/feed")).json()).items.length, 60, "default is 100");
  await post(s.base, "/api/settings", { feedLimit: 25 });
  const f = await (await fetch(s.base + "/api/feed")).json();
  assert.equal(f.items.length, 25);
  assert.equal(f.items[0].number, 60, "the newest are kept");
  s.close();
});

test("server: each scan result comes with tier, rank and reasons", async () => {
  const fetchIssues = async () => ({ project: { name: "p", description: "" }, isPrivate: false, issues: [{ number: 1, title: "A", body: "b", url: null, existingLabels: ["bug"] }] });
  const s = await start({ fetchIssues });
  const j = await (await post(s.base, "/api/scan", { repo: "o/r", limit: 1 })).json();
  const r = j.results[0];
  assert.equal(r.tier, "urgent");
  assert.ok(Array.isArray(r.reasons) && r.reasons.length > 0);
  assert.ok(r.labels.includes("bug"));
  assert.deepEqual(r.existingLabels, ["bug"]);
  s.close();
});
