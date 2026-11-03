// End-to-end: runs index.mjs in a separate process against a fake Jev server with dry_run.
// Checks input names (INPUT_*), event parsing and the job summary. Does not touch the real API.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { QUESTIONS } from "../src/questions.mjs";

function startMock(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}
function run(env) {
  return new Promise((resolve) => {
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const p = spawn(process.execPath, ["src/index.mjs"], { env: { ...process.env, ...env }, cwd });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill(); resolve({ code: "timeout", out, err }); }, 15000);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(timer); resolve({ code: "spawn-error", out, err: String(e) }); });
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}
function answersFor(over) {
  const answers = {};
  for (const k of Object.keys(QUESTIONS)) answers[k] = { type: QUESTIONS[k].type, noul: 0.05 };
  Object.assign(answers, over);
  answers.severity = { type: "score", probabilities: { 0: 0, 1: 1, 2: 0, 3: 0 } };
  return { model: "jev-mock", answers, usage: { input_tokens: 123, output_tokens: 4 } };
}
const setup = (issue) => {
  const dir = mkdtempSync(join(tmpdir(), "jev-"));
  const eventPath = join(dir, "event.json");
  const summaryPath = join(dir, "summary.md");
  writeFileSync(eventPath, JSON.stringify({ action: "opened", repository: { name: "demo", description: "d" }, issue }));
  writeFileSync(summaryPath, "");
  return { eventPath, summaryPath };
};

test("entrypoint: dry run + fake server -> labels are written to the summary, the key is sent as a Bearer token", async () => {
  let seenAuth, seenBody;
  const server = await startMock((req, res) => {
    seenAuth = req.headers.authorization;
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      seenBody = JSON.parse(b);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answersFor({ is_bug: { type: "noul", noul: 0.96 }, has_repro: { type: "noul", noul: 0.05 } })));
    });
  });
  const { eventPath, summaryPath } = setup({ number: 3, title: "Crash", body: "It crashes", user: { type: "User" }, labels: [] });
  const r = await run({
    GITHUB_EVENT_PATH: eventPath, GITHUB_STEP_SUMMARY: summaryPath, GITHUB_REPOSITORY: "o/r",
    INPUT_API_KEY: "test-key", INPUT_DRY_RUN: "true", INPUT_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  });
  server.closeAllConnections?.(); server.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(seenAuth, "Bearer test-key");
  assert.deepEqual(Object.keys(seenBody.questions), Object.keys(QUESTIONS));
  assert.equal(seenBody.state.issue.title, "Crash");
  const summary = readFileSync(summaryPath, "utf8");
  assert.match(summary, /dry run/);
  assert.match(summary, /`bug`/);
  assert.match(summary, /`needs-repro`/);
  assert.ok(!summary.includes("test-key"), "the key must not end up in the summary");
  assert.ok(!r.out.includes("test-key") && !r.err.includes("test-key"), "the key must not end up in the logs");
});

test("entrypoint: API error -> the job fails (exit code 1), no label is applied", async () => {
  const server = await startMock((req, res) => { res.statusCode = 400; res.end(JSON.stringify({ detail: "bad" })); });
  const { eventPath, summaryPath } = setup({ number: 4, title: "x", body: "y", user: { type: "User" }, labels: [] });
  const r = await run({
    GITHUB_EVENT_PATH: eventPath, GITHUB_STEP_SUMMARY: summaryPath, GITHUB_REPOSITORY: "o/r",
    INPUT_API_KEY: "k", INPUT_DRY_RUN: "true", INPUT_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  });
  server.closeAllConnections?.(); server.close();
  assert.equal(r.code, 1);
  assert.match(r.err, /::error::JevError/);
});

test("entrypoint: an issue created by a bot is skipped and no API request is made", async () => {
  let hits = 0;
  const server = await startMock((req, res) => { hits++; res.end("{}"); });
  const { eventPath, summaryPath } = setup({ number: 5, title: "x", body: "y", user: { type: "Bot" }, labels: [] });
  const r = await run({
    GITHUB_EVENT_PATH: eventPath, GITHUB_STEP_SUMMARY: summaryPath, GITHUB_REPOSITORY: "o/r",
    INPUT_API_KEY: "k", INPUT_DRY_RUN: "true", INPUT_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  });
  server.closeAllConnections?.(); server.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(hits, 0);
  assert.match(r.out, /Skipped: issue created by a bot/);
});

test("entrypoint: writes labels, tier and skipped to GITHUB_OUTPUT", async () => {
  const server = await startMock((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(answersFor({ is_bug: { type: "noul", noul: 0.96 }, has_repro: { type: "noul", noul: 0.9 } }))); });
  });
  const { eventPath, summaryPath } = setup({ number: 8, title: "Crash", body: "It crashes", user: { type: "User" }, labels: [] });
  const outPath = summaryPath.replace("summary.md", "output.txt");
  writeFileSync(outPath, "");
  const r = await run({
    GITHUB_EVENT_PATH: eventPath, GITHUB_STEP_SUMMARY: summaryPath, GITHUB_OUTPUT: outPath, GITHUB_REPOSITORY: "o/r",
    INPUT_API_KEY: "k", INPUT_DRY_RUN: "true", INPUT_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  });
  server.closeAllConnections?.(); server.close();
  assert.equal(r.code, 0, r.err);
  const out = readFileSync(outPath, "utf8");
  assert.match(out, /^skipped=false$/m);
  assert.match(out, /^labels=.*bug.*$/m);
  assert.match(out, /^tier=(urgent|attention|planned)$/m);
  assert.match(readFileSync(summaryPath, "utf8"), /\*\*Priority:\*\*/);

  // skipped events set skipped=true
  const bot = setup({ number: 9, title: "x", body: "y", user: { type: "Bot" }, labels: [] });
  const botOut = bot.summaryPath.replace("summary.md", "output.txt");
  writeFileSync(botOut, "");
  const r2 = await run({ GITHUB_EVENT_PATH: bot.eventPath, GITHUB_STEP_SUMMARY: bot.summaryPath, GITHUB_OUTPUT: botOut, GITHUB_REPOSITORY: "o/r", INPUT_API_KEY: "k", INPUT_DRY_RUN: "true" });
  assert.equal(r2.code, 0, r2.err);
  assert.match(readFileSync(botOut, "utf8"), /^skipped=true$/m);
});
