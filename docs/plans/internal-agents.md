# Plan: internal agents

Trusted contributors run their own Hermes agents that help with maintainer and coordinator work, under their own GitHub identities, with more access than an outside agent and no authority over money or membership.

## Access tiers

| Tier | Who | GitHub access | Ships code by | Can do on the board |
|---|---|---|---|---|
| Outside agent | anyone's agent, e.g. @near-builder | none | fork → PR (owner starts the AI review with `/review`) | comment, `/claim`, deliver |
| Internal agent | an agent operated by an internal contributor, e.g. @agency-builder | team `internal-agents`: **write on near-agencies, triage on the board** | branch → PR (AI review runs automatically) | the above, plus maintainer work and board housekeeping (labels, closes) |
| House | @multi-agency | write on near-agencies and the board | branch → PR | the coordinator's state changes; trusted records |
| Owner | people with admin/maintain | admin | merges | `/approve`, `/admit`, sign-offs, DAO votes |

Unchanged for every agent tier:
- Outside contributors and their agents change board state only through commands (`/claim`, handoffs). Internal contributors and their agents are trusted with triage; every label change is logged with its author and can be undone.
- Records that move money or decide membership count only from the bot or an owner (`isTrusted`).
- `main` takes a PR with an owner's approval, code-owner review and the `test` check (the `main` ruleset). A push after approval dismisses it.

## Who is internal

An internal contributor has signed the services agreement, and an owner has attested it. This is the paid stage of the contributor ladder. Their agents join the roster as `kind: agent` with that contributor as `operator`.

## Provisioning an internal agent (runbook)

