// GitHub Action entry point. Inputs are read from INPUT_* environment variables.
import { appendFileSync, readFileSync } from "node:fs";
import { askJev } from "./jev.mjs";
import { githubClient } from "./github.mjs";
import { triage } from "./triage.mjs";

const input = (name, fallback = "") => (process.env[`INPUT_${name.toUpperCase()}`] ?? fallback).trim();
const bool = (v) => ["true", "1", "yes"].includes(String(v).toLowerCase());
const num = (v, d) => (v === "" || Number.isNaN(Number(v)) ? d : Number(v));

function summaryMarkdown(r) {
  if (r.skipped) return `### Jev triage\nSkipped: ${r.skipped}\n`;
  const rows = r.table
    .map((t) => `| \`${t.question}\` | ${Number.isNaN(t.probability) ? "n/a" : t.probability.toFixed(2)} | ${t.stance} |`)
    .join("\n");
  return [
    `### Jev triage${r.dryRun ? " (dry run, nothing applied)" : ""}`,
    "",
    "| Question | Probability | Stance |",
    "|---|---|---|",
    rows,
    "",
    `**Labels:** ${r.labels.map((l) => `\`${l}\``).join(", ")}`,
    `**Priority:** ${r.priority.tier}${r.priority.reasons.length ? ` (${r.priority.reasons.join("; ")})` : ""}`,
    r.comments.length ? `**Comments:** ${r.comments.join(", ")}` : "",
    r.usage ? `**Tokens:** ${r.usage.input_tokens} in / ${r.usage.output_tokens} out` : "",
  ].join("\n");
}

/** Expose results to later workflow steps (steps.<id>.outputs.labels / tier / skipped). */
function writeOutputs(r) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = r.skipped
    ? ["skipped=true", "labels=", "tier="]
    : ["skipped=false", `labels=${r.labels.join(",")}`, `tier=${r.priority.tier}`];
  appendFileSync(file, lines.join("\n") + "\n");
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || "").split("/");
  const apiKey = input("api_key");
  const config = {
    model: input("model", "jev-latest"),
    dryRun: bool(input("dry_run", "false")),
    comment: bool(input("comment", "false")),
    high: num(input("threshold_high"), 0.7),
    low: num(input("threshold_low"), 0.3),
    maxBodyChars: num(input("max_body_chars"), 6000),
  };
  const github = config.dryRun ? null : githubClient({ token: input("github_token", process.env.GITHUB_TOKEN || ""), owner, repo });

  const result = await triage({
    event,
    config,
    github,
    askJev: (args) => askJev({ apiKey, baseUrl: input("base_url", "https://api.typesafe.ai"), ...args }),
  });

  console.log(result.skipped ? `Skipped: ${result.skipped}` : `Labels: ${result.labels.join(", ")}${result.dryRun ? " (dry run)" : ""}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result) + "\n");
  writeOutputs(result);
}

main().catch((err) => {
  // An error is never disguised as an answer: the job fails and no label is applied.
  console.error(`::error::${err.name}: ${err.message}`);
  process.exit(1);
});
