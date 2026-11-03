# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] - 2026-11-03

First public version.

### Added
- GitHub Action that labels new issues using Jev: `bug`, `enhancement`, `question`, `documentation`, `needs-repro`, `needs-triage`,
  `security`, `spam`, `severity: low|medium|high|critical` and `triaged`.
- Priority tiers (`urgent`, `attention`, `planned`, `spam`) with fixed-sentence reasons.
- Action inputs `dry_run`, `comment`, `model`, `threshold_high`, `threshold_low`, `max_body_chars`; outputs `labels`, `tier`, `skipped`.
- Fixed-template comments for missing reproduction steps and security reports (never model-written text).
- Optional local dashboard: Live feed grouped by urgency, automatic watcher with spend guards and UI settings, GitHub connection
  (GitHub CLI or OAuth device flow), single-issue inspector, repository scan, and a no-key demo mode (`npm run demo`).
- Explicit confirmation before text from a private repository is sent to the API.
- 16 synthetic issues and a live evaluation script (`npm run eval`).
- Test suite with a fake Jev server and an end-to-end Action run.
