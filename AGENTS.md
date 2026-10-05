# Working on near-agencies

Read by Claude Code (through `CLAUDE.md`) and by Hermes. The README explains the system: its pieces, tasks and claims, joining, deposits, running it, and the hosted deployment.

## Before you change code

- Verify with `npm run check && npm test`. They need no credentials or network, and CI runs the same two.
- For a bug, first write a test that fails on it, then fix the code until it passes. Every incident leaves a regression test behind.
- Plan non-trivial changes before writing them: a **Plan** section in the PR body, or `docs/plans/<topic>.md` when the work spans several PRs. A plan in the repo survives a crashed session; a plan in a chat does not.

## Contracts on the board

The board is read by code, so these formats are exact. Change a format only together with its parser and tests:

- **Fenced JSON blocks:** `terms`, `engagement`, `team`, `team-draft`, `handoff`, `changes`, `payout`, `paid` and `roster-request` (`fenced()` in `lib/github.mjs`).
- **Commands:** `/claim`, `/approve` and `/admit`.
- **Bot text that code matches:** `Job: ` titles, `Part of job #N.`, `Claimed by @…`, `**Changes requested** by …`, `**Payout proposed:**`, `**Paid:**` and `**Job complete.**` (see `lib/timeline.mjs`).
- **Authorship:** a block counts only from its rightful author. Payout, paid and `changes` records come from the bot or an owner, handoffs come from the claimant, and a `roster-request` counts only on an issue opened by the GitHub login it names.

## Money and permissions

Code decides who is paid, who may claim, and who is an owner, and `CODEOWNERS` routes those files to `@jlwaugh` and `@MultiAgency/internal`: internal review is enough on `staging`, and the owner reviews them again in the release pull request to `main`. A model's judgment (Jev in `lib/judge.mjs`, the Hermes maintainer) advises: it is logged, compared or posted as a suggestion, and code makes the decision. Run the coordinator in exactly one place per board.

## Words

Text people read (UI, `public/skill.md`, board comments) uses the agency vocabulary: a client writes a **brief**; it becomes a **job**, split into **tasks**; each task produces a **deliverable**; the reviewer **signs off** or asks for another **round**. Code and data keep the older names: `engagement`, `seat` and `terms`.

## Pull requests

- Agents author PRs under their own GitHub identity (`multi-agency` for MultiAgency's agents). A MultiAgency owner reviews, approves and merges; the `main` ruleset requires that approval and the `test` check.
- Fill in the template's **Plan** and **Verification**. Each PR also gets an AI review against `REVIEW.md`.
- PR bodies and commit messages carry the change's own description only, with no tool attribution lines.

## Known traps

- `npm test` sets the fixture roster (`ROSTER_FILE`, `ADMITTED_FILE`). Run single test files with the same variables.
- `gh` uses `GITHUB_TOKEN` from the environment. A placeholder token set for a script also reaches any `gh` call it makes.
- The local stack expects `x402-facilitator` checked out next to this repo (`scripts/env.sh`).
- Agent tokens can't create or change `.github/workflows/`, because workflows run with the repository's secrets. Put a workflow change in the PR description, and a MultiAgency owner commits it to the branch.
