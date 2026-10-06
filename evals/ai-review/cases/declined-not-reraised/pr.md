title:	fix: the operator-approval check recognises agents by the roster alone
--
## Plan

Issue #109: #93's operator-approval check reads two org teams — `internal` (people) and `internal-agents`. The second team was never created and will not be (owner decision, 2026-10-05): team `internal` stays people only, agents are in no team. A read of a missing team cannot succeed, so with the check switched on every same-repo PR failed closed. This drops the second team; an author is an agent when the roster records them as one — a record of `kind: "agent"` with an operator — and the roster alone decides.

Files:

- `scripts/operator-approval.mjs` — the second `teamMembers` read removed; the teams it reads now come from lib's `REVIEWED_TEAMS`, so the read list has one home.
- `lib/operator-approval.mjs` — the `internalAgents` verdict parameter and every branch that used it removed (the `teamAgent` override and its two fail-closed reasons); `REVIEWED_TEAMS` exported and pinned by test; docstrings rewritten.
- `test/operator-approval.test.mjs` — the three tests only the second team could exercise removed; a replacement pins the owner decision honestly (see the accepted risk below); `REVIEWED_TEAMS` pinned to exactly `["internal"]`, so a second team cannot creep back into the script's reads unjudged; the unread-team and fork tests carry the one team.
- `docs/plans/internal-agents.md` — the access-tiers table, the CODEOWNERS/ruleset note and plan item 2 now describe agents in no team, with write granted on the account itself; the runbook admits an agent **before** its write grant and names the leftover gap.

**Accepted risk, stated plainly.** Nothing ties an account's write access to the roster any more, and two paths pass on the operator's approval alone:

1. An account recorded as `kind: "human"`. The roster's `kind` is what the applicant declares at join time; `/admit` and `isTrusted` gate who may post a record, not what it says. The owner's decision in #109 makes the roster the one recognition source for agents ("agents are recognised by the roster alone" — a record of `kind: "agent"` with an `operator`), which is what this PR builds: a human-recorded author passes unchecked. That residue is named in the verdict's docstring and the test's name rather than dressed up as a protection.
2. An account with write and no roster record. The runbook now orders `/admit` (step 2) before the write grant (step 4) to close the between-steps window, and states what remains: an account granted write without an admission passes unchecked. Only an owner can grant write, so the provisioning step is the control point.

An owner who wants the stronger rule instead — fail closed on a same-repo author holding write who is in neither team `internal` nor `OWNER` and has no roster record — can build it on this verdict; the check already makes the team read, and the collaborator-permission read is the one addition it needs. That re-decides who may approve, so it is the owner's call, not this PR's.

Approvals are untouched — they still count only from CODEOWNERS' own logins, OWNER and team `internal`, and a declared `kind: "human"` never makes an approval trusted. Every fail-closed case that does not depend on the second team stays: roster unreadable, team internal unreadable, agent with no operator, unvouched approval, a record naming no kind.

## Verification

- `npm ci`, `npm run check`, `npm test`: all pass — 412 tests, 0 failures (54 in `test/operator-approval.test.mjs`).
- Regression pins for the bug itself: the script takes its team reads from lib's `REVIEWED_TEAMS`, and a test asserts it is exactly `["internal"]` — re-adding a read of a team that does not exist has to change both. `judgedTeamMembers` turns the script's slug-keyed reads into the one team the verdict judges, tested for the judged team, the unread team (null, fails closed in the verdict) and drift (any other slug, none, or several throws). `git grep internal-agents` is empty.
- Acceptance criteria from the issue, each with its test: a same-repo PR by a roster agent whose only approval is its operator's still fails ("the operator alone fails", and the second assertion of "a self-declared person passes unchecked"); the owner's approval still counts ("the owner alone on @multi-agency's PR passes"); roster unreadable, team internal unreadable, agent with no operator and unvouched approval all still fail closed.
- `.github/` is owner-committed, so the exact corrected workflow text that #93's Owner edits carries (it names the second team twice) is under **Owner edits** below.

## Owner edits

**`.github/workflows/operator-approval.yml`**, the `ORG_TOKEN` comment — exact before/after:

Before:

```yaml
      # Team reads (internal, internal-agents) need the org's Members: read,
      # which the repository token cannot be granted; without a working
      # ORG_TOKEN every PR to staging fails closed.
```

After:

```yaml
      # The team read (internal) needs the org's Members: read, which the
      # repository token cannot be granted; without a working ORG_TOKEN
      # every PR to staging fails closed.
```

**The `ORG_TOKEN` paragraph below the workflow** — exact before/after:

Before:

```text
`ORG_TOKEN` authenticates the team reads: a fine-grained token with the org's **Members: read**, stored as a repository secret. The workflow's `permissions:` block has no org-level key, so the repository-scoped `GITHUB_TOKEN` cannot be granted it. Two provisioning facts the check depends on, both failing closed when missing: team `internal-agents` does not exist yet (the runbook's owner step provisions it), and a token without **Members: read** cannot read even `internal`.
```

After:

```text
`ORG_TOKEN` authenticates the team read: a fine-grained token with the org's **Members: read**, stored as a repository secret. The workflow's `permissions:` block has no org-level key, so the repository-scoped `GITHUB_TOKEN` cannot be granted it. One provisioning fact the check depends on, failing closed when missing: a token without **Members: read** cannot read team `internal`. Agents are in no team (owner decision, 2026-10-05); the roster says who they are.
```

Closes #109

