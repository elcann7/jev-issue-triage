// Orchestration: read the event -> ask Jev -> decide in code -> apply. Dependencies are injected (for tests).
import { decide, DEFAULTS, LABELS, priorityOf } from "./decide.mjs";
import { QUESTIONS, buildState } from "./questions.mjs";
import { COMMENTS } from "./templates.mjs";

export function shouldSkip(event) {
  const issue = event?.issue;
  if (!issue) return "event has no issue";
  if (event.action !== "opened") return `action "${event.action}" is not handled (only "opened")`;
  if (issue.pull_request) return "pull request";
  if (issue.user?.type === "Bot") return "issue created by a bot";
  if ((issue.labels || []).some((l) => (l.name ?? l) === LABELS.triaged)) return "already triaged";
  return null;
}

export async function triage({ event, config, askJev, github }) {
  const skip = shouldSkip(event);
  if (skip) return { skipped: skip };

  const issue = event.issue;
  const repo = event.repository || {};
  const state = buildState(
    { title: issue.title, body: issue.body, projectName: repo.name, projectDescription: repo.description },
    config.maxBodyChars,
  );

  const response = await askJev({ state, questions: QUESTIONS, model: config.model });
  const thresholds = { high: config.high ?? DEFAULTS.high, low: config.low ?? DEFAULTS.low };
  const decision = decide(response.answers, thresholds);

  const labels = [...decision.labels, LABELS.triaged];
  const comments = config.comment ? decision.comments : [];

  if (!config.dryRun) {
    await github.addLabels(issue.number, labels);
    for (const key of comments) await github.comment(issue.number, COMMENTS[key]);
  }

  return { skipped: null, labels, comments, priority: priorityOf(decision.labels), table: decision.table, severityAnswer: response.answers.severity, usage: response.usage, dryRun: !!config.dryRun };
}
