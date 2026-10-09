# Contributing

The [README](README.md) explains what near-agencies is and how to run it;
this file is about changing this repository.

## Taking an issue

An issue is taken when it has an assignee. Taking an issue needs no
sign-up: a GitHub account is enough.

To take an unassigned issue labelled `good first issue` or `ready-for-agent`,
comment `/claim` (or assign yourself, if you have access). The coordinator
assigns the first valid claim. Claim before you build.

Issues labelled `external` are for contributors outside MultiAgency;
MultiAgency's agents are assigned the others. Issues labelled `internal-only`
are for MultiAgency's team.

The triage labels say how far an issue is specified, not who may take it:
`ready-for-agent` is fully specified and ready for an unattended (AFK)
agent; `ready-for-human` needs human implementation; `needs-triage` waits
for a maintainer to evaluate it; `needs-info` waits on its reporter.

## Writing an issue

File issues in the NEARBuilders shape, so they can be triaged and taken:

- **What to build** — a sentence or two on the change.
- **Acceptance criteria** — checkboxes the deliverable must tick.
- **Blocked by #n** — what has to land first, when something does.

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
  `/review`. Bring your fork's `staging` up to date first (GitHub's **Sync
  fork** button). Otherwise a push that carries upstream changes to
  `.github/workflows/` is refused unless your token has the workflow
  permission; a synced fork, or a push over SSH, needs no such permission.

## Review and merge

One code owner's approval is needed ([`CODEOWNERS`](.github/CODEOWNERS):
team `internal`, or the owner — the owner alone for the owner-only files
below). Authors can't approve their own pull requests, and a push dismisses
an earlier approval. An internal contributor may merge once there's an
approval, `test` has passed and the AI review is clean; a pull request
authored by an agent waits for the owner, who reviews, approves and merges
it ([AGENTS.md](AGENTS.md)).

## Owner-only files

The owner alone approves changes to these files
([`CODEOWNERS`](.github/CODEOWNERS)): `.github/`, `AGENTS.md`, `CLAUDE.md`,
`REVIEW.md` and `.claude/`. That holds for everyone, whoever you are and
however you work: anyone may change them in a pull request, and the owner
reviews, approves and lands it. Workflow changes especially — a token that
cannot create or change `.github/workflows/` (an agent's cannot,
[AGENTS.md](AGENTS.md), "Known traps") cannot push them. When your setup
cannot push one of these files, put the exact before and after text under a
`## Owner edits` heading in the pull request body, and the owner applies it.

## Becoming an internal contributor

It follows from being visibly useful as a contributor; there is no
application. An owner adds internal contributors to team `internal` after
they have signed the services agreement — ask an owner for a copy; it is
not in this repository. To work jobs on the board instead, see ["Joining the roster"](README.md#joining-the-roster) in the README.

## Words

Text people read says brief, job, task, deliverable, sign-off and round.
Code and data keep `engagement`, `seat` and `terms` ([AGENTS.md](AGENTS.md),
"Words").
