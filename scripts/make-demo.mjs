// Generates docs/demo-store.json: the 16 synthetic example issues analyzed once with the real Jev API.
// The result ships with the repo so anyone can try the dashboard with `npm run demo`, without an API key.
// Costs a fraction of a cent. Requires TYPESAFE_API_KEY and an explicit --yes.
//   node scripts/make-demo.mjs --yes
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { askJev } from "../src/jev.mjs";
import { makeAnalyze } from "../src/analyze.mjs";
import { loadDotEnv } from "../src/env.mjs";

loadDotEnv();
const examples = JSON.parse(readFileSync(new URL("../examples/issues.json", import.meta.url), "utf8"));
console.log(`Will send ${examples.issues.length} synthetic issues (no personal data) to the Jev API.`);
if (!process.argv.includes("--yes")) { console.log("Nothing was sent. Re-run with --yes to confirm."); process.exit(0); }
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) { console.error("TYPESAFE_API_KEY is not set (put it in .env)."); process.exit(1); }

const analyze = makeAnalyze({ askJev: (args) => askJev({ apiKey, ...args }) });
const repo = "acme/pixelkit";
const items = {};
const ages = [2, 3, 5, 6, 9, 11, 14, 18, 22, 27, 31, 38, 44, 52, 61, 75]; // minutes ago, newest first
let i = 0;
for (const issue of examples.issues) {
  const number = i + 1;
  const data = await analyze({ title: issue.title, body: issue.body }, examples.project);
  const key = `${repo}#${number}`;
  items[key] = {
    key, repo, number, title: issue.title, url: null, existingLabels: [],
    analyzedAt: 0, ageMinutes: ages[i % ages.length],
    labels: data.decision.labels.filter((l) => l !== "triaged"), data,
  };
  i++;
}
mkdirSync(new URL("../docs/", import.meta.url), { recursive: true });
writeFileSync(new URL("../docs/demo-store.json", import.meta.url), JSON.stringify({ items, days: {}, watch: [repo] }));
console.log(`Wrote docs/demo-store.json with ${Object.keys(items).length} analyzed issues.`);
