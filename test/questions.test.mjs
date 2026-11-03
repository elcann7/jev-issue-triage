import { test } from "node:test";
import assert from "node:assert/strict";
import { QUESTIONS, SEVERITY_LEVELS } from "../src/questions.mjs";

test("each question has a valid type and instructions (matches the API schema)", () => {
  for (const [name, q] of Object.entries(QUESTIONS)) {
    assert.ok(["noul", "score", "choice"].includes(q.type), name);
    assert.ok(typeof q.instructions === "string" && q.instructions.length > 10, name);
    if (q.type === "score") {
      assert.ok(Array.isArray(q.criteria) && q.criteria.length >= 1 && q.criteria.length <= 10, name);
    }
    if (q.type === "noul") {
      assert.ok(q.criteria && typeof q.criteria.true === "string" && typeof q.criteria.false === "string", name);
    }
  }
});

test("the number of severity levels matches the criteria in the questions", () => {
  assert.equal(QUESTIONS.severity.criteria.length, SEVERITY_LEVELS.length);
});

test("Noul questions: no 'or'/'and' in instructions (one judgment per question), no double negatives", () => {
  const compound = /\b(or|and)\b/i;
  const doubleNeg = /\b(not|no)\b.*\b(not|no)\b/i;
  for (const [name, q] of Object.entries(QUESTIONS)) {
    if (q.type === "score") continue;
    assert.ok(!compound.test(q.instructions), `${name}: instructions contain "or"/"and", split into two questions`);
    assert.ok(!doubleNeg.test(q.instructions), `${name}: ikiqat inkar`);
  }
});

test("this test itself works: it catches a compound sentence", () => {
  const compound = /\b(or|and)\b/i;
  assert.ok(compound.test("The text is spam or advertising."));
  assert.ok(!compound.test("`issue` asks for help using `project`."));
});

test("questions refer to the state only through existing paths", () => {
  const allowed = /`(issue|issue\.title|issue\.body|project)`/g;
  for (const [name, q] of Object.entries(QUESTIONS)) {
    const refs = q.instructions.match(/`[^`]+`/g) || [];
    for (const r of refs) assert.ok(r.match(allowed), `${name}: unknown reference ${r}`);
  }
});
