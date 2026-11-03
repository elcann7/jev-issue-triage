# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private vulnerability reporting:
the **Security** tab of this repository, then **Report a vulnerability**. Include what you found, how to reproduce it, and the impact.

You can expect an acknowledgement within a few days. This is a small, volunteer-maintained project, so there is no guaranteed response time.

## What this project handles

| Asset | How it is protected |
|---|---|
| TypeSafe API key | Read from a repository secret (Action) or `.env` (dashboard). Never logged, never written to the job summary, never sent to the browser. Tests assert this. |
| GitHub token (dashboard) | Held in server memory only. Never written to disk or sent to the browser. Only read (GET) requests are made. |
| Issue text | Sent to the TypeSafe API for analysis. It leaves your repository. See the privacy notes in the README. |

## Design choices that matter for security

- The Action requests only the `issues: write` permission.
- Issue text is treated as untrusted. Labels come from a fixed list and comments from fixed templates, so model output cannot inject content.
- The dashboard listens on `127.0.0.1` only, validates the Host and Origin headers on every state-changing request, and enforces request size and rate limits.
- Private repository text is never sent to the API without an explicit confirmation.

## Out of scope

Vulnerabilities in TypeSafe's API itself, in GitHub, or in Node.js. Please report those to the respective vendors.
