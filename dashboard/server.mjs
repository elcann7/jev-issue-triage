// Local dashboard server. Listens on 127.0.0.1 only; the Jev key and GitHub token stay on the server and never reach the browser.
// Because it spends money: Host/Origin checks (against DNS rebinding and CSRF), an hourly limit, and explicit confirmation for private repositories.
import http from "node:http";
import { QUESTIONS } from "../src/questions.mjs";
import { decide, DEFAULTS, priorityOf } from "../src/decide.mjs";
import { JevError } from "../src/jev.mjs";
import { makeAnalyze } from "../src/analyze.mjs";
import { parseRepo } from "./repo.mjs";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_BODY = 100 * 1024;
const MAX_SCAN = 30;
const PRIVATE_MSG =
  "This is a private repository. Its issue text would be sent to the Jev API (TypeSafe), and their data retention policy is not stated. Continue?";
const GH_POSTS = new Set([
  "/api/triage", "/api/decide", "/api/scan", "/api/watch", "/api/watch/repo", "/api/analyze-issue", "/api/settings",
  "/api/github/connect-cli", "/api/github/device/start", "/api/github/device/poll", "/api/github/disconnect",
]);

const json = (res, status, obj) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
};
const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(httpError(413, "Request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseThresholds(t) {
  const high = Number(t?.high ?? DEFAULTS.high);
  const low = Number(t?.low ?? DEFAULTS.low);
  if (!(low > 0 && high < 1 && low < high)) throw httpError(400, "Thresholds must satisfy 0 < low < high < 1");
  return { high, low };
}

function guardPost(req) {
  const origin = req.headers.origin;
  if (origin) {
    let oh;
    try { oh = new URL(origin).hostname; } catch { oh = ""; }
    if (!LOCAL_HOSTS.has(oh)) throw httpError(403, "Forbidden origin");
  }
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) throw httpError(415, "Content-Type must be application/json");
}

// ---------------------------------------------------------------- reading GitHub (GET only)
const ghHeaders = (token) => ({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "jev-issue-triage", ...(token ? { Authorization: `Bearer ${token}` } : {}) });

async function ghJson(url, { token, fetchImpl = globalThis.fetch, what }) {
  const res = await fetchImpl(url, { headers: ghHeaders(token), signal: AbortSignal.timeout(15000) });
  if (res.status === 404) throw httpError(404, `${what} was not found, or you have no access to it.`);
  if (res.status === 401) throw httpError(401, "GitHub rejected the token. Reconnect GitHub.");
  if (res.status === 403 || res.status === 429) throw httpError(429, "GitHub rate limit reached. Connect GitHub or try again later.");
  if (!res.ok) throw httpError(502, `GitHub returned HTTP ${res.status}`);
  return res.json();
}

