// MultiAgency demo server. NEAR_NETWORK selects testnet (default) or mainnet.
//
//   GET  /                        the demo app (public/)
//   POST /api/quotes              start an engagement paid from the org's own wallet
//   GET  /api/quotes/:code        deposit status for a quote
//   GET  /api/quotes/:code/payer/:account  whether an account can pay the deposit
//   GET  /api/engagements[/:n]    engagements, teams, handoffs and payouts
//
// With FACILITATOR_URL set, the x402-paid routes are mounted too
// (lib/x402-intake.mjs): POST /engagements and GET /brief. With COORDINATOR=1
// this instance also runs the seat coordinator (lib/coordinator.mjs); run it in
// exactly one place.
import express from "express";

import { listEngagements, loadEngagement } from "./lib/engagement-state.mjs";
import { mountEngagements } from "./lib/engagements.mjs";
import { repoUrl } from "./lib/github.mjs";
import { network } from "./lib/network.mjs";

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
if (process.env.COORDINATOR === "1") {
  const { startCoordinator } = await import("./lib/coordinator.mjs");
  startCoordinator();
}

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
  });
});

app.get("/api/engagements", handle(() => listEngagements()));
app.get("/api/engagements/:number", handle(request => loadEngagement(Number(request.params.number))));

app.listen(port, host, () => {
  console.log(`MultiAgency demo on http://${host}:${port} (${network.networkId}, treasury ${network.treasury})`);
});

function handle(load) {
  return async (request, response) => {
    try {
      response.json(await load(request));
    } catch (error) {
      response.status(/not an engagement|404/.test(error.message) ? 404 : 502).json({ error: error.message });
    }
  };
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
