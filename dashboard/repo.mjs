// Extracts "owner/name" from any GitHub link or from "owner/name" itself; rejects unsafe or malformed input.
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const ONLY_DOTS = /^\.+$/;

export function parseRepo(input) {
  let s = String(input ?? "").trim();
  s = s.replace(/^git@github\.com:/i, "").replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "");
  s = s.split(/[?#]/)[0];
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/i, "");
  if (ONLY_DOTS.test(owner) || ONLY_DOTS.test(name)) return null;
  const repo = `${owner}/${name}`;
  return REPO_RE.test(repo) ? repo : null;
}
