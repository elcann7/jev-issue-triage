import { test } from "node:test";
import assert from "node:assert/strict";
import { priorityOf } from "../src/decide.mjs";

test("security is always on top (urgent, rank 0)", () => {
  const p = priorityOf(["security", "bug", "severity: critical"]);
  assert.equal(p.tier, "urgent");
  assert.equal(p.rank, 0);
  assert.ok(p.reasons.includes("Possible security problem"));
});

test("kritik bug urgent (rank 1), ciddi (high) bug urgent (rank 2)", () => {
  assert.deepEqual([priorityOf(["bug", "severity: critical"]).tier, priorityOf(["bug", "severity: critical"]).rank], ["urgent", 1]);
  assert.deepEqual([priorityOf(["bug", "severity: high"]).tier, priorityOf(["bug", "severity: high"]).rank], ["urgent", 2]);
});

test("medium/low bug urgent deyil: planned", () => {
  assert.equal(priorityOf(["bug", "severity: medium"]).tier, "planned");
  assert.equal(priorityOf(["bug", "severity: low"]).tier, "planned");
});

test("needs-repro, needs-triage and question: attention (needs a reply or a look)", () => {
  for (const l of ["needs-repro", "needs-triage", "question"]) {
    const p = priorityOf([l]);
    assert.equal(p.tier, "attention", l);
    assert.equal(p.rank, 3);
  }
});

test("urgent beats attention; attention beats planned", () => {
  assert.equal(priorityOf(["bug", "severity: high", "needs-repro"]).tier, "urgent");
  assert.equal(priorityOf(["bug", "severity: low", "needs-repro"]).tier, "attention");
});

test("enhancement and documentation: planned", () => {
  assert.equal(priorityOf(["enhancement"]).tier, "planned");
  assert.equal(priorityOf(["documentation"]).tier, "planned");
});

test("spam: a hidden tier, nothing else is considered", () => {
  const p = priorityOf(["spam", "bug", "security"]);
  assert.equal(p.tier, "spam");
  assert.deepEqual(p.reasons, ["Looks like spam"]);
});

test("reasons are fixed sentences (never model text) and the bug severity is shown", () => {
  const p = priorityOf(["bug", "severity: medium", "needs-repro"]);
  assert.deepEqual(p.reasons, ["Missing steps to reproduce", "Bug, severity medium"]);
  assert.deepEqual(priorityOf([]).reasons, []);
  assert.equal(priorityOf(undefined).tier, "planned");
});

test("when urgent, the 'Bug, severity ...' repetition is not shown", () => {
  assert.deepEqual(priorityOf(["bug", "severity: critical"]).reasons, ["Critical: project unusable or data at risk"]);
  assert.deepEqual(priorityOf(["bug", "severity: high", "needs-repro"]).reasons, ["Important feature broken, no workaround", "Missing steps to reproduce"]);
});

test("ordering: within urgent, security < critical < high", () => {
  const sec = priorityOf(["security"]);
  const crit = priorityOf(["bug", "severity: critical"]);
  const high = priorityOf(["bug", "severity: high"]);
  assert.ok(sec.rank < crit.rank && crit.rank < high.rank);
});
