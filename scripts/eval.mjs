// Live evaluation: sends the synthetic issue set to the real Jev API and compares the result with the expected labels.
// NOTE: this costs money (very little) and uses the network, so the --yes flag is required.
//   node scripts/eval.mjs --yes
// Key: the TYPESAFE_API_KEY environment variable or a .env file. The key is never printed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { askJev } from "../src/jev.mjs";
import { loadDotEnv } from "../src/env.mjs";
import { QUESTIONS, buildState } from "../src/questions.mjs";
import { decide } from "../src/decide.mjs";

loadDotEnv();

const data = JSON.parse(readFileSync(new URL("../examples/issues.json", import.meta.url), "utf8"));
const PRICE_PER_MTOK = 0.042;
const approxTokens = data.issues.reduce((n, i) => n + Math.ceil((i.title.length + i.body.length) / 4) + 900, 0);

console.log(`Dataset: ${data.issues.length} synthetic issues (no personal or private data).`);
console.log(`Estimated input: ~${approxTokens} tokens, about $${((approxTokens * PRICE_PER_MTOK) / 1e6).toFixed(5)} at $${PRICE_PER_MTOK}/MTok.`);
console.log("Will send: issue title/body text and the question wording to https://api.typesafe.ai using TYPESAFE_API_KEY.");

if (!process.argv.includes("--yes")) {
  console.log("\nNothing was sent. Re-run with --yes to confirm.");
  process.exit(0);
}
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error("TYPESAFE_API_KEY is not set (put it in .env). Nothing was sent.");
  process.exit(1);
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const KINDS = new Set(["bug", "enhancement", "question", "documentation"]);
const rows = [];
const log = [];
let usage = { input: 0, output: 0 };

for (const issue of data.issues) {
  const state = buildState({ title: issue.title, body: issue.body, projectName: data.project.name, projectDescription: data.project.description });
  let res;
  try {
    res = await askJev({ apiKey, state, questions: QUESTIONS });
  } catch (e) {
    console.error(`ERROR on ${issue.id}: ${e.message}`);
    process.exit(1);
  }
  usage.input += res.usage?.input_tokens ?? 0;
  usage.output += res.usage?.output_tokens ?? 0;
  const d = decide(res.answers);
  const got = {
    kinds: d.labels.filter((l) => KINDS.has(l)),
    needs_repro: d.labels.includes("needs-repro"),
    spam: d.spam,
    security: d.labels.includes("security"),
    severity: (() => { const l = d.labels.find((x) => x.startsWith("severity: ")); return l ? ["low", "medium", "high", "critical"].indexOf(l.slice(10)) : null; })(),
  };
  const e = issue.expected;
  const checks = {
    kinds: e.kinds === null ? "skip" : sameSet(got.kinds, e.kinds),
    needs_repro: got.needs_repro === e.needs_repro,
    spam: got.spam === e.spam,
    security: got.security === e.security,
    severity: e.severity === null || got.severity === null ? "skip" : Math.abs(got.severity - e.severity) <= 1,
  };
  rows.push({ id: issue.id, tags: issue.tags || [], got, checks });
  log.push({ id: issue.id, request: { state }, response: res, decision: d });
}

let ok = 0, total = 0;
for (const r of rows) {
  const bad = Object.entries(r.checks).filter(([, v]) => v === false).map(([k]) => k);
  for (const v of Object.values(r.checks)) if (v !== "skip") { total++; if (v === true) ok++; }
  console.log(`${bad.length ? "MISS" : " ok "} ${r.id.padEnd(24)} kinds=[${r.got.kinds}] repro=${r.got.needs_repro} spam=${r.got.spam} sec=${r.got.security} sev=${r.got.severity}${bad.length ? `  <- wrong: ${bad.join(", ")}` : ""}`);
}
console.log(`\nChecks passed: ${ok}/${total}. Tokens used: ${usage.input} in, ${usage.output} out (~$${((usage.input * PRICE_PER_MTOK) / 1e6).toFixed(5)}).`);

mkdirSync("out", { recursive: true });
const file = `out/eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ usage, rows, log }, null, 2));
console.log(`Full requests and responses saved to ${file} (gitignored). Read individual answers before changing any wording.`);
