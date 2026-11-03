// Connecting the user's own GitHub account. The token lives only in memory (never written to disk) and is never sent to the browser.
// Two ways: (1) the GitHub CLI login on this computer, (2) OAuth "device flow" (needs GITHUB_CLIENT_ID).
import { execFile } from "node:child_process";

const API = "https://api.github.com";

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

function defaultExecGhToken() {
  return new Promise((resolve, reject) => {
    execFile("gh", ["auth", "token"], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      const token = String(stdout || "").trim();
      if (err || !token) return reject(new AuthError("GitHub CLI is not installed or not logged in on this computer (run: gh auth login).", 400));
      resolve(token);
    });
  });
}

export function createGithubSession({ fetchImpl = globalThis.fetch, execGhToken = defaultExecGhToken, clientId = undefined, envToken = undefined } = {}) {
  let session = null;        // { token, method, user:{login,name}, scopes:[] }
  let pending = null;        // { device_code, expiresAt, scope }

  const headers = (token) => ({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "jev-issue-triage", ...(token ? { Authorization: `Bearer ${token}` } : {}) });

  async function validate(token, method) {
    const res = await fetchImpl(`${API}/user`, { headers: headers(token), signal: AbortSignal.timeout(15000) });
    if (res.status === 401) throw new AuthError("GitHub rejected this token.", 401);
    if (!res.ok) throw new AuthError(`GitHub returned HTTP ${res.status}.`, 502);
    const u = await res.json();
    const scopes = String(res.headers?.get?.("x-oauth-scopes") || "").split(",").map((x) => x.trim()).filter(Boolean);
    session = { token, method, user: { login: u.login, name: u.name || null }, scopes };
  }

  return {
    /** For server-internal use (watcher and GitHub requests). Never returned to the browser. */
    getToken: () => session?.token ?? envToken ?? undefined,
    status: () => ({
      connected: Boolean(session),
      user: session?.user ?? null,
      method: session?.method ?? null,
      scopes: session?.scopes ?? [],
      canReadPrivate: Boolean(session && (session.scopes.includes("repo") || session.method === "cli")),
      deviceFlow: Boolean(clientId),
    }),
    async connectCli() {
      await validate(await execGhToken(), "cli");
    },
    async deviceStart(scope = "") {
      if (!clientId) throw new AuthError("Sign-in with GitHub is not configured (set GITHUB_CLIENT_ID in .env).", 400);
      const res = await fetchImpl("https://github.com/login/device/code", {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "jev-issue-triage" },
        body: JSON.stringify({ client_id: clientId, scope }),
      });
      if (!res.ok) throw new AuthError(`GitHub returned HTTP ${res.status}.`, 502);
      const d = await res.json();
      if (!d.device_code) throw new AuthError(d.error_description || "GitHub did not return a device code.", 502);
      pending = { device_code: d.device_code, expiresAt: Date.now() + d.expires_in * 1000 };
      return { user_code: d.user_code, verification_uri: d.verification_uri, expires_in: d.expires_in, interval: d.interval };
    },
    async devicePoll() {
      if (!pending) throw new AuthError("No sign-in in progress.", 400);
      if (Date.now() > pending.expiresAt) { pending = null; return { status: "expired" }; }
      const res = await fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "jev-issue-triage" },
        body: JSON.stringify({ client_id: clientId, device_code: pending.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      });
      const d = await res.json();
      if (d.access_token) { pending = null; await validate(d.access_token, "device"); return { status: "ok" }; }
      if (d.error === "authorization_pending" || d.error === "slow_down") return { status: "pending" };
      pending = null;
      if (d.error === "expired_token") return { status: "expired" };
      if (d.error === "access_denied") return { status: "denied" };
      throw new AuthError(d.error_description || "Sign-in failed.", 400);
    },
    disconnect() { session = null; pending = null; },
    /** GET requests only (read access). Write operations are not possible through this module. */
    async get(path) {
      const token = session?.token ?? envToken;
      const res = await fetchImpl(`${API}${path}`, { headers: headers(token), signal: AbortSignal.timeout(15000) });
      if (res.status === 401) throw new AuthError("GitHub rejected the token. Reconnect GitHub.", 401);
      if (res.status === 404) throw new AuthError("Not found, or you have no access to it.", 404);
      if (res.status === 403 || res.status === 429) throw new AuthError("GitHub rate limit reached. Try again later.", 429);
      if (!res.ok) throw new AuthError(`GitHub returned HTTP ${res.status}.`, 502);
      return res.json();
    },
  };
}
