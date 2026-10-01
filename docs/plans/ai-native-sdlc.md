# Plan: an AI-native engineering loop for near-agencies

Status: accepted 2026-09-30. Phase 1 is this pull request.

## Goal

By the first mainnet payout, any contributor can change this repository safely: MultiAgency's own agents, people, outside contributors, and other organizations' agents, paid for code tasks. Every change passes CI and an AI review. Agents' changes land on staging freely, and production gets only releases a MultiAgency owner promotes.

Context: near-agencies runs MultiAgency's own operations. The quarter's measure is **paid client jobs**: completed, signed off and paid with no manual rescue. Mainnet arrives this quarter.

## Where we started

- **Strong:** the board's chain of records (brief → job → team draft → `/approve` → tasks → deliverable → pinned handoff → sign-off → DAO payout); CI on every PR; a scheduled maintainer that turns repeated problems into coder cards; Jev in shadow mode before it decides anything.
- **Weak:**
  - The `main` ruleset requires a code-owner approval, yet #46–#53 merged with `--admin` and no review. An owner can't approve their own PR, so the gate never passed.
  - Agent knowledge lived in personal notes and chats.
  - Operations tooling and the Jev experiments were unversioned.
  - Merging to `main` deploys straight to production.

## Decisions

| | Decision |
|---|---|
| D1 | Agent-written code is committed and opened as a PR under the agent's identity (`multi-agency`); an owner reviews and approves. |
| D2 | AI review runs in CI with `claude-code-action`. |
| D3 | Stale IronClaw instructions outside the repo are retired. |
| D4 | Operations tooling (`/board`, claim check) lives in this repo's `.claude/`. |
| D5 | Merge is separate from deploy. Agents' changes land on a `staging` branch and environment (testnet); production deploys `main` (mainnet) from a promotion PR an owner approves. |
| D6 | An owner approves every production promotion. Review capacity: a few PRs a day. |

## Phases

1. **Knowledge (this PR):** `AGENTS.md`, read by Hermes and by Claude through `CLAUDE.md`, and this plan.
2. **Review gate:**
   - `REVIEW.md` with passes for bugs, security (the `CODEOWNERS` paths are high-risk) and compliance with the PR's plan;
   - a PR template with **Plan** and **Verification** sections;
   - the `claude-code-action` review. Fork PRs get no secrets, so an outside contributor's PR is reviewed when an owner triggers it; untrusted code never runs with secrets.
   - a Claude Code hook that blocks `gh pr merge --admin`.
3. **Staging:**
   - a Railway `staging` environment deploying the `staging` branch;
   - its own board repo, testnet treasury and keys, domain, and a coordinator running only there;
   - narrow, low-value secrets;
   - rulesets: `staging` requires CI and the AI review, and MultiAgency's agents merge without approval (outsiders' PRs need an owner's approval); `main` takes promotion PRs only, with an owner's approval;
   - production deploys a promoted release, and the rollback is rehearsed on staging;
   - promote small and often (daily).
4. **Tooling and evals:**
   - move `/board` and the claim check into `.claude/`;
   - `evals/judge/` holds the Jev cases with cached responses, run by CI whenever `lib/judge.mjs` changes, and every shadow-trial disagreement becomes a case;
   - Hermes config: fast-forward the coder's base clone on each maintainer run, and have the maintainer watch this repo's issues and PRs.
5. **Paid outside code:**
   - a `CONTRIBUTING.md` and a code-task section in `skill.md` (claim → fork → PR → review → staging → merged → handoff → payout);
   - tests showing a code task pays only after its PR merges;
   - an owner decides how payment is described to outsiders.
6. **Mainnet readiness:** a security review of the payout paths, the mainnet DAO's roles (remove `VoteRemove` from Requestor, as on testnet), the rollback rehearsed, and a short runbook.

Deliberately not now: managed settings, sandboxing, deterministic control bands, scheduled security scans, and per-change `intent.md` or `spec.md` files (the board's briefs and team drafts already play those roles).

## How we measure it

- Merges with `--admin`: zero, from PR history.
- Time to the first AI review on a PR.
- The share of agent PRs merged on the first pass.
- Corrections to `AGENTS.md` that repeat.
- The judge eval pass rate on each change.
- Jobs paid with no manual rescue.

## Open questions

- Staging's treasury: reuse the current testnet DAO, or create a new one?
- Production's board: keep `kanban-sandbox`, or start a clean board for mainnet?
- Does `claude-code-action` support an owner-triggered review of fork PRs as described? To be checked against its docs in phase 2.
