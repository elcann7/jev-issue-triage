import { test } from "node:test";
import assert from "node:assert/strict";
import { askJev, JevError } from "../src/jev.mjs";
import { QUESTIONS } from "../src/questions.mjs";

const okAnswers = () => {
  const answers = {};
  for (const k of Object.keys(QUESTIONS)) answers[k] = { type: QUESTIONS[k].type, noul: 0.5, probabilities: { 0: 1 } };
  return { model: "jev-1.14.0", answers, usage: { input_tokens: 100, output_tokens: 10 } };
};
const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] }, json: async () => body });
const args = (fetchImpl) => ({ apiKey: "k", state: { a: 1 }, questions: QUESTIONS, fetchImpl, sleepImpl: async () => {} });

test("successful request: correct URL, headers and body", async () => {
  let seen;
  const out = await askJev(args(async (url, init) => { seen = { url, init }; return res(200, okAnswers()); }));
  assert.equal(seen.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seen.init.headers.Authorization, "Bearer k");
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.model, "jev-latest");
  assert.deepEqual(Object.keys(sent.questions), Object.keys(QUESTIONS));
  assert.equal(out.usage.input_tokens, 100);
});

test("429 then 200: retries", async () => {
  let n = 0;
  const out = await askJev(args(async () => (++n === 1 ? res(429, {}, { "retry-after": "1" }) : res(200, okAnswers()))));
  assert.equal(n, 2);
  assert.ok(out.answers);
});

test("400 is not retried and throws JevError (never disguised as an answer)", async () => {
  let n = 0;
  await assert.rejects(askJev(args(async () => { n++; return res(400, { detail: "bad" }); })), (e) => e instanceof JevError && e.status === 400);
  assert.equal(n, 1);
});

test("JevError if every attempt fails", async () => {
  await assert.rejects(askJev(args(async () => res(503, {}))), (e) => e instanceof JevError && e.status === 503);
});

test("a network error is a JevError", async () => {
  await assert.rejects(askJev(args(async () => { throw new Error("boom"); })), /Network error/);
});

test("JevError if an answer is missing from the response", async () => {
  const bad = okAnswers();
  delete bad.answers.is_bug;
  await assert.rejects(askJev(args(async () => res(200, bad))), /missing answers for: is_bug/);
});

test("no request is sent without a key", async () => {
  await assert.rejects(askJev({ ...args(async () => { throw new Error("should not call"); }), apiKey: "" }), /Missing TypeSafe API key/);
});
