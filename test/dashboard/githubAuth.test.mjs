import { test } from "node:test";
import assert from "node:assert/strict";
import { createGithubSession, AuthError } from "../../dashboard/githubAuth.mjs";

const TOKEN = "gho_SECRET_TOKEN_VALUE";
const resp = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] }, json: async () => body });

test("CLI connect: user and scopes are read, status does not reveal the token", async () => {
  const s = createGithubSession({
    execGhToken: async () => TOKEN,
    fetchImpl: async (url, init) => { assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`); return resp(200, { login: "elcann7", name: "Elcan" }, { "x-oauth-scopes": "gist, read:org, repo, workflow" }); },
  });
  assert.equal(s.status().connected, false);
  await s.connectCli();
  const st = s.status();
  assert.equal(st.connected, true);
  assert.equal(st.user.login, "elcann7");
  assert.equal(st.canReadPrivate, true);
  assert.ok(!JSON.stringify(st).includes(TOKEN), "status must not carry the token");
  assert.equal(s.getToken(), TOKEN);
});

test("AuthError when the CLI is missing or the token is invalid; no connection is made", async () => {
  const a = createGithubSession({ execGhToken: async () => { throw new AuthError("gh not logged in"); }, fetchImpl: async () => resp(200, {}) });
  await assert.rejects(a.connectCli(), /gh not logged in/);
  assert.equal(a.status().connected, false);
  const b = createGithubSession({ execGhToken: async () => TOKEN, fetchImpl: async () => resp(401, {}) });
  await assert.rejects(b.connectCli(), (e) => e instanceof AuthError && e.status === 401);
  assert.equal(b.status().connected, false);
});

test("disconnect tokeni silir", async () => {
  const s = createGithubSession({ execGhToken: async () => TOKEN, fetchImpl: async () => resp(200, { login: "x" }) });
  await s.connectCli();
  s.disconnect();
  assert.equal(s.status().connected, false);
  assert.equal(s.getToken(), undefined);
});

test("an env token (GITHUB_TOKEN) is not a connection, but getToken uses it", () => {
  const s = createGithubSession({ envToken: "env-token" });
  assert.equal(s.status().connected, false);
  assert.equal(s.getToken(), "env-token");
});

test("device flow: rejected without a client id; pending -> ok with one", async () => {
  const no = createGithubSession({ fetchImpl: async () => resp(200, {}) });
  await assert.rejects(no.deviceStart(""), /GITHUB_CLIENT_ID/);
  assert.equal(no.status().deviceFlow, false);

  let polls = 0;
  const s = createGithubSession({
    clientId: "cid",
    fetchImpl: async (url) => {
      if (url.endsWith("/login/device/code")) return resp(200, { device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
      if (url.endsWith("/login/oauth/access_token")) return resp(200, ++polls === 1 ? { error: "authorization_pending" } : { access_token: TOKEN });
      if (url.endsWith("/user")) return resp(200, { login: "someone", name: null }, { "x-oauth-scopes": "" });
      throw new Error("unexpected " + url);
    },
  });
  const start = await s.deviceStart("");
  assert.equal(start.user_code, "ABCD-1234");
  assert.ok(!("device_code" in start), "device_code must not go to the browser");
  assert.deepEqual(await s.devicePoll(), { status: "pending" });
  assert.deepEqual(await s.devicePoll(), { status: "ok" });
  assert.equal(s.status().user.login, "someone");
  assert.equal(s.status().canReadPrivate, false, "a token without scopes cannot read private repos");
});

test("device flow: denied and expired", async () => {
  const mk = (err) => createGithubSession({ clientId: "cid", fetchImpl: async (url) => (url.endsWith("/code") ? resp(200, { device_code: "d", user_code: "U", verification_uri: "v", expires_in: 900, interval: 5 }) : resp(200, { error: err })) });
  const a = mk("access_denied"); await a.deviceStart(""); assert.deepEqual(await a.devicePoll(), { status: "denied" });
  const b = mk("expired_token"); await b.deviceStart(""); assert.deepEqual(await b.devicePoll(), { status: "expired" });
  await assert.rejects(mk("x").devicePoll(), /No sign-in in progress/);
});

test("get: GET only, error codes become AuthError", async () => {
  const calls = [];
  const s = createGithubSession({ execGhToken: async () => TOKEN, fetchImpl: async (url, init) => { calls.push(init.method); return url.endsWith("/user") ? resp(200, { login: "x" }) : resp(404, {}); } });
  await s.connectCli();
  await assert.rejects(s.get("/repos/o/r"), (e) => e instanceof AuthError && e.status === 404);
  assert.ok(calls.every((m) => m === undefined || m === "GET"), "there must be no write method");
});
