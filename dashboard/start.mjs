// Local dashboard + automatic watcher.
//   npm run dashboard   -> http://localhost:4173  (needs TYPESAFE_API_KEY in .env)
//   npm run demo        -> same UI with bundled sample data, no API key and no network needed
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { askJev } from "../src/jev.mjs";
import { createServer, fetchRepoIssues } from "./server.mjs";
import { loadDotEnv } from "../src/env.mjs";
import { makeAnalyze } from "../src/analyze.mjs";
import { createStore } from "./store.mjs";
import { createWatcher } from "./watcher.mjs";
import { createGithubSession } from "./githubAuth.mjs";

loadDotEnv();
const demo = process.argv.includes("--demo");
const apiKey = demo ? undefined : process.env.TYPESAFE_API_KEY;
const port = Number(process.env.PORT || 4173);
const model = process.env.JEV_MODEL || "jev-latest";
const here = (rel) => new URL(rel, import.meta.url);
const read = (rel) => readFileSync(here(rel), "utf8");
const jev = (args) => askJev({ apiKey, ...args });

const github = createGithubSession({ clientId: process.env.GITHUB_CLIENT_ID || undefined, envToken: process.env.GITHUB_TOKEN || undefined });

let store;
if (demo) {
  // Work on a temporary copy so the bundled demo file is never modified, and make the sample
  // issues look freshly analyzed ("N min ago") instead of showing the date they were generated.
  const tmp = join(mkdtempSync(join(tmpdir(), "jev-demo-")), "store.json");
  copyFileSync(fileURLToPath(here("../docs/demo-store.json")), tmp);
  store = createStore(tmp);
  for (const it of store.list(1000)) store.put({ ...it, analyzedAt: Date.now() - (it.ageMinutes ?? 5) * 60_000 });
} else {
  store = createStore(fileURLToPath(here("../data/store.json")));
}

let watcher = null;
if (demo) {
  // Read-only watcher: it serves the feed from the demo store but never polls or analyzes.
  watcher = createWatcher({ config: {}, fetchIssues: async () => ({ project: {}, issues: [] }), analyze: async () => { throw new Error("demo mode"); }, store, demo: true });
  watcher.pause();
} else if (process.env.AUTO !== "0" && apiKey) {
  const cfgUrl = here("../watch.json");
  const config = existsSync(cfgUrl) ? JSON.parse(readFileSync(cfgUrl, "utf8")) : {};
  watcher = createWatcher({
    config,
    fetchIssues: fetchRepoIssues,
    analyze: makeAnalyze({ askJev: jev, model }),
    store,
    githubToken: () => github.getToken(),
    log: (m) => console.log("[watcher]", m),
  });
}

const server = createServer({
  askJev: jev,
  indexHtml: read("./ui/index.html"),
  examples: JSON.parse(read("../examples/issues.json")),
  hasKey: Boolean(apiKey),
  model,
  github,
  store,
  watcher,
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Jev Issue Triage: http://localhost:${port}`);
  if (demo) {
    console.log("DEMO MODE: showing bundled sample data. Nothing is checked or analyzed, no API key is used.");
    return;
  }
  console.log(apiKey ? "API key loaded from .env (it is never sent to the browser)." : "WARNING: TYPESAFE_API_KEY is not set. Live analysis is disabled (try: npm run demo).");
  if (watcher) {
    const s = watcher.status();
    console.log(`Automatic watcher ON: ${s.repos.join(", ") || "(no repositories yet, add some in the GitHub tab)"}, every ${s.pollMinutes} min, daily limit ${s.today.limit} requests.`);
    watcher.start();
  } else {
    console.log("Automatic watcher OFF (AUTO=0 or no API key).");
  }
});
