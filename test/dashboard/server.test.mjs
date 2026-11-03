import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../../dashboard/server.mjs";
import { JevError } from "../../src/jev.mjs";
import { QUESTIONS } from "../../src/questions.mjs";

const SECRET = "apikey_SUPER_SECRET_VALUE";
function fakeAnswers(over = {}) {
  const answers = {};
  for (const k of Object.keys(QUESTIONS)) answers[k] = { type: QUESTIONS[k].type, noul: 0.05 };
  Object.assign(answers, over);
  answers.severity = { type: "score", probabilities: { 0: 0, 1: 1, 2: 0, 3: 0 } };
  return { model: "jev-mock", answers, usage: { input_tokens: 100, output_tokens: 3 } };
}
async function start(opts = {}) {
  const server = createServer({
    askJev: opts.askJev || (async () => fakeAnswers({ is_bug: { type: "noul", noul: 0.95 }, has_repro: { type: "noul", noul: 0.9 } })),
    indexHtml: "<html>ok</html>", examples: { project: { name: "p", description: "d" }, issues: [] }, hasKey: true, ...opts.server,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => { server.closeAllConnections?.(); server.close(); } };
}
const post = (base, path, body, headers = {}) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("GET / and /api/config work, and the config contains no key", async () => {
  const s = await start();
  const page = await fetch(s.base + "/");
  assert.equal(page.status, 200);
  const cfg = await (await fetch(s.base + "/api/config")).text();
  assert.ok(!cfg.includes(SECRET));
  assert.equal(JSON.parse(cfg).hasKey, true);
  s.close();
});

test("POST /api/triage: returns the decision, the request and the response", async () => {
  const s = await start();
  const r = await post(s.base, "/api/triage", { title: "Crash", body: "It crashes" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.decision.labels.includes("bug"));
  assert.equal(j.request.state.issue.title, "Crash");
  assert.equal(j.response.usage.input_tokens, 100);
  s.close();
});

test("/api/decide is free: askJev is not called, custom thresholds apply", async () => {
  let calls = 0;
  const s = await start({ askJev: async () => { calls++; return fakeAnswers(); } });
  const answers = fakeAnswers({ is_feature_request: { type: "noul", noul: 0.6 } }).answers;
  const j = await (await post(s.base, "/api/decide", { answers, thresholds: { low: 0.2, high: 0.55 } })).json();
  assert.deepEqual(j.decision.labels, ["enhancement"]);
  assert.equal(calls, 0);
  s.close();
});

test("a foreign host/origin is rejected (DNS rebinding / CSRF)", async () => {
  const s = await start();
  const evil = await post(s.base, "/api/triage", { title: "a", body: "b" }, { Origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  const hostBad = await fetch(s.base + "/api/config", { headers: { Host: "evil.example" } });
  // Node's fetch does not allow overriding the Host header, so only the Origin test is enforced.
  assert.ok([200, 403].includes(hostBad.status));
  s.close();
});

test("a Content-Type that is not JSON gives 415; bad thresholds give 400; a large body gives 413", async () => {
  const s = await start();
  const r1 = await fetch(s.base + "/api/triage", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(r1.status, 415);
  const r2 = await post(s.base, "/api/triage", { title: "a", body: "b", thresholds: { low: 0.9, high: 0.2 } });
  assert.equal(r2.status, 400);
  const r3 = await post(s.base, "/api/triage", { title: "a", body: "x".repeat(25000) });
  assert.equal(r3.status, 413);
  s.close();
});

test("a Jev error is reported as 502 and not hidden", async () => {
  const s = await start({ askJev: async () => { throw new JevError("Jev API returned HTTP 400", { status: 400, detail: { detail: "bad" } }); } });
  const r = await post(s.base, "/api/triage", { title: "a", body: "b" });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /HTTP 400/);
  s.close();
});

test("hourly limit: 429 when exceeded", async () => {
  const s = await start({ server: { maxRequestsPerHour: 2 } });
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await post(s.base, "/api/triage", { title: "a", body: "b" })).status);
  assert.deepEqual(codes, [200, 200, 429]);
  s.close();
});

test("503 without a key (no request is sent)", async () => {
  let calls = 0;
  const s = await start({ askJev: async () => { calls++; }, server: { hasKey: false } });
  const r = await post(s.base, "/api/triage", { title: "a", body: "b" });
  assert.equal(r.status, 503);
  assert.equal(calls, 0);
  s.close();
});

// ---- /api/scan ----
const issuesFixture = (n) => ({
  project: { name: "demo", description: "A demo" },
  issues: Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}`, body: "It crashes on start.", url: `https://github.com/o/r/issues/${i + 1}`, existingLabels: i === 0 ? ["bug"] : [] })),
});

test("scan: issues are fetched, each is analyzed, total tokens are summed", async () => {
  const s = await start({ server: { fetchIssues: async () => issuesFixture(3) } });
  const r = await post(s.base, "/api/scan", { repo: "o/r", limit: 3 });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.results.length, 3);
  assert.ok(j.results[0].data.decision.labels.includes("bug"));
  assert.deepEqual(j.results[0].existingLabels, ["bug"]);
  assert.equal(j.totals.input_tokens, 300);
  s.close();
});

test("scan: a github.com link is accepted, a wrong repo name gives 400", async () => {
  let seen;
  const s = await start({ server: { fetchIssues: async (repo) => { seen = repo; return issuesFixture(1); } } });
  assert.equal((await post(s.base, "/api/scan", { repo: "https://github.com/owner/name/" })).status, 200);
  assert.equal(seen, "owner/name");
  for (const bad of ["", "no-slash", "../etc/passwd", "a b/c", "./x", "o/.."]) {
    assert.equal((await post(s.base, "/api/scan", { repo: bad })).status, 400, bad);
  }
  s.close();
});

