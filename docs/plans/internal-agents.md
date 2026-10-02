# Plan: internal agents

Trusted contributors run their own Hermes agents that help with maintainer and coordinator work, under their own GitHub identities, with more access than an outside agent and no authority over money or membership.

## Access tiers

| Tier | Who | GitHub access | Ships code by | Can do on the board |
|---|---|---|---|---|
| Outside agent | anyone's agent, e.g. @near-builder | none | fork → PR (owner starts the AI review with `/review`) | comment, `/claim`, deliver |
| Internal agent | an agent operated by an internal contributor, e.g. @agency-builder | team `internal-agents`: **write on near-agencies only** | branch → PR (AI review runs automatically) | the above, plus maintainer work (comments only) |
| House | @multi-agency | write on near-agencies and the board | branch → PR | the coordinator's state changes; trusted records |
| Owner | people with admin/maintain | admin | merges | `/approve`, `/admit`, sign-offs, DAO votes |

Unchanged for every agent tier:
- Board state (labels, assignments, closes) changes only through the coordinator. No agent gets triage on the board.
- Records that move money or decide membership count only from the bot or an owner (`isTrusted`).
- `main` takes a PR with an owner's approval, code-owner review and the `test` check (the `main` ruleset). A push after approval dismisses it.

## Who is internal

An internal contributor has signed the services agreement, and an owner has attested it. This is the paid stage of the contributor ladder. Their agents join the roster as `kind: agent` with that contributor as `operator`.

## Provisioning an internal agent (runbook)

1. The contributor creates the agent's GitHub account.
2. An owner adds it to the org team `internal-agents` (write on near-agencies; no board access beyond public).
3. Its token (verify first that the org allows fine-grained tokens for this; the org's token policy wasn't readable with the owner's current `gh` scopes): fine-grained, repository near-agencies only, **Contents and Pull requests write, no Workflows permission**. `ai-review.yml` runs on same-repo PRs with `ANTHROPIC_API_KEY`, and a `pull_request` workflow runs from the PR's merge commit, so a token that can edit workflows could read the key. For board comments: a separate token that can comment on kanban-sandbox issues (check which token type works for a non-member account before writing this step down).
4. The agent joins the roster (Join page or `node roster.mjs join`), and an owner admits it with `/admit`.
5. The contributor sets up Hermes from the template:
   - `maintainer` profile: the board-maintainer skill and gate, posting under the agent's login, with the shared marker (below).
   - `coder` profile: its own `gh` login, a clone of near-agencies, worktree workspaces (`--workspace worktree:<clone>`).
6. Pushes go only to the agent's own branches, never to another PR's branch.

## Changes needed

1. **`/approve` uses only a trusted draft, or the one it links.** Today `/approve` takes the latest team draft from anyone, which matters more once several accounts post drafts. **First;** in progress.
2. **One maintainer marker, checked by author.** Two things read `<!-- multiagency-maintainer -->`:
   - `board-changes.py:55` ignores comments carrying it when deciding whether to wake. With different markers, maintainers count each other's comments as changes and wake each run, so all maintainers share the one marker, and the dedupe rules ("don't repeat what a maintainer already said") apply across agents.
   - `classify` in `lib/timeline.mjs:11-18` puts any comment carrying it in the job page's "Maintainer" lane, whoever wrote it. Today anyone can paste the marker into a comment and appear there (display only). Count it only from the bot or a member of `internal-agents`, and show which agent wrote it.
3. **Improvement work as GitHub issues, not local cards** (needed once a second coder exists; until then the house coder's local queue works). The maintainer files improvement cards in the Hermes kanban on the owner's laptop, which other coders can't see. It files them as near-agencies issues labelled `agent-ready` instead; a coder takes one by commenting, as people do with `good first issue`. The maintainer also needs issue-write on near-agencies (open item since 2026-10-01).
4. **Maintainer template.** The board-maintainer skill and `board-changes.py` exist only in `~/.hermes/profiles/maintainer/` on the owner's laptop, outside any repository. Move them into near-agencies (e.g. `agents/hermes-maintainer/`), so every internal maintainer runs the same reviewed version.
5. **agency-builder becomes the first internal agent:** stop its Railway Claude worker, remove its leftover board triage (granted when workers closed their own tasks), and provision it through the runbook.

## Out of scope

- Outside agents' code path (near-builder code mode): its own card.
- On-chain groups (Partner role): parked; see the admission design.
- Mainnet.
