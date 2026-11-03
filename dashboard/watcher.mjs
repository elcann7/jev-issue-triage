// Automatic watcher: periodically checks the watched repositories, analyzes NEW issues with Jev and stores the results.
// Spend guards: a daily request limit, a cap on new issues per check, and pause. The numbers can be changed in the UI (kept in the store).
const PRICE_PER_MTOK = 0.042;

export const WATCH_DEFAULTS = { repos: [], pollMinutes: 5, maxNewPerPoll: 10, dailyMaxRequests: 300, feedLimit: 100 };

export const SETTING_LIMITS = {
  dailyMaxRequests: { min: 1, max: 2000 },
  maxNewPerPoll: { min: 1, max: 100 },
  pollMinutes: { min: 1, max: 60 },
};
export const FEED_LIMITS = [25, 50, 100, 200, 500];

/** Validates and cleans settings coming from the UI; throws an error with status 400 on invalid values. */
export function parseSettings(input = {}) {
  const out = {};
  for (const [key, { min, max }] of Object.entries(SETTING_LIMITS)) {
    if (input[key] === undefined) continue;
    const v = Number(input[key]);
    if (!Number.isInteger(v) || v < min || v > max) {
      throw Object.assign(new Error(`${key} must be a whole number between ${min} and ${max}`), { status: 400 });
    }
    out[key] = v;
  }
  if (input.feedLimit !== undefined) {
    const v = Number(input.feedLimit);
    if (!FEED_LIMITS.includes(v)) throw Object.assign(new Error(`feedLimit must be one of ${FEED_LIMITS.join(", ")}`), { status: 400 });
    out.feedLimit = v;
  }
  return out;
}

export function createWatcher({ config, fetchIssues, analyze, store, now = Date.now, log = () => {}, githubToken, demo = false, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const seed = { ...WATCH_DEFAULTS, ...config };
  const settings = () => {
    const { repos: _repos, ...base } = seed;
    return { ...base, ...(store.getSettings?.() || {}) };
  };
  const knownProjects = new Map();
  let paused = false;          // user pause
  let timer = null;
  let started = false;
  let polling = false;
  let lastPollAt = null, nextPollAt = null, lastError = null, lastErrors = {};

  const repos = () => store.getWatch() ?? seed.repos;
  const tokenNow = () => (typeof githubToken === "function" ? githubToken() : githubToken);
  const budgetLeft = () => settings().dailyMaxRequests - store.today().requests;

  async function pollOnce() {
    if (paused || polling) return { skipped: paused ? "paused" : "busy" };
    polling = true;
    lastPollAt = now();
    let analyzed = 0;
    try {
      for (const repo of repos()) {
        if (budgetLeft() <= 0) break;
        delete lastErrors[repo]; // errors for this check are collected again
        try {
          const { project, issues } = await fetchIssues(repo, settings().maxNewPerPoll, { token: tokenNow(), knownProject: knownProjects.get(repo) });
          knownProjects.set(repo, project);
          for (const issue of issues) {
            const key = `${repo}#${issue.number}`;
            if (store.has(key)) continue;
            if (budgetLeft() <= 0) break;
            try {
              const data = await analyze(issue, project);
              const usage = data.response.usage || {};
              store.addUsage({ requests: 1, input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 });
              store.put({
                key, repo, number: issue.number, title: issue.title, url: issue.url, existingLabels: issue.existingLabels,
                analyzedAt: now(), labels: data.decision.labels.filter((l) => l !== "triaged"), data,
              });
              analyzed++;
            } catch (e) {
              lastErrors[repo] = `Analysis failed for ${key}: ${e.message}`;
              log(lastErrors[repo]);
            }
          }
        } catch (e) {
          lastErrors[repo] = `Could not read ${repo}: ${e.message}`;
          log(lastErrors[repo]);
        }
      }
      lastError = Object.values(lastErrors)[0] ?? null;
    } finally {
      polling = false;
    }
    return { analyzed };
  }

  function schedule() {
    if (timer) clearTimer(timer);
    const ms = settings().pollMinutes * 60_000;
    nextPollAt = now() + ms;
    timer = setTimer(async () => { await pollOnce(); schedule(); }, ms);
    timer.unref?.();
  }

  return {
    pollOnce,
    start() { started = true; pollOnce().finally(schedule); },
    stop() { started = false; if (timer) clearTimer(timer); timer = null; },
    list: (limit = settings().feedLimit) => store.list(limit).map(({ data, ...light }) => light),
    get: (key) => store.get(key),
    repos,
    addRepo(repo) { store.setWatch([...repos(), repo]); },
    removeRepo(repo) { store.setWatch(repos().filter((r) => r !== repo)); knownProjects.delete(repo); },
    pause() { paused = true; },
    resume() { paused = false; },
    settings,
    /** Partial update: validated, stored, and if the interval changed the next check is rescheduled. */
    updateSettings(partial) {
      const clean = parseSettings(partial);
      const before = settings().pollMinutes;
      store.setSettings({ ...(store.getSettings?.() || {}), ...clean });
      if (started && settings().pollMinutes !== before) schedule();
      return settings();
    },
    status() {
      const t = store.today();
      const s = settings();
      return {
        repos: repos(), pollMinutes: s.pollMinutes, paused, polling, lastPollAt, nextPollAt, lastError,
        limitReached: budgetLeft() <= 0, settings: s, demo,
        today: { requests: t.requests, limit: s.dailyMaxRequests, input_tokens: t.input_tokens, output_tokens: t.output_tokens, cost_usd: (t.input_tokens * PRICE_PER_MTOK) / 1e6 },
      };
    },
  };
}
