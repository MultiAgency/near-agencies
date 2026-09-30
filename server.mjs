// MultiAgency demo server. NEAR_NETWORK selects testnet (default) or mainnet.
//
//   GET  /                        the demo app (public/)
//   POST /api/quotes              start an engagement paid from the org's own wallet
//   GET  /api/quotes/:code        deposit status for a quote
//   GET  /api/quotes/:code/payer/:account  whether an account can pay the deposit
//   GET  /api/engagements[/:n]    engagements, teams, handoffs and payouts
//   GET  /api/engagements/:n/timeline  who did what when, for the swimlane
//   GET  /api/engagements/:n/payouts   proposals waiting for an approver's vote
//   GET  /api/roster/:login            where someone stands: join request, roster, tasks to claim
//   GET  /api/stats               jobs done, USDC paid, agents and people on the roster
//   GET  /api/health              coordinator liveness, the GitHub budget, stuck engagements
//   POST /api/join/message        the roster join message for a wallet to sign
//   POST /api/join/request        check a signed join request; returns the issue to open
//
// With FACILITATOR_URL set, the x402-paid routes are mounted too
// (lib/x402-intake.mjs): POST /engagements and GET /brief. With COORDINATOR=1
// this instance also runs the seat coordinator (lib/coordinator.mjs); run it in
// exactly one place.
import express from "express";
import { rateLimit } from "express-rate-limit";

import { listEngagements, loadEngagement } from "./lib/engagement-state.mjs";
import { mountEngagements } from "./lib/engagements.mjs";
import { errorHandler, readFailure } from "./lib/errors.mjs";
import { githubBudget, repoUrl } from "./lib/github.mjs";
import { network } from "./lib/network.mjs";
import { KINDS, SKILLS, mountOnboarding } from "./lib/onboarding.mjs";
import { roster } from "./lib/roster.mjs";
import * as store from "./lib/store.mjs";
import { engagementHealth } from "./lib/stuck.mjs";
import { timeline } from "./lib/timeline.mjs";
import { cached } from "./lib/cache.mjs";
import { daoApprovers, pendingPayouts } from "./lib/payouts.mjs";
import { isGithubLogin, memberStatus } from "./lib/status.mjs";

const deposit = process.env.ENGAGEMENT_DEPOSIT ?? "3000000";
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "4021");

const app = express();
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY));
app.use(express.json({ limit: "16kb", strict: true }));
app.use(express.static(new URL("./public", import.meta.url).pathname));

if (process.env.FACILITATOR_URL) {
  const { mountX402 } = await import("./lib/x402-intake.mjs");
  await mountX402(app, {
    facilitatorUrl: process.env.FACILITATOR_URL,
    apiKeyFile: required("FACILITATOR_API_KEY_FILE"),
    briefPayTo: required("PAY_TO"),
    briefPrice: process.env.AMOUNT ?? "1000",
    deposit,
  });
}
mountEngagements(app, { deposit });
mountOnboarding(app);
if (process.env.COORDINATOR === "1") {
  const { startCoordinator } = await import("./lib/coordinator.mjs");
  startCoordinator();
}

// Liveness you can check instead of infer: when the coordinator last finished a
// cycle, and the GitHub budget as this server's own requests see it.
app.get("/api/health", async (request, response) => {
  const running = process.env.COORDINATOR === "1" ? await import("./lib/coordinator.mjs") : null;
  const coordinator = running?.coordinatorHealth() ?? null;
  const stale = running?.coordinatorStale() ?? false;
  // Engagements that paid but have no epic need a look, not a restart, so they
  // are reported here without touching `ok`.
  const engagements = await store.all().then(engagementHealth, () => null);
  response.status(stale ? 503 : 200).json({ ok: !stale, coordinator, github: githubBudget(), engagements });
});

app.get("/api/config", (request, response) => {
  response.json({
    network: network.networkId,
    treasury: network.treasury,
    usdc: network.usdc,
    deposit,
    explorer: network.explorer,
    trezu: network.trezu && `${network.trezu}/${network.treasury}`,
    board: repoUrl,
    x402: Boolean(process.env.FACILITATOR_URL),
    roster: { kinds: KINDS, skills: SKILLS },
  });
});

const engagements = cached(30_000, listEngagements);
const engagement = cached(15_000, loadEngagement);
app.get("/api/engagements", handle(() => engagements()));
app.get("/api/engagements/:number", handle(request => engagement(Number(request.params.number))));

// For the job page's approval panel: the vote itself is signed in the
// approver's wallet, and the DAO decides who may cast it.
const approvers = cached(300_000, daoApprovers);
const payouts = cached(20_000, async number => pendingPayouts(await engagement(number), await approvers()));
// Each new login costs a GitHub search, which the coordinator also needs
// (join verification), and search allows 30 a minute for the whole server.
const status = cached(30_000, memberStatus);
const statusLimit = rateLimit({ windowMs: 60_000, limit: 10, message: { error: "Too many status checks from this address. Try again in a minute." } });
app.get("/api/roster/:login", statusLimit, (request, response, next) => {
  if (!isGithubLogin(request.params.login)) return response.status(400).json({ error: "That is not a GitHub login." });
  status(request.params.login).then(body => response.json(body), next);
});
app.get("/api/engagements/:number/payouts", handle(request => payouts(Number(request.params.number))));

// The home page's proof: what has been done and paid, from the board.
app.get("/api/stats", handle(async () => {
  const done = (await engagements()).filter(e => e.state === "closed");
  return {
    jobs_done: done.length,
    usdc_paid: done.reduce((sum, e) => sum + BigInt(e.committed), 0n).toString(),
    agents: roster.filter(b => b.kind === "agent").length,
    people: roster.filter(b => b.kind === "human").length,
  };
}));
app.get("/api/engagements/:number/timeline", handle(request => timeline(Number(request.params.number))));

app.use(errorHandler);

app.listen(port, host, () => {
  console.log(`MultiAgency demo on http://${host}:${port} (${network.networkId}, treasury ${network.treasury})`);
});

function handle(load) {
  return async (request, response) => {
    try {
      response.json(await load(request));
    } catch (error) {
      readFailure(response, error, request.params.number && `There is no job #${request.params.number}.`);
    }
  };
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
