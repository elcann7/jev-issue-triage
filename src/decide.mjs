// Decision table: Jev supplies judgments; the decision about labels and comments is made HERE, in code.
// Pure functions: no network access, fully covered by tests.
import { SEVERITY_LEVELS } from "./questions.mjs";

export const DEFAULTS = { high: 0.7, low: 0.3 };

export const LABELS = {
  bug: "bug",
  feature: "enhancement",
  question: "question",
  docs: "documentation",
  spam: "spam",
  security: "security",
  needsRepro: "needs-repro",
  needsTriage: "needs-triage",
  triaged: "triaged",
  severity: (name) => `severity: ${name}`,
};

/** Turns a Noul probability into one of three states: yes / no / unsure. */
export function stance(p, { high, low } = DEFAULTS) {
  if (typeof p !== "number" || Number.isNaN(p)) return "unsure";
  if (p >= high) return "yes";
  if (p <= low) return "no";
  return "unsure";
}

function noul(answers, key) {
  const a = answers[key];
  return a && typeof a.noul === "number" ? a.noul : NaN;
}

/** Returns the most likely level (0..n-1) of a Score answer, or null. */
export function topLevel(answer) {
  const probs = answer && answer.probabilities;
  if (!probs) return null;
  let best = null;
  for (const [level, p] of Object.entries(probs)) {
    if (best === null || p > best.p) best = { level: Number(level), p };
  }
  return best ? best.level : null;
}

/**
 * @returns {{labels:string[], comments:string[], table:object[], spam:boolean}}
 * comments: only fixed template keys ("repro" | "security"), never model text.
 */
export function decide(answers, thresholds = DEFAULTS) {
  const s = (key) => stance(noul(answers, key), thresholds);
  const table = ["is_spam", "describes_vulnerability", "leaks_secret", "is_bug", "is_feature_request", "is_question", "is_docs", "has_repro"].map((k) => ({
    question: k,
    probability: noul(answers, k),
    stance: s(k),
  }));

  // 1) Spam: nothing else is applied.
  if (s("is_spam") === "yes") {
    return { labels: [LABELS.spam], comments: [], table, spam: true };
  }

  const labels = [];
  const comments = [];

  // 2) Security: a label plus a fixed-template comment (pointing to private reporting).
  if (s("describes_vulnerability") === "yes" || s("leaks_secret") === "yes") {
    labels.push(LABELS.security);
    comments.push("security");
  }

  // 3) Kind labels: several can be true at the same time.
  const kinds = [
    ["is_bug", LABELS.bug],
    ["is_feature_request", LABELS.feature],
    ["is_question", LABELS.question],
    ["is_docs", LABELS.docs],
  ];
  let anyKind = false;
  for (const [key, label] of kinds) {
    if (s(key) === "yes") {
      labels.push(label);
      anyKind = true;
    }
  }
  if (!anyKind) labels.push(LABELS.needsTriage);

  // 4) Decisions specific to bugs.
  if (s("is_bug") === "yes") {
    const lvl = topLevel(answers.severity);
    if (lvl !== null && SEVERITY_LEVELS[lvl]) labels.push(LABELS.severity(SEVERITY_LEVELS[lvl]));
    if (s("has_repro") === "no") {
      labels.push(LABELS.needsRepro);
      comments.push("repro");
    }
  }

  return { labels: [...new Set(labels)], comments, table, spam: false };
}

/**
 * Derives a "what should I look at now" priority from the labels. Pure function, uses no model text:
 * reasons are fixed sentences. tier: urgent | attention | planned | spam; a lower rank means more important.
 */
export function priorityOf(labels = []) {
  const has = (l) => labels.includes(l);
  if (has(LABELS.spam)) return { tier: "spam", rank: 9, reasons: ["Looks like spam"] };

  const sev = SEVERITY_LEVELS.find((n) => has(LABELS.severity(n)));
  const urgent = [];
  const attention = [];
  const info = [];
  if (has(LABELS.security)) urgent.push("Possible security problem");
  if (sev === "critical") urgent.push("Critical: project unusable or data at risk");
  if (sev === "high") urgent.push("Important feature broken, no workaround");
  if (has(LABELS.needsRepro)) attention.push("Missing steps to reproduce");
  if (has(LABELS.needsTriage)) attention.push("Jev is unsure, a human should look");
  if (has(LABELS.question)) attention.push("Asks for help");
  if (has(LABELS.bug)) info.push(sev ? `Bug, severity ${sev}` : "Bug");
  if (has(LABELS.feature)) info.push("Feature request");
  if (has(LABELS.docs)) info.push("Documentation problem");

  // Avoid repetition: when urgent, "Bug, severity ..." is redundant, so only the important reasons are shown.
  const reasons = urgent.length ? [...urgent, ...attention] : [...attention, ...info];
  if (urgent.length) return { tier: "urgent", rank: has(LABELS.security) ? 0 : sev === "critical" ? 1 : 2, reasons };
  if (attention.length) return { tier: "attention", rank: 3, reasons };
  return { tier: "planned", rank: 5, reasons };
}
