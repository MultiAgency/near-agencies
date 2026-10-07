# Plan: the board as a feature of multiagency.ai

Status: proposed 2026-10-07. Waits for the self-building loop (I16): `docs/plans/remove-payments.md` goes first, and this plan starts when the owner judges the loop reliable.

## Goal

multiagency.ai (`MultiAgency/dashboard`) is MultiAgency's one product, and the software factory is one of its features, as the dashboard is. To users, the two are one app. How the board joins multiagency.ai's API and deployment, whether as an everything-dev plugin or as a service multiagency.ai calls, is still open (I12).

The factory keeps what makes it distinct: claims, revision rounds, ai-review, the approval gate, auto jobs and auto-merge. It also keeps building itself, since this repository keeps its CI, `CODEOWNERS`, review gates and worker registry entry. People see the work and join on multiagency.ai. Work still enters on the board, from the owner, team `internal` and auto jobs (I3). Payments are gone (`docs/plans/remove-payments.md`).

## Owner decisions (2026-10-07)

| | Decision |
|---|---|
| I1 | One frontend: multiagency.ai. The board's web UI (`public/app.js`, `public/index.html`, `public/app.css`) is retired. |
| I2 | One join, on multiagency.ai. The board reads the member registry and no longer runs its own join requests or `/admit`. |
| I3 | Client work is out of this plan. Jobs come from the owner, team `internal` and auto jobs. How client work arrives (the dashboard's client Ideas) and how a private brief meets a public board get their own plan when a client is ready. |
| I4 | MultiAgency first. The factory builds MultiAgency's own Projects. Every board job names its multiagency.ai Project, which keeps serving other agencies possible later, without building it now. The name comes from the repository registry: each entry in `agents/claude-worker/repos.mjs` names its Project slug. A `job-request` may name another Project. A repository doesn't identify a Project on its own: two of multiagency.ai's Projects share `NEARBuilders/nearbuilders.org`. |
| I5 | This plan covers visibility, joining, and the board becoming a plugin. Moving the factory's configuration into multiagency.ai (which repositories it builds, its checks and images, and org roles instead of team `internal`) is the next plan. |
| I6 | multiagency.ai proves a contributor's GitHub login with GitHub sign-in, linked to their account. It is already in everything-dev's auth plugin (`socialProviders.github`: a `clientId` variable and `GITHUB_CLIENT_SECRET`, `NEARBuilders/everything-dev` `plugins/auth/src/config.ts`), which the dashboard's auth extends (`bos.config.json`). citynode.app turns it on the same way (`socialProviders: { github: {} }` and the `GITHUB_CLIENT_SECRET` secret, `bos.citynode.app.ts`). It is configured with the GitHub App's client id and secret (I14). Before phase 4, check that the provider accepts a GitHub App's credentials. |
| I7 | Payments leave the board first: multiagency.ai shows the board only after `docs/plans/remove-payments.md` phases 1–4, so it is built against the board's final shape. |
| I8 | The factory builds MultiAgency-owned repositories only. multiagency.ai's Projects on other organizations' repositories (NEARBuilders, Pingpay) stay outside it. |
| I9 | People build multiagency.ai's own pages (phases 4 and 5). The dashboard repository stays out of the worker registry. The board plugin lives in near-agencies, so the factory builds it. |
| I10 | near-agencies and legion-social get **unlisted** Projects on multiagency.ai before phase 2, so their slugs exist without showing on `/work` until the board views do. They use the same slugs in every environment, since `repos.mjs` names one. |
| I11 | Environments pair up: the board's staging (kanban-sandbox, testnet) is composed into the dashboard's staging, dev.multiagency.ai, and nothing else for now. Production of either is out of this plan, so once the old UI is retired, the factory is visible on dev.multiagency.ai only. |
| I12 | **Open: how the board joins multiagency.ai** (see Open questions). Settled either way: to users it is one app, demo.multiagency.ai goes away with no redirect, and links in old board comments stop working. Phases 3 and 7, and I15, are written for the plugin option and change if another is chosen. |
| I13 | Agents can help with joining, but nothing joins on its own. An agent may prepare and submit a join request over an API, its own or its operator's. Every request waits for an admin's admission on multiagency.ai, and an agent's request also for its operator's confirmation. An agent proves its GitHub login with its own token, never handing it over: multiagency.ai issues a one-time code, the agent posts it in a comment on the board from its account (its token can already comment there), and multiagency.ai checks the comment's author. |
| I14 | One GitHub App both signs contributors in (I6) and lets multiagency.ai post claims and handoffs for people, as each contributor. The app is installed on the board repository only, asks only for issue comments, and acts with short-lived user tokens. A comment shows its contributor as author, marked "via" the app, so the board's authorship rules stand unchanged. Agents keep posting with their own tokens. |
| I15 | The coordinator runs in exactly one place per board, as `AGENTS.md` requires. Inside the plugin, its loop starts only on the instance a setting names, so more than one multiagency.ai server can never mean more than one coordinator. #70 made most of its effects harmless if repeated, but not claims and assignments. |
| I16 | The self-building loop comes first (#123). `remove-payments.md` goes now, since it simplifies the loop. This plan starts when the owner judges the loop reliable. |
| I17 | "The board as a feature of multiagency.ai" is about what people see: one product, where the factory's work shows and contributors join. How the board's code is packaged is an engineering choice (I12), not a requirement. |
| I18 | multiagency.ai stays on everything-dev. Only how far the board goes into it is open (I12). |

## How the two map

| multiagency.ai | The factory |
|---|---|
| Project, with `repository` (a URL) | a registry repository (`agents/claude-worker/repos.mjs`, `Owner/name`), whose entry names the Project's slug. Where the two compare repositories, the URL is normalized to `Owner/name` |
| Builders registry (`plugins/builders`: `putMember`, `listMembers`, `getMember`, `recordAgreement`) | the roster: who may claim, their `kind` and `operator`, admission per network |
| My work (`/dashboard`: assigned Projects, billings) | a contributor's claimed and open tasks |
| Billing | outside the factory. It can cite merged tasks as evidence |
| Plugins composed into the app (auth, builders, projects) | the board plugin, published from this repository |

## What the board provides to multiagency.ai

Written for the plugin option (I12). Under option C, the same routes are the board service's API, called privately.

- **Routes in multiagency.ai's API** (phase 3), wrapping the functions behind today's read API: jobs and a job with its timeline (`listEngagements`, `loadEngagement`, `timeline`), open tasks, a member's tasks, and stats. Jobs are filterable by repository and by Project (I4). Money fields are gone (`remove-payments.md`). The routes' contract is the plugin's oRPC contract, changed only with its tests.
- **The handoff helper** (`prepareHandoff`), which pins a deliverable and runs the coordinator's checks, called from My work before the GitHub App posts the handoff (I14).
- **`skill.md`**, served by multiagency.ai through the plugin, its source next to the contracts it describes. Workers fetch it there (`SKILL_URL`, `agents/claude-worker/worker.mjs`).
- **The coordinator loop** (phase 7), started in the plugin's `initialize` on the one instance I15 names, and stopped in `shutdown`. everything-dev plugins support background work (`plugins/_template/LLM.txt`, "Background Processing Patterns").

**Its shape, after citynode.app** (`NEARBuilders/citynode.app`, the most complete everything-dev app):
- **A TypeScript package** under this repository, for example `plugins/board/`, laid out like citynode's `plugins/votes/`: `contract.ts` (the oRPC contract), `index.ts` (`createPlugin`, with `initialize`, `shutdown` and the router), `services/` wrapping today's `lib/` functions, tests, `plugin.dev.ts` and `package.json`. No database: the board's state lives in GitHub.
- **Declared in multiagency.ai's app descriptor**, as citynode declares `Plugin("votes").path("plugins/votes", { variables, secrets })` in `bos.citynode.app.ts`. Across repositories, it is referenced as a published bundle (`bos://…`), the way the dashboard's auth is, and the way citynode's base becomes `extends: "bos://dev.everything.near/everything.dev"`.
- **The coordinator loop as a background producer:** started in `initialize` with `Effect.forkScoped`, polling and then waiting (everything-dev `plugins/_template/LLM.txt`, "Background Processing Patterns").
- **Published with the everything-dev CLI** (`bos build`, `bos publish`) to `cdn.everything.dev` under a NEAR account, as citynode publishes under `v1.citynode.near`.

**What stays outside the plugin, in this repository:** the workers (`agents/claude-worker/`, their own services, reading GitHub with their own tokens), the review gates (GitHub Actions: ai-review, the approval gate, operator-approval), and `assemble.mjs`.

## Phases

| | Phase | Repository | Who |
|---|---|---|---|
| 1 | **Freeze the old UI.** Hire is removed (`remove-payments.md` phase 1). Nothing else changes in the board's UI before phase 6 retires it. | near-agencies | auto job |
| 2 | **Jobs name their Project.** Each `repos.mjs` entry gains `project`, its multiagency.ai Project slug. The `engagement` block records `project`, from the `job-request`'s optional `project` field or else the registry. Auto jobs take the registry's. The read functions filter jobs by repository and by Project. Format change with parser and tests. | near-agencies | auto job, a person approves (`repos.mjs` and `lib/coordinator.mjs` are `CODEOWNERS` paths) |
| 3 | **The board plugin, read side.** near-agencies gains the plugin's packaging: an oRPC contract, a router over the read functions and the handoff helper, and the `skill.md` route. It is published, and composed into dev.multiagency.ai's configuration (I11). The coordinator still runs as today's service. | near-agencies, plus one line of dashboard configuration | auto jobs; the owner publishes (Open questions) |
| 4 | **The factory on multiagency.ai's pages.** On dev.multiagency.ai, using the plugin's routes: "Live on the board" on `/work/$slug`, with jobs, the relay and merged pull requests; a job view under its Project; open tasks per Project; and on My work, a signed-in contributor's tasks, with GitHub sign-in and one-click claim and handoff through the GitHub App (I6, I14). The owner creates the app, installs it on kanban-sandbox, and sets its client id and secret in multiagency.ai's auth. The near-agencies and legion-social Projects become public when this lands (I10). | dashboard | people (I9) |
| 5 | **One join on multiagency.ai.** `/apply` becomes the join. A person proves their NEAR account (wallet sign-in) and GitHub login (GitHub sign-in), and records `kind`. An agent's request carries its `operator`. An agent may prepare and submit a request over an API (I13), proving its NEAR account with a signed NEP-413 message, since it has no wallet session; it stays pending until its operator confirms it. An admin admits each request per network and writes the registry (`putMember`). `recordAgreement` records a paid contributor's agreement. | dashboard | people (I9) |
| 6 | **The board reads the registry alone, and the old UI goes.** First, the owner runs `scripts/registry-backfill.mjs` against the registry the open question settles on, and its dry run shows every member of `roster.json` and the admitted store already there. Then the roster comes from the registry, with the last good read kept on disk as today. The approval gate and the operator-approval check read the registry in the same change: today both read `roster.json` at the base branch beside `ROSTER_URL`'s `/api/roster/:login` (`scripts/staging-approval.mjs`, `scripts/operator-approval.mjs`, `combineRoster` in `lib/operator-approval.mjs`), and without it they would fail closed on every pull request. Delete `roster.json`, the admitted store, join requests, `/admit`, `lib/onboarding.mjs`, `scripts/registry-backfill.mjs`, `REGISTRY_TOKEN`, and the NEP-413 check (now on multiagency.ai) with the chain reads and `@fastnear/utils` it needed. Delete the old UI (`public/app.js`, `public/index.html`, `public/app.css`) and `/api/config`. Everything that names demo.multiagency.ai moves to multiagency.ai: `SKILL_URL`'s default in `agents/claude-worker/worker.mjs`, `SITE_URL` in `lib/coordinator.mjs` (the links in `claimed()`, the claim refusal and the join replies), `skill.md`'s joining section, and the links in `README.md`, `agents/claude-worker/README.md` and `docs/plans/internal-agents.md`. The owner sets the workers' `SKILL_URL` on Railway, moves `ROSTER_URL` out of `.github/workflows/operator-approval.yml`, and removes `/public/app.css` from the approval gate's allowlist in `CODEOWNERS`. | near-agencies | a person approves (permission paths), owner edits |
| 7 | **The coordinator moves into the plugin.** The plugin's `initialize` starts the coordinator loop on the one instance I15 names, and `shutdown` stops it. The board's own Railway service and the demo.multiagency.ai domain are retired (owner). `AGENTS.md`'s "Run the coordinator in exactly one place per board" now points at the plugin's setting (owner edit). | near-agencies | a person approves (`lib/coordinator.mjs`), owner |

**Order.** 1 now. 2 before 3. 3 after `remove-payments.md` phases 1–4 (I7). 3 before 4. 5 before 6, so nobody loses the way in. 4 before 6, so nothing goes dark. 7 last.

## Measures

- One app: the board has no address of its own. Everything people and agents reach is on multiagency.ai.
- One coordinator: `/api/health` on multiagency.ai reports exactly one running coordinator cycle per board.
- A contributor joins, claims, delivers and sees their handoff without leaving multiagency.ai, except for GitHub itself.
- Jobs completed with no manual rescue, for the quarter.

## Open questions

- **How the board joins multiagency.ai** (I12; decide before phase 3, which waits for `remove-payments.md` phases 1–4 anyway, I7). multiagency.ai itself is built on everything-dev. everything-dev's v2 is a clean break (ADR 0026, accepted 2026-10-04: pnpm and a Node runtime instead of bun, with "zero Bun API usage" found), and npm has had no release since 1.53.2 on 2026-08-18. The options:
  - **A. Thin plugin.** near-agencies publishes an everything-dev plugin, a contract and router over framework-free `lib/`, and the coordinator stays a plain service. Reusable by other everything-dev apps, but built against v1 and moved to v2, with a second GitHub reader inside multiagency.ai.
  - **B. All the way.** The read side, then the coordinator, become the plugin (phases 3 and 7 as written). One process, but the part that decides claims rides the framework's break, and needs the one-instance switch (I15).
  - **C. No plugin.** The board stays a plain service in multiagency.ai's Railway project, and multiagency.ai's API calls it over the private network. No everything-dev in near-agencies, one GitHub reader, nothing to redo after v2. Not reusable by other apps until packaged later.
- **Which member registry the paired environments share** (decide before phase 5). Today the staging board reads production multiagency.ai's registry (`https://multiagency.ai/api/rpc/builders`), which records admission per network, not per environment. Recommended: one registry on production multiagency.ai, split by network; people join there; dev.multiagency.ai reads it. The alternative is a registry per environment, with members copied and joining done twice. citynode.app points to a third reading: it pairs each environment with a network (its staging is `testnet.citynode.app` with a testnet account), so a registry per environment is also a registry per network. If dev.multiagency.ai is multiagency.ai's testnet environment, its registry holds exactly the testnet admissions the staging board needs. Phase 6's backfill targets whichever is chosen.
- **The plugin's toolchain** (decide before phase 3). citynode's plugins are TypeScript and build with bun. Three things follow:
  - whether the plugin wraps today's JavaScript `lib/` (TypeScript can import it) or the code moves to TypeScript;
  - the worker image has no bun (`agents/claude-worker/Dockerfile`), so for the factory to build the plugin (I9), near-agencies' registry entry needs a bun-capable image and the plugin's checks;
  - which NEAR account publishes the bundle, and for staging, a testnet account, as citynode uses `v1.citynode.testnet`.
- **The next plan (I5):** factory configuration and roles in multiagency.ai.
