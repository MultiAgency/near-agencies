// Engagement intake. An organization submits a brief and pays a USDC deposit
// into the MultiAgency treasury from its own wallet (or its own Trezu
// treasury): POST /api/quotes returns a code, the org transfers USDC with the
// code in the memo, and a watcher opens the engagement once the transfer is
// final. Software clients can pay over x402 instead (lib/x402-intake.mjs).
//
// Either way the engagement opens only after the deposit is on chain, as an
// epic issue that becomes the source of truth.
import { randomBytes } from "node:crypto";

import { fence, github } from "./github.mjs";
import { findDeposit, finalBlockHeight } from "./history.mjs";
import { network, txLink } from "./network.mjs";
import * as store from "./store.mjs";

const QUOTE_TTL_MS = 72 * 3600 * 1000;
const WATCH_INTERVAL_MS = 15_000;
const QUOTES_PER_HOUR = 5;
const OPEN_QUOTES_MAX = 200;

// Quotes are free to create but each one is scanned until it expires, so
// creation is limited per client and in total.
const recentQuotes = new Map();
function quoteLimitReached(client) {
  const cutoff = Date.now() - 3600_000;
  const recent = (recentQuotes.get(client) ?? []).filter(t => t > cutoff);
  if (recent.length >= QUOTES_PER_HOUR) return true;
  recentQuotes.set(client, [...recent, Date.now()]);
  return false;
}

export function mountEngagements(app, { deposit }) {
  app.post("/api/quotes", async (request, response) => {
    if (quoteLimitReached(request.ip)) {
      return response.status(429).json({ error: "Too many quotes from this address. Try again in an hour." });
    }
    const awaiting = Object.values(await store.all()).filter(r => r.status === "awaiting_deposit").length;
    if (awaiting >= OPEN_QUOTES_MAX) {
      return response.status(503).json({ error: "Too many quotes are waiting for deposits. Try again later." });
    }
    const error = invalidBrief(request.body);
    if (error) return response.status(400).json({ error });
    response.status(201).json(await createQuote({ ...request.body, channel: "wallet", amount: deposit }));
  });

  app.get("/api/quotes/:code", async (request, response) => {
    const record = await store.get(request.params.code);
    if (!record) return response.status(404).json({ error: "unknown engagement code" });
    response.json(publicQuote(record));
  });

  setInterval(() => watchWalletDeposits().catch(e => console.error(`deposit watcher: ${e.message}`)), WATCH_INTERVAL_MS);
}

export async function createQuote({ title, brief, channel, amount, payment }) {
  const code = `ma-${randomBytes(5).toString("hex")}`;
  const record = {
    code,
    title,
    brief,
    channel,
    amount,
    status: "awaiting_deposit",
    since_block: await finalBlockHeight(),
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    ...(payment ? { payment_id: payment.id, payment_fingerprint: payment.fingerprint } : {}),
  };
  await store.update(records => { records[code] = record; });
  return publicQuote(record);
}

export function publicQuote(record) {
  const { code, title, amount, channel, status, expires_at, deposit, issue, issue_url, error } = record;
  return {
    code,
    title,
    status,
    channel,
    expires_at,
    payment: { network: network.networkId, token: network.usdc, receiver: network.treasury, amount, memo: code },
    ...(deposit ? { deposit: { ...deposit, link: txLink(deposit.transaction) } } : {}),
    ...(issue ? { issue, issue_url } : {}),
    ...(error ? { error } : {}),
  };
}

async function watchWalletDeposits() {
  const now = Date.now();
  for (const record of Object.values(await store.all())) {
    if (record.status !== "awaiting_deposit") continue;
    // x402 records that never settled expire too; only wallet quotes are scanned.
    if (Date.parse(record.expires_at) < now) {
      await store.update(records => { records[record.code].status = "expired"; });
      continue;
    }
    if (record.channel !== "wallet") continue;
    const deposit = await findDeposit(record.code, record.since_block);
    if (!deposit) continue;
    if (BigInt(deposit.amount) < BigInt(record.amount)) {
      await store.update(records => Object.assign(records[record.code], { status: "underpaid", deposit }));
      console.error(`${record.code}: deposit ${deposit.amount} below quote ${record.amount}; not opened`);
      continue;
    }
    await openEngagement(record.code, deposit);
  }
}

// Claim the record, then create the epic. Idempotent per code.
export async function openEngagement(code, deposit) {
  const record = await store.update(records => {
    const r = records[code];
    if (!r || r.status !== "awaiting_deposit") return null;
    return Object.assign(r, { status: "opening", deposit });
  });
  if (!record) return;
  const engagement = {
    engagement_id: code,
    channel: record.channel,
    org: deposit.org,
    deposit: { amount: deposit.amount, asset: network.usdc, treasury: network.treasury, transaction: deposit.transaction, network: network.networkId },
  };
  try {
    const epic = await github("POST", "/issues", {
      title: `Engagement: ${record.title}`,
      labels: ["engagement"],
      body: [
        `**Engagement** opened by \`${deposit.org}\` with a ${Number(deposit.amount) / 1e6} USDC deposit to \`${network.treasury}\` ([transaction](${txLink(deposit.transaction)})).`,
        "",
        record.brief,
        "",
        fence("engagement", engagement),
      ].join("\n"),
    });
    await store.update(records => Object.assign(records[code], { status: "open", issue: epic.number, issue_url: epic.html_url, brief: undefined }));
    console.log(`${code}: opened ${epic.html_url}`);
  } catch (error) {
    // The deposit is final but no epic exists; an operator must open it by hand.
    await store.update(records => Object.assign(records[code], { status: "deposit_settled_epic_failed", error: error.message }));
    console.error(`${code}: deposit settled, epic creation failed: ${error.message}`);
  }
}

export function invalidBrief(body) {
  const { title, brief } = body ?? {};
  if (typeof title !== "string" || title.trim().length < 4 || title.length > 120) return "title must be 4-120 characters";
  if (typeof brief !== "string" || brief.trim().length < 20 || brief.length > 8000) return "brief must be 20-8000 characters";
  return null;
}
