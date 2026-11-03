# Contributing

Thanks for taking an interest. This project is small and aims to stay that way: zero dependencies, readable code, tests for every rule.

## Setup

```bash
git clone https://github.com/elcann7/jev-issue-triage.git
cd jev-issue-triage
npm test
```

Node 20 or newer. There is nothing to install.

## Ground rules

- **No dependencies.** The Action and dashboard use only Node's standard library. A change that adds a dependency needs a very good reason.
- **Jev judges, code decides.** The model answers small typed questions; labels and comments come from code. Do not let model output become
  a label name, a comment, or anything that is executed.
- **One judgment per question.** A question with "or" or "and" in it should be two questions. A test enforces this.
- **Fixed-text comments only.** Comments the Action posts are templates in `src/templates.mjs`.
- **Errors are errors.** A failed API call must fail loudly, never produce a label.

## Changing a question or a rule

1. Edit `src/questions.mjs` (wording) or `src/decide.mjs` (rules).
2. Add or update a test. Rules in `decide.mjs` have a test for each branch and threshold boundary.
3. If the change affects what Jev is asked, run the live evaluation (needs a TypeSafe key, costs about $0.001) and read the individual
   answers, not just the totals:
   ```bash
   cp .env.example .env     # add your key
   npm run eval -- --yes
   ```
4. Be wary of tuning wording to fix one failing case. Prefer better state (what the question sees), a separate question, or code. Check the change on
   cases you did not tune on.

## Pull requests

- Keep them focused. Include what changed and why, and how you tested it.
- `npm test` must pass. CI runs it on Node 20, 22 and 24.
- Update the README or `CHANGELOG.md` when behavior changes.

## Never commit

API keys, tokens, `.env` files, or real issue text from a private repository. The `.gitignore` already excludes `.env`, `data/` and `out/`.