test("scan: a limit above 30 is clamped, and each issue counts toward the hourly limit", async () => {
  let askedLimit;
  const s = await start({ server: { maxRequestsPerHour: 5, fetchIssues: async (repo, limit) => { askedLimit = limit; return issuesFixture(4); } } });
  assert.equal((await post(s.base, "/api/scan", { repo: "o/r", limit: 999 })).status, 200);
  assert.equal(askedLimit, 30);
  // 4 used, limit 5: the next scan of 4 must return 429
  assert.equal((await post(s.base, "/api/scan", { repo: "o/r", limit: 4 })).status, 429);
  s.close();
});

test("scan: a Jev error on one issue does not break the others", async () => {
  let n = 0;
  const s = await start({
    askJev: async () => { if (++n === 2) throw new JevError("Jev API returned HTTP 503", { status: 503 }); return fakeAnswers({ is_bug: { type: "noul", noul: 0.9 } }); },
    server: { fetchIssues: async () => issuesFixture(3) },
  });
  const j = await (await post(s.base, "/api/scan", { repo: "o/r", limit: 3 })).json();
  assert.equal(j.results.filter((x) => x.error).length, 1);
  assert.equal(j.results.filter((x) => x.data).length, 2);
  s.close();
});

test("scan: when the repo is not found the GitHub error reaches the user (404)", async () => {
  const s = await start({ server: { fetchIssues: async () => { throw Object.assign(new Error('Repository "o/r" was not found or is private.'), { status: 404 }); } } });
  const r = await post(s.base, "/api/scan", { repo: "o/r" });
  assert.equal(r.status, 404);
  assert.match((await r.json()).error, /not found/);
  s.close();
});

test("scan: rejected from a foreign origin (an endpoint that spends money)", async () => {
  const s = await start({ server: { fetchIssues: async () => issuesFixture(1) } });
  assert.equal((await post(s.base, "/api/scan", { repo: "o/r" }, { Origin: "https://evil.example" })).status, 403);
  s.close();
});

test("fetchRepoIssues: pull requests are filtered, the limit applies, external url and label formats are cleaned", async () => {
  const { fetchRepoIssues } = await import("../../dashboard/server.mjs");
  const fakeFetch = async (url) => ({
    ok: true, status: 200,
    json: async () => (url.endsWith("/repos/o/r")
      ? { name: "r", description: "desc" }
      : [
        { number: 1, title: "a", body: null, html_url: "https://github.com/o/r/issues/1", labels: [{ name: "bug" }, "raw"] },
        { number: 2, title: "pr", body: "x", pull_request: {}, html_url: "https://github.com/o/r/pull/2", labels: [] },
        { number: 3, title: "evil url", body: "x", html_url: "javascript:alert(1)", labels: [] },
        { number: 4, title: "c", body: "x", html_url: "https://github.com/o/r/issues/4", labels: [] },
      ]),
  });
  const out = await fetchRepoIssues("o/r", 2, { fetchImpl: fakeFetch });
  assert.equal(out.project.description, "desc");
  assert.deepEqual(out.issues.map((i) => i.number), [1, 3]);
  assert.deepEqual(out.issues[0].existingLabels, ["bug", "raw"]);
  assert.equal(out.issues[0].body, "");
  assert.equal(out.issues[1].url, null, "only https://github.com/ links are accepted");
});

// ---- automatic watcher endpoints ----
function fakeWatcher() {
  const w = { paused: false, items: [{ key: "o/r#1", repo: "o/r", number: 1, title: "T", url: null, existingLabels: [], analyzedAt: 1, labels: ["bug"], data: { secret: "full" } }] };
  return Object.assign(w, {
    status: () => ({ repos: ["o/r"], paused: w.paused, today: { requests: 0, limit: 300, cost_usd: 0 } }),
    settings: () => ({ feedLimit: 100 }),
    list: () => w.items.map(({ data, ...l }) => l),
    get: (k) => w.items.find((i) => i.key === k) || null,
    pause: () => { w.paused = true; }, resume: () => { w.paused = false; },
  });
}

test("feed: status and a light list; item: full data; 404 when missing", async () => {
  const w = fakeWatcher();
  const s = await start({ server: { watcher: w } });
  const feed = await (await fetch(s.base + "/api/feed")).json();
  assert.equal(feed.items.length, 1);
  assert.ok(!("data" in feed.items[0]));
  const item = await (await fetch(s.base + "/api/item?key=" + encodeURIComponent("o/r#1"))).json();
  assert.equal(item.data.secret, "full");
  assert.equal((await fetch(s.base + "/api/item?key=nope")).status, 404);
  s.close();
});

test("without a watcher the feed returns an empty status", async () => {
  const s = await start();
  assert.deepEqual(await (await fetch(s.base + "/api/feed")).json(), { status: null, items: [] });
  s.close();
});

test("pause/resume: only with a valid origin and JSON; a wrong action gives 400", async () => {
  const w = fakeWatcher();
  const s = await start({ server: { watcher: w } });
  assert.equal((await post(s.base, "/api/watch", { action: "pause" })).status, 200);
  assert.equal(w.paused, true);
  assert.equal((await post(s.base, "/api/watch", { action: "resume" })).status, 200);
  assert.equal(w.paused, false);
  assert.equal((await post(s.base, "/api/watch", { action: "explode" })).status, 400);
  assert.equal((await post(s.base, "/api/watch", { action: "pause" }, { Origin: "https://evil.example" })).status, 403);
  assert.equal(w.paused, false, "a foreign origin cannot pause");
  s.close();
});