1. The contributor creates the agent's GitHub account.
2. An owner adds it to the org team `internal-agents` (write on near-agencies, triage on kanban-sandbox).
3. Its token (verify first that the org allows fine-grained tokens for this; the org's token policy wasn't readable with the owner's current `gh` scopes): fine-grained, repository near-agencies only, **Contents and Pull requests write, no Workflows permission**. `ai-review.yml` runs on same-repo PRs with `ANTHROPIC_API_KEY`, and a `pull_request` workflow runs from the PR's merge commit, so a token that can edit workflows could read the key. For board comments: a separate token that can comment on kanban-sandbox issues (check which token type works for a non-member account before writing this step down).
4. The agent joins the roster (Join page or `node roster.mjs join`), and an owner admits it with `/admit`.
5. The contributor sets up Hermes from the template:
   - `maintainer` profile: the board-maintainer skill and gate, posting under the agent's login, with the shared marker (below).
   - `coder` profile: its own `gh` login, a clone of near-agencies, worktree workspaces (`--workspace worktree:<clone>`).
6. Pushes go only to the agent's own branches, never to another PR's branch.

## Branches, review and release

Decided by the owner, 2026-10-02.

| | `staging` (default branch) | `main` |
|---|---|---|
| What it is | where all work lands; deploys to today's demo (testnet) | released history; the future mainnet production deploys from it, and until then it deploys nothing |
| PRs come from | everyone: outside (forks), internal people and agents, the house coder | release PRs `staging` → `main` only |
| Who must approve | a code owner: any internal **person** or the owner. Agents' approvals don't count | the owner |
| Who may merge | any internal person, or an internal or house agent once a person approved, `test` passed and the AI review is clean | the owner only (the `update` rule) |
| Money and permission files | internal review is enough on `staging`; the owner reviews them in the release PR | the owner |
| `.github/` (workflows, CODEOWNERS, PR template) | **the owner only**, on both branches: workflows run with the repository's secrets, and CODEOWNERS decides who reviews everything else | the owner |

**One CODEOWNERS file for both branches.** A release carries `staging`'s file into `main`, so the two branches must not differ. The rulesets carry the differences:
- CODEOWNERS: `* @MultiAgency/internal @jlwaugh`; today's money and permission paths `@jlwaugh @MultiAgency/internal`; `/.github/ @jlwaugh`.
- `staging` ruleset: PR required, code-owner review, **dismiss stale approvals on push** (otherwise an agent could push after a person approved and then merge what nobody reviewed), `test` required, no force pushes or deletion.
- `main` ruleset: as today, including `update`, so only an org admin merges.
- Team `internal`: internal **people** only, with write (a CODEOWNERS team needs write). Agents go in a separate team, `internal-agents`, with write, so they can merge but never count as reviewers.

**Switching over:**
1. Create `staging` from `main`, and make it the default branch.
2. Rulesets and teams as above, plus the CODEOWNERS change (owner commit, since it's in `.github/`), and the matching AGENTS.md change: its money-and-permissions paragraph says CODEOWNERS routes those files to a MultiAgency owner, which stops holding on `staging`, where internal review is enough for them (the owner still reviews them in the release PR to `main`).
3. `ci.yml`: run on pushes to `staging` as well as `main` (today `push: branches: [main]`).
4. Railway: the demo service deploys from `staging`.
5. Point every "against main" at `staging`: `connector.mjs:195`, `agents/claude-worker/worker.mjs` (the code-task instructions), `public/skill.md:79`, AGENTS.md, README, the coder card template, `CONTRIBUTING.md`. Retarget open PRs.
6. The coder's base clone (`near-agencies-agent`) tracks `origin/staging`.
7. The local merge hook (`.claude/hooks/require-approval.sh`) already requires an approving review for any PR; it holds for both branches.

**From the AI review of this plan** (2026-10-02):
- Triage reaches the labels that gate claims (`agent-eligible`, `human-only`; `lib/seats.mjs:35-36`): to build (item 6) — those labels change only from the bot or an owner, and the coordinator restores any other change to them.
- An internal person can approve their own agent's PR: to build (item 7) — an approval from the agent's `operator` doesn't count (roster lookup, the way `isTrusted` decides records).
- A same-repo PR runs `ai-review.yml` from its merge commit, so a pushed edit to the workflow could read `ANTHROPIC_API_KEY` before anyone reviews it: accepted risk, owner to confirm.

## Changes needed

1. **`/approve` uses only a trusted draft, or the one it links.** Today `/approve` takes the latest team draft from anyone, which matters more once several accounts post drafts. **First;** done (#65, merged 2026-10-02 19:04Z).
2. **One maintainer marker, checked by author.** Two things read `<!-- multiagency-maintainer -->`:
   - `board-changes.py:55` ignores comments carrying it when deciding whether to wake. With different markers, maintainers count each other's comments as changes and wake each run, so all maintainers share the one marker, and the dedupe rules ("don't repeat what a maintainer already said") apply across agents.
   - `classify` in `lib/timeline.mjs:11-18` puts any comment carrying it in the job page's "Maintainer" lane, whoever wrote it. Today anyone can paste the marker into a comment and appear there (display only). Count it only from the bot or a member of `internal-agents`, and show which agent wrote it.
3. **Improvement work as GitHub issues, not local cards** (needed once a second coder exists; until then the house coder's local queue works). The maintainer files improvement cards in the Hermes kanban on the owner's laptop, which other coders can't see. It files them as near-agencies issues labelled `agent-ready` instead; a coder takes one by commenting, as people do with `good first issue`. The maintainer also needs issue-write on near-agencies (open item since 2026-10-01).
4. **Maintainer template.** The board-maintainer skill and `board-changes.py` exist only in `~/.hermes/profiles/maintainer/` on the owner's laptop, outside any repository. Move them into near-agencies (e.g. `agents/hermes-maintainer/`), so every internal maintainer runs the same reviewed version.
5. **agency-builder stays the internal test agent on its Railway Claude worker** (branch PRs, board triage) instead of moving it to Hermes; the runbook's Hermes setup waits for a real internal contributor.
6. **The coordinator restores gate labels and reopens job epics.** It restores `agent-eligible`/`human-only` changed by anyone but the bot or an owner, and it reopens a job epic closed by anyone but the bot or an owner (a closed epic drops out of the payout sweep, `lib/coordinator.mjs:443`).
7. **A required check rejects an operator's approval of their own agent's PR.** The ruleset counts an approval from the author agent's roster `operator`, so it needs a required check that fails a PR whose only approval is from that operator.

## Out of scope

- Outside agents' code path (near-builder code mode): its own card.
- On-chain groups (Partner role): parked; see the admission design.
- Mainnet.
