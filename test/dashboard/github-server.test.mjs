// GitHub connection, repository list, private-repository confirmation, watch list: server endpoints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../../dashboard/server.mjs";
import { createStore } from "../../dashboard/store.mjs";
import { QUESTIONS } from "../../src/questions.mjs";

function fakeAnswers(over = {}) {
  const answers = {};
  for (const k of Object.keys(QUESTIONS)) answers[k] = { type: QUESTIONS[k].type, noul: 0.05 };
  Object.assign(answers, over);
  answers.severity = { type: "score", probabilities: { 0: 0, 1: 1, 2: 0, 3: 0 } };
  return { model: "jev-mock", answers, usage: { input_tokens: 100, output_tokens: 3 } };
}
const issuesFixture = (n) => ({
  project: { name: "demo", description: "A demo" },
  issues: Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}`, body: "It crashes.", url: `https://github.com/o/r/issues/${i + 1}`, existingLabels: [] })),
});
async function start(opts = {}) {
  const server = createServer({
    askJev: opts.askJev || (async () => fakeAnswers({ is_bug: { type: "noul", noul: 0.95 } })),
    indexHtml: "<html>ok</html>", examples: { project: { name: "p", description: "d" }, issues: [] }, hasKey: true, ...opts.server,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => { server.closeAllConnections?.(); server.close(); } };
}
const post = (base, path, body, headers = {}) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

const fakeGithub = (over = {}) => {
  const g = {
    connected: false, calls: [],
    status: () => ({ connected: g.connected, user: g.connected ? { login: "me" } : null, deviceFlow: false, canReadPrivate: true }),
    getToken: () => (g.connected ? "SECRET_GH_TOKEN" : undefined),
    connectCli: async () => { g.connected = true; },
    deviceStart: async (scope) => { g.calls.push(["deviceStart", scope]); return { user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }; },
    devicePoll: async () => ({ status: "pending" }),
    disconnect: () => { g.connected = false; },
    get: async (path) => {
      g.calls.push(["get", path]);
      if (path.startsWith("/user/repos")) return [
        { full_name: "me/pub", private: false, fork: false, archived: false, open_issues_count: 3, description: "d", pushed_at: "2026-01-01", html_url: "https://github.com/me/pub" },
        { full_name: "me/secret", private: true, fork: false, archived: false, open_issues_count: 1, description: "", pushed_at: "2026-01-02", html_url: "https://github.com/me/secret" },
      ];
      if (path === "/repos/me/pub") return { private: false };
      if (path === "/repos/me/secret") return { private: true };
      throw Object.assign(new Error("Not found"), { status: 404 });
    },
    ...over,
  };
  return g;
};

test("status, connect-cli and disconnect; the token appears in no response", async () => {
  const g = fakeGithub();
  const s = await start({ server: { github: g } });
  assert.equal((await (await fetch(s.base + "/api/github/status")).json()).connected, false);
  const connected = await (await post(s.base, "/api/github/connect-cli", {})).text();
  assert.equal(JSON.parse(connected).user.login, "me");
  assert.ok(!connected.includes("SECRET_GH_TOKEN"));
  const off = await (await post(s.base, "/api/github/disconnect", {})).json();
  assert.equal(off.connected, false);
  s.close();
});

test("repos returns 401 when not connected; the list and the 'watched' flag when connected", async () => {
  const g = fakeGithub();
  const store = createStore(null);
  store.setWatch(["me/pub"]);
  const s = await start({ server: { github: g, store } });
  assert.equal((await fetch(s.base + "/api/github/repos")).status, 401);
  g.connected = true;
  const j = await (await fetch(s.base + "/api/github/repos")).json();
  assert.equal(j.repos.length, 2);
  assert.equal(j.repos.find((r) => r.full_name === "me/pub").watched, true);
  assert.equal(j.repos.find((r) => r.full_name === "me/secret").private, true);
  s.close();
});

test("all GitHub POST routes reject foreign origins", async () => {
  const s = await start({ server: { github: fakeGithub() } });
  for (const path of ["/api/github/connect-cli", "/api/github/device/start", "/api/github/disconnect", "/api/watch/repo", "/api/analyze-issue"]) {
    assert.equal((await post(s.base, path, {}, { Origin: "https://evil.example" })).status, 403, path);
  }
  s.close();
});

test("github issues: analyzed issues are marked and link formats are accepted", async () => {
  const store = createStore(null);
  store.put({ key: "o/r#1", analyzedAt: 1, labels: ["bug"] });
  const s = await start({ server: { store, github: fakeGithub(), fetchIssues: async () => ({ ...issuesFixture(2), isPrivate: false }) } });
  const j = await (await fetch(s.base + "/api/github/issues?repo=" + encodeURIComponent("https://github.com/o/r/issues"))).json();
  assert.equal(j.repo, "o/r");
  assert.deepEqual(j.issues[0].analyzed, { key: "o/r#1", labels: ["bug"] });
  assert.equal(j.issues[1].analyzed, null);
  assert.equal((await fetch(s.base + "/api/github/issues?repo=bad")).status, 400);
  s.close();
});

test("private repo: nothing reaches Jev without confirmation (scan and analyze-issue); works with confirmation", async () => {
  let jevCalls = 0;
  const priv = { project: { name: "secret", description: "" }, issues: issuesFixture(2).issues, isPrivate: true };
  const store = createStore(null);
  const s = await start({
    askJev: async () => { jevCalls++; return fakeAnswers({ is_bug: { type: "noul", noul: 0.9 } }); },
    server: {
      store, github: fakeGithub(), fetchIssues: async () => priv,
      fetchOne: async () => ({ project: priv.project, issue: priv.issues[0], isPrivate: true }),
    },
  });
  const r1 = await post(s.base, "/api/scan", { repo: "me/secret" });
  assert.equal(r1.status, 403);
  assert.equal((await r1.json()).needsConfirm, true);
  const r2 = await post(s.base, "/api/analyze-issue", { repo: "me/secret", number: 1 });
  assert.equal(r2.status, 403);
  assert.equal(jevCalls, 0, "private text must not be sent without confirmation");
  const r3 = await post(s.base, "/api/analyze-issue", { repo: "me/secret", number: 1, confirmPrivate: true });
  assert.equal(r3.status, 200);
  assert.equal(jevCalls, 1);
  assert.ok(store.has("me/secret#1"), "the result is stored");
  assert.equal((await post(s.base, "/api/scan", { repo: "me/secret", confirmPrivate: true, limit: 2 })).status, 200);
  s.close();
});

test("analyze-issue: a public repo works without confirmation; a wrong number gives 400", async () => {
  const s = await start({ server: { store: createStore(null), github: fakeGithub(), fetchOne: async () => ({ project: { name: "p", description: "" }, issue: issuesFixture(1).issues[0], isPrivate: false }) } });
  assert.equal((await post(s.base, "/api/analyze-issue", { repo: "o/r", number: 5 })).status, 200);
  assert.equal((await post(s.base, "/api/analyze-issue", { repo: "o/r", number: 0 })).status, 400);
  assert.equal((await post(s.base, "/api/analyze-issue", { repo: "o/r", number: "x" })).status, 400);
  s.close();
});

test("watch/repo: adding and removing a public repo is stored; a private repo requires confirmation", async () => {
  const g = fakeGithub(); g.connected = true;
  const store = createStore(null);
  const s = await start({ server: { github: g, store } });
  assert.deepEqual((await (await post(s.base, "/api/watch/repo", { repo: "me/pub", action: "add" })).json()).repos, ["me/pub"]);
  const priv = await post(s.base, "/api/watch/repo", { repo: "me/secret", action: "add" });
  assert.equal(priv.status, 403);
  assert.equal((await priv.json()).needsConfirm, true);
  assert.deepEqual(store.getWatch(), ["me/pub"], "must not be added without confirmation");
  assert.deepEqual((await (await post(s.base, "/api/watch/repo", { repo: "me/secret", action: "add", confirmPrivate: true })).json()).repos, ["me/pub", "me/secret"]);
  assert.deepEqual((await (await post(s.base, "/api/watch/repo", { repo: "me/pub", action: "remove" })).json()).repos, ["me/secret"]);
  assert.equal((await post(s.base, "/api/watch/repo", { repo: "x", action: "add" })).status, 400);
  assert.equal((await post(s.base, "/api/watch/repo", { repo: "o/r", action: "boom" })).status, 400);
  s.close();
});

test("device/start: scope can only be 'repo' or empty", async () => {
  const g = fakeGithub();
  const s = await start({ server: { github: g } });
  await post(s.base, "/api/github/device/start", { scope: "admin:org" });
  await post(s.base, "/api/github/device/start", { scope: "repo" });
  assert.deepEqual(g.calls.filter((c) => c[0] === "deviceStart").map((c) => c[1]), ["", "repo"]);
  s.close();
});
