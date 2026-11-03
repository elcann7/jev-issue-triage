import { test } from "node:test";
import assert from "node:assert/strict";
import { triage, shouldSkip } from "../src/triage.mjs";
import { QUESTIONS, buildState } from "../src/questions.mjs";
import { COMMENTS } from "../src/templates.mjs";

const event = (over = {}) => ({
  action: "opened",
  repository: { name: "demo", description: "A demo project" },
  issue: { number: 7, title: "Crash on start", body: "It crashes.", user: { type: "User" }, labels: [] },
  ...over,
});

function fakeJev(noulOver = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    const answers = {};
    for (const k of Object.keys(QUESTIONS)) answers[k] = { type: QUESTIONS[k].type, noul: 0.05 };
    Object.assign(answers, Object.fromEntries(Object.entries(noulOver).map(([k, v]) => [k, { type: "noul", noul: v }])));
    answers.severity = { type: "score", probabilities: { 0: 0, 1: 0, 2: 1, 3: 0 } };
    return { answers, usage: { input_tokens: 50, output_tokens: 5 } };
  };
  fn.calls = calls;
  return fn;
}
function fakeGithub() {
  const log = [];
  return { log, addLabels: async (n, l) => log.push(["labels", n, l]), comment: async (n, b) => log.push(["comment", n, b]) };
}

test("edge cases are skipped: PR, bot, already triaged, wrong action", () => {
  assert.match(shouldSkip(event({ issue: { ...event().issue, pull_request: {} } })), /pull request/);
  assert.match(shouldSkip(event({ issue: { ...event().issue, user: { type: "Bot" } } })), /bot/);
  assert.match(shouldSkip(event({ issue: { ...event().issue, labels: [{ name: "triaged" }] } })), /already/);
  assert.match(shouldSkip(event({ action: "edited" })), /not handled/);
  assert.equal(shouldSkip(event()), null);
});

test("bug without reproduction: labels are applied, no comment when comment=false", async () => {
  const gh = fakeGithub();
  const r = await triage({ event: event(), config: { maxBodyChars: 6000, model: "jev-latest" }, askJev: fakeJev({ is_bug: 0.95, has_repro: 0.05 }), github: gh });
  assert.deepEqual(gh.log.filter((x) => x[0] === "comment"), []);
  const labels = gh.log.find((x) => x[0] === "labels")[2];
  assert.ok(labels.includes("bug") && labels.includes("needs-repro") && labels.includes("triaged") && labels.includes("severity: high"));
  assert.equal(r.dryRun, false);
});

test("comment=true: only the fixed template is posted", async () => {
  const gh = fakeGithub();
  await triage({ event: event(), config: { comment: true, maxBodyChars: 6000 }, askJev: fakeJev({ is_bug: 0.95, has_repro: 0.05 }), github: gh });
  const c = gh.log.filter((x) => x[0] === "comment");
  assert.equal(c.length, 1);
  assert.equal(c[0][2], COMMENTS.repro);
});

test("dry run: nothing is applied, but the decision is returned", async () => {
  const gh = fakeGithub();
  const r = await triage({ event: event(), config: { dryRun: true, maxBodyChars: 6000 }, askJev: fakeJev({ is_feature_request: 0.9 }), github: gh });
  assert.deepEqual(gh.log, []);
  assert.ok(r.labels.includes("enhancement"));
  assert.equal(r.dryRun, true);
});

test("a Jev error propagates: no label is applied", async () => {
  const gh = fakeGithub();
  await assert.rejects(triage({ event: event(), config: { maxBodyChars: 6000 }, askJev: async () => { throw new Error("API down"); }, github: gh }), /API down/);
  assert.deepEqual(gh.log, []);
});

test("state: named fields, a long body is truncated, only the needed data", () => {
  const s = buildState({ title: "T", body: "x".repeat(50), projectName: "p", projectDescription: "" }, 10);
  assert.equal(s.issue.body.startsWith("xxxxxxxxxx"), true);
  assert.match(s.issue.body, /truncated/);
  assert.equal(s.project.description, "(no description)");
  assert.deepEqual(Object.keys(s), ["project", "issue"]);
});

test("result includes the priority tier and fixed-sentence reasons", async () => {
  const r = await triage({ event: event(), config: { dryRun: true, maxBodyChars: 6000 }, askJev: fakeJev({ is_bug: 0.95, has_repro: 0.9 }), github: null });
  assert.equal(r.priority.tier, "urgent"); // fakeJev reports severity level 2 (high)
  assert.ok(r.priority.reasons.every((x) => typeof x === "string"));
  const feature = await triage({ event: event(), config: { dryRun: true, maxBodyChars: 6000 }, askJev: fakeJev({ is_feature_request: 0.9 }), github: null });
  assert.equal(feature.priority.tier, "planned");
});
