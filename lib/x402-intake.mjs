// x402-paid routes, mounted only when a facilitator is configured:
//
//   POST /engagements         a software client opens an engagement; the deposit
//                             settles through the facilitator and the engagement
//                             opens in the settlement hook
//   GET  /brief?account=<id>  a NEAR account brief from the FastNear API
//
// An optional payment-identifier makes engagement delivery idempotent: a
// byte-identical retry of a settled payment returns the original engagement
// instead of a 402, and the same identifier on a different payment is a 409.
import { readFile } from "node:fs/promises";

import { createNearResourceServer } from "@fastnear/x402/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer } from "@x402/express";
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
} from "@x402/extensions/payment-identifier";

import { payloadFingerprint } from "../../x402-facilitator/examples/resource-server/journal.mjs";
import { withFacilitatorRetries } from "../../x402-facilitator/examples/resource-server/retry.mjs";

import { createQuote, invalidBrief, openEngagement, publicQuote } from "./engagements.mjs";
import { network } from "./network.mjs";
import * as store from "./store.mjs";

const SETTLED = new Set(["opening", "open", "deposit_settled_epic_failed"]);

export async function mountX402(app, { facilitatorUrl, apiKeyFile, briefPayTo, briefPrice, deposit }) {
  const apiKey = (await readFile(apiKeyFile, "utf8")).trimEnd();
  const resourceServer = createNearResourceServer({
    facilitators: withFacilitatorRetries(
      new HTTPFacilitatorClient({
        url: facilitatorUrl,
        createAuthHeaders: async () => ({
          supported: {},
          verify: { "X-API-Key": apiKey },
          settle: { "X-API-Key": apiKey },
        }),
      }),
    ),
  });

  const routes = {
    "GET /brief": {
      accepts: [{ scheme: "exact", price: { asset: network.usdc, amount: briefPrice }, network: network.caip2, payTo: briefPayTo }],
      description: "NEAR account brief: balance, storage, fungible tokens, staking pools",
      mimeType: "application/json",
    },
    "POST /engagements": {
      accepts: [{ scheme: "exact", price: { asset: network.usdc, amount: deposit }, network: network.caip2, payTo: network.treasury }],
      description: "Open a MultiAgency engagement: a human-AI team assembled for your brief",
      mimeType: "application/json",
      extensions: { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false) },
    },
  };

  resourceServer.onAfterSettle(async ({ requirements, result, transportContext }) => {
    if (requirements.payTo !== network.treasury) return;
    const { code } = JSON.parse(transportContext.responseBody.toString("utf8"));
    await openEngagement(code, { transaction: result.transaction, org: result.payer, amount: requirements.amount });
  });

  app.use(paymentMiddlewareFromHTTPServer(
    new x402HTTPResourceServer(resourceServer, routes).onProtectedRequest(journalPaymentIdentifier),
  ));

  // Paid routes must be mounted after the payment middleware.
  app.post("/engagements", async (request, response) => {
    const payment = request.engagementPayment;
    if (payment?.conflict) {
      return response.status(409).json({ error: "payment identifier already used for a different payment" });
    }
    if (payment?.replay) {
      const prior = await store.get(payment.prior);
      return response.json({ ...publicQuote(prior), status_url: `/api/quotes/${prior.code}`, replayed: true });
    }
    const error = invalidBrief(request.body);
    if (error) return response.status(400).json({ error });
    // A retry whose first attempt never settled keeps its original code.
    const quote = payment?.prior
      ? publicQuote(await store.get(payment.prior))
      : await createQuote({ ...request.body, channel: "x402", amount: deposit, payment });
    response.status(201).json({ ...quote, status_url: `/api/quotes/${quote.code}` });
  });

  app.get("/brief", async (request, response) => {
    const account = String(request.query.account ?? "");
    if (!/^[a-z0-9._-]{2,64}$/.test(account)) {
      return response.status(400).json({ error: "account query parameter must be a NEAR account ID" });
    }
    const upstream = await fetch(`${network.fastnearApi}/v1/account/${account}/full`);
    if (!upstream.ok) return response.status(502).json({ error: `FastNear API returned ${upstream.status}` });
    const full = await upstream.json();
    response.json({
      account_id: full.account_id,
      state: full.state,
      tokens: (full.tokens ?? [])
        .filter(token => token.balance && token.balance !== "0")
        .map(({ contract_id, balance }) => ({ contract_id, balance })),
      staking_pools: (full.pools ?? []).map(pool => pool.pool_id),
      source: `${network.fastnearApi}/v1/account/${account}/full`,
    });
  });
}

// onProtectedRequest hook, run before verification. Journals the payment
// identifier: a byte-identical retry of a settled payment is granted access and
// replayed; the same identifier on a different payment is a conflict; anything
// else proceeds to verify and settle.
async function journalPaymentIdentifier(context) {
  const request = context.adapter.req;
  if (request.method !== "POST" || request.path !== "/engagements" || !context.paymentHeader) return;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(context.paymentHeader, "base64").toString("utf8"));
  } catch {
    return; // Malformed payloads are the middleware's to reject.
  }
  const id = extractPaymentIdentifier(payload);
  if (!id) return;
  const fingerprint = payloadFingerprint(payload);
  const prior = Object.values(await store.all()).find(r => r.payment_id === id);
  request.engagementPayment = { id, fingerprint, prior: prior?.code };
  if (prior && prior.payment_fingerprint !== fingerprint) {
    request.engagementPayment.conflict = true;
    return { grantAccess: true };
  }
  if (prior && SETTLED.has(prior.status)) {
    request.engagementPayment.replay = true;
    return { grantAccess: true };
  }
}