const toIssue = (i) => ({
  number: i.number, title: i.title || "", body: i.body || "",
  url: typeof i.html_url === "string" && i.html_url.startsWith("https://github.com/") ? i.html_url : null,
  existingLabels: (i.labels || []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
});

/** A repository's latest open issues (no pull requests). Without a token only public repositories work. */
export async function fetchRepoIssues(repo, limit, { token, fetchImpl, knownProject } = {}) {
  const [info, items] = await Promise.all([
    knownProject ? Promise.resolve(null) : ghJson(`https://api.github.com/repos/${repo}`, { token, fetchImpl, what: `Repository "${repo}"` }).catch((e) => { if (e.status === 404) throw e; return {}; }),
    ghJson(`https://api.github.com/repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=${Math.min(100, limit * 2)}`, { token, fetchImpl, what: `Repository "${repo}"` }),
  ]);
  const issues = items.filter((i) => !i.pull_request).slice(0, limit).map(toIssue);
  return {
    project: knownProject || { name: info?.name || repo.split("/")[1], description: info?.description || "" },
    issues, isPrivate: Boolean(info?.private),
  };
}

/** A single issue plus repository info. */
export async function fetchIssue(repo, number, { token, fetchImpl } = {}) {
  const [info, issue] = await Promise.all([
    ghJson(`https://api.github.com/repos/${repo}`, { token, fetchImpl, what: `Repository "${repo}"` }),
    ghJson(`https://api.github.com/repos/${repo}/issues/${number}`, { token, fetchImpl, what: `Issue #${number}` }),
  ]);
  if (issue.pull_request) throw httpError(400, "That is a pull request, not an issue.");
  return { project: { name: info.name || repo.split("/")[1], description: info.description || "" }, issue: toIssue(issue), isPrivate: Boolean(info.private) };
}

async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const lightItem = (it) => { const { data, ...light } = it; return light; };

export function createServer({
  askJev, indexHtml, examples, model = "jev-latest", hasKey = true, maxRequestsPerHour = 200, now = Date.now,
  fetchIssues = fetchRepoIssues, fetchOne = fetchIssue, github = null, store = null, watcher = null,
}) {
  let windowStart = now();
  let count = 0;
  const spend = (n) => {
    if (now() - windowStart > 3600_000) { windowStart = now(); count = 0; }
    if (count + n > maxRequestsPerHour) throw httpError(429, `Local limit of ${maxRequestsPerHour} Jev requests per hour reached (${count} used)`);
    count += n;
  };
  const analyze = makeAnalyze({ askJev, model });
  const token = () => github?.getToken();
  const needGithub = () => { if (!github) throw httpError(404, "GitHub connection is not enabled"); return github; };
  const watchedRepos = () => (watcher ? watcher.repos() : store?.getWatch() ?? []);

  const remember = (repo, issue, data) => {
    if (!store) return null;
    const item = {
      key: `${repo}#${issue.number}`, repo, number: issue.number, title: issue.title, url: issue.url, existingLabels: issue.existingLabels,
      analyzedAt: now(), labels: data.decision.labels.filter((l) => l !== "triaged"), data,
    };
    store.addUsage({ requests: 1, input_tokens: data.response.usage?.input_tokens ?? 0, output_tokens: data.response.usage?.output_tokens ?? 0 });
    store.put(item);
    return item;
  };

  return http.createServer(async (req, res) => {
    try {
      const host = (req.headers.host || "").replace(/:\d+$/, "");
      if (!LOCAL_HOSTS.has(host)) return json(res, 403, { error: "Forbidden host" });
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;

      // ------------------------------------------------------------------ GET
      if (req.method === "GET") {
        if (path === "/" || path === "/index.html") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          return res.end(indexHtml);
        }
        if (path === "/api/examples") return json(res, 200, examples);
        if (path === "/api/config") return json(res, 200, { hasKey, model, defaults: DEFAULTS, questions: QUESTIONS, maxScan: MAX_SCAN });
        if (path === "/api/feed") {
          if (!watcher) return json(res, 200, { status: null, items: [] });
          const items = watcher.list(watcher.settings().feedLimit).map((i) => ({ ...i, ...priorityOf(i.labels) }));
          const summary = { urgent: 0, attention: 0, planned: 0, spam: 0 };
          for (const i of items) summary[i.tier]++;
          return json(res, 200, { status: watcher.status(), items, summary });
        }
        if (path === "/api/item") {
          const key = url.searchParams.get("key") || "";
          const item = store ? store.get(key) : watcher?.get(key);
          return item ? json(res, 200, item) : json(res, 404, { error: "Not found" });
        }
        if (path === "/api/github/status") return json(res, 200, github ? github.status() : { connected: false, user: null, deviceFlow: false, enabled: false });
        if (path === "/api/github/repos") {
          needGithub();
          if (!github.status().connected) throw httpError(401, "Connect GitHub first.");
          const list = await github.get("/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member");
          const watched = new Set(watchedRepos());
          return json(res, 200, {
            repos: list.map((r) => ({
              full_name: r.full_name, private: Boolean(r.private), fork: Boolean(r.fork), archived: Boolean(r.archived),
              open_issues_count: r.open_issues_count ?? 0, description: r.description || "", pushed_at: r.pushed_at, html_url: r.html_url,
              watched: watched.has(r.full_name),
            })),
          });
        }
        if (path === "/api/github/issues") {
          const repo = parseRepo(url.searchParams.get("repo"));
          if (!repo) return json(res, 400, { error: 'Repository must look like "owner/name".' });
          const { issues, isPrivate } = await fetchIssues(repo, MAX_SCAN, { token: token() });
          return json(res, 200, {
            repo, isPrivate, watched: watchedRepos().includes(repo),
            issues: issues.map((i) => {
              const it = store?.get(`${repo}#${i.number}`);
              return { number: i.number, title: i.title, url: i.url, existingLabels: i.existingLabels, analyzed: it ? { key: it.key, labels: it.labels } : null };
            }),
          });
        }
        return json(res, 404, { error: "Not found" });
      }

      // ----------------------------------------------------------------- POST
      if (req.method === "POST" && GH_POSTS.has(path)) {
        guardPost(req);
        const data = JSON.parse((await readBody(req)) || "{}");
        const needKey = () => { if (!hasKey) throw httpError(503, "TYPESAFE_API_KEY is not set. Put it in .env and restart."); };

        if (path === "/api/decide") {
          if (!data.answers || typeof data.answers !== "object") throw httpError(400, "answers is required");
          return json(res, 200, { decision: decide(data.answers, parseThresholds(data.thresholds)) });
        }

        if (path === "/api/watch") {
          if (!watcher) throw httpError(404, "Automatic watching is not enabled");
          if (data.action === "pause") watcher.pause();
          else if (data.action === "resume") watcher.resume();
          else throw httpError(400, 'action must be "pause" or "resume"');
          return json(res, 200, { status: watcher.status() });
        }

        if (path === "/api/settings") {
          if (!watcher) throw httpError(404, "Automatic watching is not enabled");
          watcher.updateSettings(data); // throws a 400 on invalid values
          return json(res, 200, { status: watcher.status() });
        }

        if (path === "/api/github/connect-cli") { await needGithub().connectCli(); return json(res, 200, github.status()); }
        if (path === "/api/github/device/start") return json(res, 200, await needGithub().deviceStart(data.scope === "repo" ? "repo" : ""));
        if (path === "/api/github/device/poll") {
          const r = await needGithub().devicePoll();
          return json(res, 200, { ...r, github: github.status() });
        }
        if (path === "/api/github/disconnect") { needGithub().disconnect(); return json(res, 200, github.status()); }

        if (path === "/api/watch/repo") {
          const repo = parseRepo(data.repo);
          if (!repo) throw httpError(400, 'Repository must look like "owner/name".');
          if (data.action === "remove") {
            if (watcher) watcher.removeRepo(repo); else store?.setWatch(watchedRepos().filter((r) => r !== repo));
          } else if (data.action === "add") {
            if (github) {
              const info = await github.get(`/repos/${repo}`);
              if (info.private && !data.confirmPrivate) return json(res, 403, { error: PRIVATE_MSG, needsConfirm: true });
            }
            if (watcher) watcher.addRepo(repo); else store?.setWatch([...watchedRepos(), repo]);
          } else throw httpError(400, 'action must be "add" or "remove"');
          return json(res, 200, { repos: watchedRepos() });
        }

        // Everything below sends requests to Jev (costs money)
        needKey();

        if (path === "/api/triage") {
          if (typeof data.title !== "string" || typeof data.body !== "string") throw httpError(400, "title and body must be strings");
          if (data.title.length > 300 || data.body.length > 20000) throw httpError(413, "Title (300) or body (20000 chars) too long");
          const thresholds = parseThresholds(data.thresholds);
          spend(1);
          const project = { name: String(data.project?.name || "demo-project").slice(0, 80), description: String(data.project?.description || "").slice(0, 300) };
          try { return json(res, 200, await analyze(data, project, thresholds)); }
          catch (e) { if (e instanceof JevError) return json(res, 502, { error: e.message, status: e.status ?? null, detail: e.detail ?? null }); throw e; }
        }

        if (path === "/api/analyze-issue") {
          const repo = parseRepo(data.repo);
          const number = Number(data.number);
          if (!repo || !Number.isInteger(number) || number < 1) throw httpError(400, "repo and a positive issue number are required");
          const { project, issue, isPrivate } = await fetchOne(repo, number, { token: token() });
          if (isPrivate && !data.confirmPrivate) return json(res, 403, { error: PRIVATE_MSG, needsConfirm: true });
          spend(1);
          try {
            const result = await analyze(issue, project, parseThresholds(data.thresholds));
            const item = remember(repo, issue, result);
            return json(res, 200, { item: item ? lightItem(item) : null, data: result });
          } catch (e) { if (e instanceof JevError) return json(res, 502, { error: e.message, status: e.status ?? null, detail: e.detail ?? null }); throw e; }
        }

        if (path === "/api/scan") {
          const repo = parseRepo(data.repo);
          if (!repo) throw httpError(400, 'Repository must look like "owner/name".');
          const thresholds = parseThresholds(data.thresholds);
          const limit = Math.max(1, Math.min(MAX_SCAN, Number(data.limit) || 10));
          const { project, issues, isPrivate } = await fetchIssues(repo, limit, { token: token() });
          if (isPrivate && !data.confirmPrivate) return json(res, 403, { error: PRIVATE_MSG, needsConfirm: true });
          if (!issues.length) return json(res, 200, { repo, project, results: [], totals: { input_tokens: 0, output_tokens: 0 }, note: "No open issues found." });
          spend(issues.length);
          const results = await mapPool(issues, 3, async (issue) => {
            const base = { number: issue.number, title: issue.title, url: issue.url, existingLabels: issue.existingLabels };
            try {
              const data = await analyze(issue, project, thresholds);
              const labels = data.decision.labels.filter((l) => l !== "triaged");
              return { ...base, labels, ...priorityOf(labels), data };
            }
            catch (e) { if (e instanceof JevError) return { ...base, error: e.message }; throw e; }
          });
          const totals = results.reduce((t, r) => ({
            input_tokens: t.input_tokens + (r.data?.response.usage?.input_tokens ?? 0),
            output_tokens: t.output_tokens + (r.data?.response.usage?.output_tokens ?? 0),
          }), { input_tokens: 0, output_tokens: 0 });
          return json(res, 200, { repo, project, results, totals });
        }
      }
      return json(res, 404, { error: "Not found" });
    } catch (e) {
      const status = e.status || (e instanceof SyntaxError ? 400 : 500);
      return json(res, status, { error: status === 500 ? "Internal error" : e.message, ...(e.extra || {}) });
    }
  });
}
