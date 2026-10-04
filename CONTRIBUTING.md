# Contributing

The [README](README.md) explains what near-agencies is and how to run it;
this file is about changing this repository.

## Taking an issue

Open issues labelled `good first issue` or `agent-ready` are up for taking.
Check that no one else has taken the issue — no earlier claim in the
comments and no assignee — then comment on the issue to take it.

## Branches

`staging` is the default branch and every pull request targets it. `main`
takes only release pull requests from `staging`, which the owner merges.

## Building

```sh
npm ci
npm run check && npm test
```

The check and tests need no credentials or network; `npm ci` fetches the
dependencies first ([AGENTS.md](AGENTS.md)). For a bug, write the failing
test first.

## Opening the pull request

Fill in the template's **Plan** and **Verification**.

- **From a branch here** (internal contributors): the AI review against
  [`REVIEW.md`](REVIEW.md) runs automatically when the pull request opens
  and on every push (`.github/workflows/ai-review.yml`).
- **From a fork** (everyone else): an owner approves the first workflow run
  of a first-time contributor, and starts the AI review by commenting
  `/review`.

## Review and merge

One code owner's approval is needed ([`CODEOWNERS`](.github/CODEOWNERS):
team `internal`, or the owner — the owner alone for the owner-only files
below). Authors can't approve their own pull requests, and a push dismisses
an earlier approval. An internal contributor may merge once there's an
approval, `test` has passed and the AI review is clean; a pull request
authored by an agent waits for the owner, who reviews, approves and merges
it ([AGENTS.md](AGENTS.md)).

## Owner-only files

The owner alone reviews these files, and only the owner lands changes in
them ([`CODEOWNERS`](.github/CODEOWNERS)): `.github/`, `AGENTS.md`,
`CLAUDE.md`, `REVIEW.md` and `.claude/`. Workflow changes especially —
agent tokens cannot create or change `.github/workflows/`
([AGENTS.md](AGENTS.md), "Known traps"). When your change needs one of
these files, put the exact before and after text under a `## Owner edits`
heading in the pull request body.

## Becoming an internal contributor

It follows from being visibly useful as a contributor; there is no
application. An owner adds internal contributors to team `internal` after
they have signed the services agreement. To work jobs on the board instead,
see ["Joining the roster"](README.md#joining-the-roster) in the README.

## Words

Text people read says brief, job, task, deliverable, sign-off and round.
Code and data keep `engagement`, `seat` and `terms` ([AGENTS.md](AGENTS.md),
"Words").
