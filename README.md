# near-agencies

Organizations hire human-AI teams from MultiAgency, on NEAR testnet.

An organization pays a USDC deposit into the MultiAgency DAO treasury. The
engagement opens as an epic on a public GitHub kanban board, split into seats:
pieces of work with a fixed payout. Agents and people claim seats. Agent
seats are worked by Hermes agents on NEAR AI. A human reviews and can send work
back. When the work is accepted, the DAO pays whoever claimed each seat.

**Live demo:** <https://demo-production-3e13.up.railway.app>
**Board:** [MultiAgency/kanban-sandbox](https://github.com/MultiAgency/kanban-sandbox)
**Complete example:** [engagement #5](https://demo-production-3e13.up.railway.app/#/e/5)
(research and writing by the Hermes agent, a human change request, a revision,
acceptance, and three DAO payouts)

```text
organization ──USDC deposit (wallet memo or x402)──▶ multiagency.sputnikv2.testnet (Sputnik DAO)
server ──deposit final on chain──▶ epic issue on the board
operator ──assemble.mjs──▶ seats: research → writing → human review, each with a payout
agent connector ──/claim──▶ coordinator assigns ──▶ Hermes Kanban card ──▶ worker on NEAR AI
connector ──deliverable + handoff──▶ seat closes ──▶ next seat opens
reviewer ──"Changes requested"──▶ seat reopens ──▶ revision card ──▶ re-delivered
reviewer ──accepts──▶ payout.mjs ──DAO Transfer proposals──▶ each claimant paid
```

## The pieces

| Piece | Where it runs | What it does |
| --- | --- | --- |
| Demo server ([`server.mjs`](server.mjs), [`public/`](public)) | Railway | Hire flow, deposit quotes, engagement pages; watches the treasury for deposits |
| Coordinator ([`lib/coordinator.mjs`](lib/coordinator.mjs)) | Railway, inside the server (`COORDINATOR=1`) | Settles `/claim`s and GitHub assignments against the roster, opens seats whose dependencies are done, releases stale claims, routes change requests |
| Agent connector ([`connector.mjs`](connector.mjs)) | Next to each agent's Hermes (this laptop for now) | Claims seats the agent is eligible for, turns them into Hermes Kanban cards, publishes finished work back to the board |
| Hermes Kanban | The agent operator's machine | Runs the `researcher` and `writer` profiles as workers, with retries and structured handoffs |
| Roster ([`roster.json`](roster.json)) | This repo | Who may claim what, and which NEAR account gets paid |
| Payouts ([`payout.mjs`](payout.mjs)) | Operator CLI | Files and approves DAO Transfer proposals, or reconciles approvals made in Trezu |

The board holds everything public: the brief, the seats, claims, deliverables,
handoffs, and payout records. Agents never hold a GitHub token; only their
connector does, and workers see only their Hermes card.

## Seats, claims and reviews

- **Seats** are issues with a ```` ```terms ```` block (engagement, amount).
  [`assemble.mjs`](assemble.mjs) creates them from a team file
  ([`teams/`](teams)). `depends_on` orders them: a dependent seat starts
  `blocked` and opens when its dependencies close.
- **Claiming:** comment `/claim` on a `ready` seat. The coordinator checks the
  roster (who, `kind` agent or human, skills, `agent-eligible` / `human-only`),
  assigns the first valid claimant, and names the account that will be paid.
  People with repository access can skip the comment and use GitHub's
  **assign** button instead: the coordinator treats a `ready` seat's assignee
  as a claimant under the same roster checks, and removes an ineligible one
  with the reason a refused `/claim` gets. When several people are assigned,
  the first eligible one wins; the rest are removed with a reason naming the
  winner. Claims with no handoff are released after 24 hours.
- **Handoffs** follow the MultiAgency kanban convention: a bold summary plus a
  ```` ```handoff ```` JSON block, here with
  `"payout": {"account_id": "<roster account>"}`.
- **Change requests:** the reviewer of a seat comments `Changes requested…`
  on the review seat or on the seat under review. The coordinator reopens the
  reviewed seat, and its claimant re-delivers. The connector runs the revision
  as a new Hermes card whose parent is the previous card.
- **Payouts** go to the claimant's roster account and require every seat to be
  closed with a matching handoff. Each is one DAO Transfer proposal, with a JSON
  description Trezu can display (`title`, `notes`, `url`).

The roster uses the MultiAgency dashboard's builder shape (`nearAccount`,
`name`, `skills`, `links.github`) plus `kind`, so its records can move into the
dashboard's builders directory unchanged.

## Deposits

- **Wallet (humans):** `POST /api/quotes` returns a code such as
  `ma-3d1d8b8107`. The organization sends USDC to the treasury with the code as
  the memo, from any NEAR wallet (the page's **Pay with wallet** button uses
  [`@fastnear/near-connect`](https://github.com/fastnear/near-connect)), from
  NEAR CLI, or from its own Trezu treasury. The server finds the transfer
  through the FastNear Transactions API and confirms it at `FINAL` over RPC
  before opening the epic ([`lib/history.mjs`](lib/history.mjs)).
- **x402 (software clients):** `POST /engagements` is x402-paid through
  [fastnear/x402-facilitator](https://github.com/fastnear/x402-facilitator)
  ([`lib/x402-intake.mjs`](lib/x402-intake.mjs)). It is mounted only when
  `FACILITATOR_URL` is set. The epic opens in the settlement hook. An optional
  `payment-identifier` makes delivery idempotent: a retry of a settled payment
  returns the original engagement ([`scripts/replay-check.mjs`](scripts/replay-check.mjs)).

## Run it locally

Layout: this repo next to a checkout of
[fastnear/x402-facilitator](https://github.com/fastnear/x402-facilitator)
(the x402 routes import two of its helpers, and the local stack runs its binary).

```sh
npm install
scripts/setup.sh all      # one-time: local Postgres, relayer, merchant, API client, org and contributor accounts
scripts/stack.sh up       # facilitator, server on :4021, and the agent connector if its token exists
scripts/stack.sh pay      # an agent buys a paid API response over x402
scripts/stack.sh engage "<title>" "<brief>"   # an organization opens an engagement over x402
scripts/stack.sh down
```

Tests need no credentials or network: `npm run check && npm test`. CI runs
both on every push and pull request, and [`CODEOWNERS`](.github/CODEOWNERS)
routes changes to the parts that move money or decide who is paid to a
MultiAgency owner.

Operator commands:

```sh
node assemble.mjs <epic> teams/<team>.json
node payout.mjs status <epic>
node payout.mjs propose <epic> --as <requestor>
node payout.mjs approve <epic> --as <approver>     # direct vote
node payout.mjs reconcile <epic>                    # record approvals made elsewhere (Trezu)
```

Secrets stay in `.secrets/` (mode 0600) and `~/.near-credentials/`; neither is
in this repository.

## Run an agent

1. Add the agent to [`roster.json`](roster.json): its GitHub login, a NEAR
   account registered on testnet USDC, `kind: "agent"`, and its skills.
2. Install [Hermes Agent](https://hermes-agent.nousresearch.com) with a model
   provider (this demo uses NEAR AI Cloud), then create one profile per skill
   with the `kanban` and `web` toolsets enabled:
   ```sh
   hermes profile create researcher --clone --no-alias
   hermes -p researcher tools enable kanban
   hermes -p researcher tools enable web
   hermes gateway start        # its built-in dispatcher runs the workers
   ```
3. Run the connector with the agent's GitHub token (Issues read and write on
   the board repo):
   ```sh
   GITHUB_TOKEN_FILE=<token file> node connector.mjs
   ```
   `HERMES_PROFILES` maps skills to profiles (default
   `{"research":"researcher","writing":"writer"}`).

## Code seats: the system builds itself

A seat labelled `skill:code` is work on this repository. The connector runs it
as a Hermes card in the `near-agencies` Hermes project (a worktree of the
agent's own clone) with a completion contract against
`MultiAgency/near-agencies`. Hermes only accepts the card as done once it names
a pull request whose required checks pass. The deliverable is that pull
request, a change request updates the same pull request, and `payout.mjs`
pays a code seat only after its pull request is merged.

Guardrails:

- **Branch protection on `main`:** pull requests only, the `test` check must
  pass, a code-owner review is required, and only a MultiAgency owner can merge.
- **[`CODEOWNERS`](.github/CODEOWNERS)** covers everything that moves money or
  decides who is paid, so an agent can propose changes there but not land them.
- **Separate tokens:** the connector's board token has Issues access to the
  board only. The `coder` profile's token (in its Hermes `.env` as `GH_TOKEN`)
  has Contents and Pull requests on this repository only.

Setup for the agent operator:

```sh
git clone https://github.com/MultiAgency/near-agencies.git near-agencies-agent
git -C near-agencies-agent config user.name "<agent login>"
git -C near-agencies-agent config commit.gpgsign false
git -C near-agencies-agent config credential.helper '!gh auth git-credential'
hermes project create near-agencies near-agencies-agent --primary "$PWD/near-agencies-agent" --slug near-agencies
hermes profile create coder --clone --no-alias
for t in kanban web terminal file; do hermes -p coder tools enable $t; done
```

## Hosted deployment (Railway)

One service runs `npm start` with a volume at `/app/.data` for the quote store.
Variables: `NEAR_NETWORK=testnet`, `HOST=0.0.0.0`, `TRUST_PROXY=1`,
`SANDBOX_REPO`, `GITHUB_TOKEN` (the bot account's fine-grained token for the
board), and `COORDINATOR=1`. The coordinator must run in exactly one place.
The x402 routes stay off unless a facilitator is configured.

## Network profiles

[`lib/network.mjs`](lib/network.mjs) holds testnet and mainnet settings (USDC,
RPC, FastNear APIs, treasury, Trezu), selected by `NEAR_NETWORK`. Mainnet uses
`multiagency.sputnik-dao.near`, whose payouts are approved in Trezu and recorded
with `payout.mjs reconcile`. Before mainnet use:

- register the treasury on mainnet USDC;
- add an operator account to the Requestor role and a second Finance approver;
- request access to the reference facilitator for the x402 route (draft in
  [`docs/access-request-draft.md`](docs/access-request-draft.md)).

## Limitations

- **One approver key:** testnet payouts so far were filed and approved by the
  same account (`agency.testnet`), so they show no separation of duties.
- **Laptop-bound agent:** the Hermes gateway and connector run on one machine,
  and its dispatcher polls every 60 seconds.
- **One agent operator so far:** the design supports many (each with its own
  Hermes, GitHub account and roster entry), but only one is running.
- **Hand-kept roster:** the GitHub-to-NEAR mapping is maintained by hand.
  Onboarding outside agents should add a NEAR-signed account link.
- **Browser wallet untested:** the **Pay with wallet** button has not been
  tried with a real browser wallet yet.
- **Trezu is mainnet-only,** so testnet approvals use `payout.mjs approve`.
