# Plan: remove payments from the factory

Status: proposed 2026-10-07. Phase 0 done 2026-10-07.

## Goal

near-agencies coordinates work and moves no money. Contributors on the roster are paid under their own agreements, outside the board. Clients pay MultiAgency under agreements, outside the board. The board holds no NEAR key, takes no deposit, files no payout, and carries no money field in its records.

Git history keeps the removed code. The owner may tag the last commit that has it.

## Owner decisions (2026-10-07)

| | Decision |
|---|---|
| R1 | No payments through the board in either direction: no payouts to contributors, no deposits from clients. |
| R2 | The roster keeps the NEAR account as identity. This plan removes only payout wording and USDC registration from onboarding. Moving the join to multiagency.ai, and with it the signed NEP-413 request and `/admit`, belongs to `docs/plans/dashboard-integration.md`. |
| R3 | Money fields come out of the board's records (task amount, job deposit, the handoff's payout account, `payout` and `paid` records), together with their parsers and tests. Old jobs still render, read as history. |
| R4 | The code is deleted, not moved: git history keeps it. |

These supersede rows in `docs/decisions.md`: per-task payouts for external contributors (2026-10-04), paid outside work being possible (2026-10-04), zero-deposit jobs as the exception to Hire's deposit (2026-10-04), the buyer-chosen deposit (2026-10-04), and the owner acting as the client "opening jobs through the Hire flow" (2026-10-04). The owner updates the log.

## Why

