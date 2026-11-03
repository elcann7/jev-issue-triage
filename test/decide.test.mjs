import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, stance, topLevel, LABELS } from "../src/decide.mjs";

// Helper: every noul defaults to 0.05; the chosen ones are overridden.
function answers(over = {}, severityProbs = { 0: 0.1, 1: 0.7, 2: 0.2, 3: 0 }) {
  const base = { is_spam: 0.02, describes_vulnerability: 0.02, leaks_secret: 0.02, is_bug: 0.05, is_feature_request: 0.05, is_question: 0.05, is_docs: 0.05, has_repro: 0.5 };
  const out = {};
  for (const [k, v] of Object.entries({ ...base, ...over })) out[k] = { type: "noul", noul: v };
  out.severity = { type: "score", score: 1, confidence: 0.5, probabilities: severityProbs };
  return out;
}

test("stance: bounds are inclusive (>=0.7 yes, <=0.3 no, in between unsure)", () => {
  assert.equal(stance(0.7), "yes");
  assert.equal(stance(0.3), "no");
  assert.equal(stance(0.5), "unsure");
  assert.equal(stance(NaN), "unsure");
  assert.equal(stance(undefined), "unsure");
});

test("bug with reproduction steps -> bug + severity, no needs-repro", () => {
  const d = decide(answers({ is_bug: 0.95, has_repro: 0.9 }));
  assert.deepEqual(d.labels.sort(), [LABELS.bug, "severity: medium"].sort());
  assert.deepEqual(d.comments, []);
});

test("bug without reproduction steps -> needs-repro label and repro comment", () => {
  const d = decide(answers({ is_bug: 0.9, has_repro: 0.1 }));
  assert.ok(d.labels.includes(LABELS.needsRepro));
  assert.deepEqual(d.comments, ["repro"]);
});

test("bug with unsure reproduction steps -> NO needs-repro (the question is not settled)", () => {
  const d = decide(answers({ is_bug: 0.9, has_repro: 0.5 }));
  assert.ok(!d.labels.includes(LABELS.needsRepro));
  assert.deepEqual(d.comments, []);
});

test("feature request -> enhancement, no severity or repro decision", () => {
  const d = decide(answers({ is_feature_request: 0.92 }));
  assert.deepEqual(d.labels, [LABELS.feature]);
});

test("several kinds can be true at once (bug + docs)", () => {
  const d = decide(answers({ is_bug: 0.8, is_docs: 0.85, has_repro: 0.9 }));
  assert.ok(d.labels.includes(LABELS.bug) && d.labels.includes(LABELS.docs));
});

test("no kind is 'yes' -> needs-triage", () => {
  const d = decide(answers({ is_bug: 0.5, is_question: 0.4 }));
  assert.deepEqual(d.labels, [LABELS.needsTriage]);
});

test("spam -> only spam, other decisions are skipped", () => {
  const d = decide(answers({ is_spam: 0.97, is_bug: 0.99 }));
  assert.deepEqual(d.labels, [LABELS.spam]);
  assert.equal(d.spam, true);
  assert.deepEqual(d.comments, []);
});

test("security -> security label + security comment", () => {
  const d = decide(answers({ describes_vulnerability: 0.9, is_bug: 0.8, has_repro: 0.9 }));
  assert.ok(d.labels.includes(LABELS.security));
  assert.deepEqual(d.comments, ["security"]);
});

test("a leaked secret (leaks_secret) also gives the security label", () => {
  const d = decide(answers({ leaks_secret: 0.95, is_question: 0.9 }));
  assert.ok(d.labels.includes(LABELS.security));
  assert.deepEqual(d.comments, ["security"]);
});

test("severity: the most likely level is chosen, an empty or invalid answer creates no label", () => {
  assert.equal(topLevel({ probabilities: { 0: 0.1, 1: 0.2, 2: 0.6, 3: 0.1 } }), 2);
  assert.equal(topLevel({}), null);
  const a = answers({ is_bug: 0.9, has_repro: 0.9 });
  delete a.severity.probabilities;
  const d = decide(a);
  assert.ok(!d.labels.some((l) => l.startsWith("severity")));
  const crit = decide(answers({ is_bug: 0.9, has_repro: 0.9 }, { 0: 0, 1: 0, 2: 0.1, 3: 0.9 }));
  assert.ok(crit.labels.includes("severity: critical"));
});

test("the table returns a row per question", () => {
  const d = decide(answers());
  assert.equal(d.table.length, 8);
});

test("custom thresholds apply", () => {
  const d = decide(answers({ is_feature_request: 0.6 }), { high: 0.55, low: 0.2 });
  assert.deepEqual(d.labels, [LABELS.feature]);
});
