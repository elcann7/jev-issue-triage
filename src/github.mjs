// Minimal GitHub REST client (dependency-free). The token needs only the `issues: write` permission.
export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

export function githubClient({ token, owner, repo, apiUrl = "https://api.github.com", fetchImpl = globalThis.fetch }) {
  if (!token) throw new GitHubError("Missing GitHub token (github_token input).");
  const call = async (path, payload) => {
    const res = await fetchImpl(`${apiUrl}/repos/${owner}/${repo}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new GitHubError(`GitHub API ${path} returned HTTP ${res.status}`, res.status);
    return res.json();
  };
  return {
    addLabels: (number, labels) => call(`/issues/${number}/labels`, { labels }),
    comment: (number, body) => call(`/issues/${number}/comments`, { body }),
  };
}