- **Owner attention.** The approval gate approves no `lib/` module "since every lib/ module runs in the server process that holds the payout keys" (#108), and `CODEOWNERS`, `REVIEW.md` and `AGENTS.md` treat money paths as the highest risk. Without money, that review load goes away, and the allowlist can be decided on its merits (phase 6).
- **The self-building loop is the priority** (#123). Paid volume was already near zero: the last funded job, #45, opened 2026-10-03, and every job since has been zero-deposit.

## What stays

- Jobs from `job-request` issues (owner or team `internal`) and auto jobs; team drafts and `/approve`; claims, handoffs, change requests, sign-off by a review task, and the guard sweep.
- Code tasks' delivery checks, now as delivery rather than payout rules: the pull request is by the claimant, merged, and merged into its repository's base branch. Today the base is checked only for auto jobs (`pullsProblem`, `m.source &&`). It applies to every code task from now on, starting from a failing test.
- A job closes when every task has delivered (`closeIfPaid`'s volunteer path, renamed). `**Job complete.**` stays.
- Onboarding: the signed join request, verification, `/admit` and the registry write, until joining moves to multiagency.ai (`docs/plans/dashboard-integration.md`, phases 5–6).
- Read-only chain access onboarding needs (`view`, `rpc`, `lib/network.mjs`) and `@fastnear/utils` (NEP-413 verification), for as long as onboarding stays on the board.

## What goes

- **Payouts:**
  - `payout.mjs`;
  - in `lib/payouts.mjs`: proposing, recording, the duplicate audit and `daoApprovers`/`pendingPayouts`. The delivery checks move to a board module;
  - `findApproval` and `txBlockHeight` in `lib/history.mjs`;
  - the payout part of `settlePayouts` in `lib/coordinator.mjs`, and the `paid_twice` and `payout_audit_capped` health fields;
  - `GET /api/engagements/:number/payouts` and the approval panel in `public/app.js`;
  - the payout lane in `lib/timeline.mjs`, and the payout and paid fields and totals in `lib/engagement-state.mjs`. Old records are skipped, not shown as errors.
- **Deposits:**
  - Hire's quotes (`POST /api/quotes`, `GET /api/quotes/:code`, `/payer/:account`), the deposit watcher and recovery: all of `lib/engagements.mjs`, except `freshCode` and `invalidBrief`, which move to `lib/epic.mjs`;
  - `lib/x402-intake.mjs`, `lib/brief.mjs` (the paid account brief), `lib/store.mjs`, `lib/recover.mjs` and `lib/stuck.mjs`. `lib/serialize.mjs` stays, since `connector.mjs` uses it;
  - `findDeposit`, `finalBlockHeight` and `ftTransfers` in `lib/history.mjs`, and `lib/pay.mjs`, `agent.mjs`, `org.mjs` and `scripts/replay-check.mjs`;
  - the quote page in `public/app.js`, and the engagement-store health in `server.mjs`;
  - the `@x402/*` and `@fastnear/x402` dependencies, and the local stack's facilitator, PostgreSQL and x402 accounts (`scripts/setup.sh`, `pg.sh`, `env.sh`, `stack.sh`).
- **Signing:** `call` and `credential` in `lib/near.mjs`.
- **USDC registration:** `ensureUsdcRegistration`, `registerPayees`, `usdc_registered` on the status page, and the Join page's registration step.
- **Money fields in records:**
  - `terms.amount`, `team.committed`, `isVolunteer` and the amount rules in `lib/team.mjs` and `assemble.mjs`;
  - `engagement.deposit`, which becomes `opened_by` (the login that opened the job);
  - the handoff's `payout.account_id` (`handoffProblem` in `lib/seats.mjs`, `prepareHandoff` in `lib/handoff.mjs`);
  - the money wording in the `Claimed by @…` reply, in `lib/status.mjs`, `lib/tasks.mjs` and the worker's prompt (`agents/claude-worker/worker.mjs`, "for payout.account_id"), and in `public/skill.md`.
- **Configuration:** `network.treasury` and `network.usdc` once nothing reads them, and the `ENGAGEMENT_DEPOSIT*` and `FACILITATOR_*` variables (the owner, on Railway).

Parsers keep reading old records: an unknown field such as an old handoff's `payout` is ignored, never refused, so closed jobs render as before.

## Phases

Each phase is one or more contained changes, and starts from a failing test where it changes behavior.

| | Phase | Who |
|---|---|---|
| 0 | **Keys off the board.** `PROPOSER_*` and `REGISTRAR_*` removed from Railway, `staging` and `production`. **Done 2026-10-07.** | Owner |
| 1 | **No Hire, no deposits.** Four issues, each sized for a worker run:<br>**1a.** x402: the paid routes, `lib/brief.mjs`, `lib/pay.mjs`, the payer CLIs, `scripts/replay-check.mjs`, and the dependencies.<br>**1b.** The local stack without x402: no facilitator, PostgreSQL or x402 accounts.<br>**1c.** Hire: the brief form and its pay copy (replaced by links to multiagency.ai, `docs/plans/dashboard-integration.md` phase 1), the quote routes and page, and the deposit settings. `invalidBrief`'s tests move to `test/epic.test.mjs`.<br>**1d.** The deposit watcher, the store and recovery. `freshCode` and `invalidBrief` move to `lib/epic.mjs`. | near-agencies (1a's `package.json` needs a person) |
| 2 | **No USDC registration.** Delete `ensureUsdcRegistration`, `registerPayees` and `REGISTRAR`. `/admit` admits with no registration note. Remove `usdc_registered`. The Join page's and `skill.md`'s registration steps are already gone. | near-agencies |
| 3 | **No payouts.** Everything under Payouts and Signing above. Delivery checks move to a board module, with the base-branch fix. Jobs close when delivered. The `AGENTS.md` contracts for `payout`, `paid`, `**Payout proposed:**` and `**Paid:**` go (owner edit, same change set). | near-agencies, owner |
| 4 | **No money fields.** Everything under Money fields above, with parsers and tests. The `AGENTS.md` fence list loses `payout` and `paid` (owner edit). | near-agencies, owner |
| 5 | **Docs and policy.** `README.md`, and what `public/skill.md` still says about payouts (the handoff's `payout` field, once phase 4 removes it, and which changes need an owner's review). The owner edits `AGENTS.md`'s "Money and permissions" (permissions remain), `REVIEW.md`'s money language, the `CODEOWNERS` money block, `docs/decisions.md`, and the quarter's measure in `docs/plans/ai-native-sdlc.md` ("paid client jobs"). | near-agencies, owner |
| 6 | **The allowlist decision.** With no keys and no money on the board, decide which `lib/` modules the approval gate may approve. Permission paths (claims, `/approve`, `/admit`, owners, the roster) keep a person's review. | Owner |

Order: 1 and 2 are independent. Within 1: a, b, c, d. 3 and 4 touch the same files (`lib/coordinator.mjs`, `lib/payouts.mjs`, `lib/seats.mjs`), so they go one after the other. 5 follows 1–4. 6 is last.

The old UI's and `skill.md`'s promises of pay were removed on 2026-10-07, ahead of these phases.

## Running it on the board

- Phases 1a–1d and 2 are auto jobs: one `ready-for-agent` issue each, labelled one after the other. They touch `CODEOWNERS` money paths, so a person approves.
- Phases 3, 4 and 5 are each too big for one worker run ($3, 60 turns, `agents/claude-worker/worker.mjs`). Each goes as a `job-request` job with a team draft: two or three tasks with `depends_on`, and a review task. Or as a series of issues of up to about six files each.
- Every issue states the change, the files, the failing test first, what is out of scope, and links this plan, which must be on `staging` first.

## Measures

- Nothing can sign: `lib/near.mjs` exports no `call` or `credential`, and nothing reads `PROPOSER_KEY`, `REGISTRAR_KEY` or `~/.near-credentials`.
- Nothing moves money: no `/api/quotes` or `/api/engagements/:number/payouts` route, and no module files a DAO proposal (`add_proposal`).
- No money in the records: `fenced()` readers and `AGENTS.md`'s fence list carry no `payout` or `paid`, `teamProblem` reads no `amount`, and a test shows an old handoff with a `payout` field still parses.
- Jobs completed with no manual rescue (`docs/plans/ai-native-sdlc.md`), the quarter's measure once its wording drops "paid".

## Open questions

- **What the home page offers a client** once Hire takes no deposit: settled. multiagency.ai's `/contact` replaces Hire, client work waits for its own plan, and the board's UI is retired (`docs/plans/dashboard-integration.md`).
- **The DAO treasury** (`multiagency.sputnikv2.testnet`) and its roles: off the board's concern. The owner decides what happens to it.
- **legion-social's job:** its code tasks were already volunteer. Confirm that nothing there assumed paid tasks.
