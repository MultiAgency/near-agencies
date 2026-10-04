// Engagement intake. An organization submits a brief and pays a USDC deposit
// into the MultiAgency treasury from its own wallet (or its own Trezu
// treasury): POST /api/quotes returns a code, the org transfers USDC with the
// code in the memo, and a watcher opens the engagement once the transfer is
// final. The deposit is the buyer's choice within the range the server
// configures, or the server's default when the brief names no amount.
// Software clients can pay over x402 instead (lib/x402-intake.mjs).
//
// Either way the engagement opens only after the deposit is on chain, as an
// epic issue that becomes the source of truth.
import { randomBytes } from "node:crypto";

import { rateLimit } from "express-rate-limit";

import { createEpic } from "./epic.mjs";
import { findDeposit, finalBlockHeight } from "./history.mjs";
import { ftBalance, isAccountId, isMissing, rpc } from "./near.mjs";
import { network, txLink } from "./network.mjs";
import { recoverStuck } from "./recover.mjs";
import { serialized } from "./serialize.mjs";
import * as store from "./store.mjs";
import { gaveUp } from "./stuck.mjs";

const QUOTE_TTL_MS = 72 * 3600 * 1000;
const WATCH_INTERVAL_MS = 15_000;
const OPEN_QUOTES_MAX = 200;

// Quotes are free to create but each one is scanned until it expires, so
// creation is limited per client and in total. Payer checks cost RPC calls.
const quoteLimit = rateLimit({ windowMs: 3600_000, limit: 5, message: { error: "Too many quotes from this address. Try again in an hour." } });
const payerLimit = rateLimit({ windowMs: 600_000, limit: 30, message: { error: "Too many checks from this address. Try again in a few minutes." } });

export function mountEngagements(app, { deposit, depositMin = deposit, depositMax = deposit }) {
  app.post("/api/quotes", quoteLimit, async (request, response) => {
    const awaiting = Object.values(await store.all()).filter(r => r.status === "awaiting_deposit").length;
    if (awaiting >= OPEN_QUOTES_MAX) {
      return response.status(503).json({ error: "Too many quotes are waiting for deposits. Try again later." });
    }
    const error = invalidBrief(request.body);
    if (error) return response.status(400).json({ error });
    const chosen = chosenDeposit(request.body, { deposit, depositMin, depositMax });
    if (chosen.problem) return response.status(400).json({ error: chosen.problem });
    response.status(201).json(await createQuote({ ...request.body, channel: "wallet", amount: chosen.amount }));
  });

  app.get("/api/quotes/:code", async (request, response) => {
    const record = await store.get(request.params.code);
    if (!record) return response.status(404).json({ error: "There is no quote with this code." });
    response.json(publicQuote(record));
  });

  // Checked before a wallet signs, so an account that cannot pay hears why
  // from us instead of from a failed transaction.
  app.get("/api/quotes/:code/payer/:account", payerLimit, async (request, response) => {
    const record = await store.get(request.params.code);
    if (!record) return response.status(404).json({ error: "There is no quote with this code." });
    const { account } = request.params;
    if (!isAccountId(account)) return response.status(400).json({ error: "invalid NEAR account id" });
    response.json({ account, problems: payerProblems(await payerState(account), record.amount) });
  });

  // One scan at a time: a slow one must not be joined by the next tick's. Each
  // tick also finishes engagements that paid but never got an epic.
  const watch = serialized(async () => {
    try {
      await watchWalletDeposits();
    } finally {
      await recoverStuck().catch(e => console.error(`recovery: ${e.message}`));
    }
  });
  setInterval(() => watch().catch(e => console.error(`deposit watcher: ${e.message}`)), WATCH_INTERVAL_MS);
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
  const { code, title, amount, channel, status, expires_at, deposit, issue, issue_url } = record;
  const abandoned = status === "deposit_settled_epic_failed" && gaveUp(record);
  return {
    code,
    title,
    status,
    channel,
    expires_at,
    payment: { network: network.networkId, token: network.usdc, receiver: network.treasury, amount, memo: code },
    ...(deposit ? { deposit: { ...deposit, link: txLink(deposit.transaction) } } : {}),
    ...(issue ? { issue, issue_url } : {}),
    // record.error holds GitHub's response text; it stays in the store, not in the response.
    ...(status === "deposit_settled_epic_failed" ? { error: "The deposit is settled; the job is being opened." } : {}),
    ...(abandoned ? { gave_up: true } : {}),
  };
}

const STORAGE_PRICE_PER_BYTE = 10n ** 19n;
// A testnet wallet reserved 0.031 NEAR of gas for the deposit transfer.
const GAS_RESERVE = 5n * 10n ** 22n;

async function payerState(account) {
  let state;
  try {
    state = await rpc("query", { request_type: "view_account", finality: "final", account_id: account });
  } catch (error) {
    if (isMissing(error)) return { exists: false };
    throw error;
  }
  return {
    exists: true,
    available: BigInt(state.amount) - BigInt(state.storage_usage) * STORAGE_PRICE_PER_BYTE,
    usdc: await ftBalance(account),
  };
}

export function payerProblems({ exists, available, usdc }, amount) {
  if (!exists) return [`the account does not exist on ${network.networkId}`];
  const problems = [];
  if (available < GAS_RESERVE) problems.push(`it needs at least ${formatUnits(GAS_RESERVE, 24)} NEAR for gas and has ${formatUnits(available, 24)} NEAR available`);
  if (usdc < BigInt(amount)) problems.push(`it needs ${formatUnits(amount, 6)} USDC and holds ${formatUnits(usdc, 6)} USDC`);
  return problems;
}

const formatUnits = (value, decimals) => (Number(BigInt(value) * 1000n / 10n ** BigInt(decimals)) / 1000).toString();

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
    return Object.assign(r, { status: "opening", opening_at: new Date().toISOString(), deposit });
  });
  if (!record) return;
  try {
    const epic = await createEpic(record);
    await store.update(records => Object.assign(records[code], { status: "open", issue: epic.number, issue_url: epic.html_url, brief: undefined }));
    console.log(`${code}: opened ${epic.html_url}`);
  } catch (error) {
    // The deposit is final but no epic exists; lib/recover.mjs retries it later.
    await store.update(records => Object.assign(records[code], { status: "deposit_settled_epic_failed", error: error.message, failed_at: new Date().toISOString() }));
    console.error(`${code}: deposit settled, epic creation failed: ${error.message}`);
  }
}

export function invalidBrief(body) {
  const { title, brief } = body ?? {};
  if (typeof title !== "string" || title.trim().length < 4 || title.length > 120) return "title must be 4-120 characters";
  if (typeof brief !== "string" || brief.trim().length < 20 || brief.length > 8000) return "brief must be 20-8000 characters";
  return null;
}

/**
 * The deposit a quote takes: the buyer's choice when their brief names an
 * `amount` (USDC base units), within the range the server configures; the
 * server's default otherwise. `problem` says why a choice cannot be taken.
 * The payer check and the deposit watcher read the chosen amount off the
 * quote's record, so nothing downstream needs to know it was chosen.
 */
export function chosenDeposit(body, { deposit, depositMin, depositMax }) {
  const choice = body?.amount;
  if (choice === undefined || choice === null || choice === "") return { amount: deposit };
  if (!/^(?:0|[1-9]\d*)$/.test(String(choice))) return { problem: "amount must be a whole number of USDC base units" };
  if (BigInt(choice) < BigInt(depositMin)) return { problem: `the deposit must be at least ${formatUnits(depositMin, 6)} USDC` };
  if (BigInt(choice) > BigInt(depositMax)) return { problem: `the deposit must be at most ${formatUnits(depositMax, 6)} USDC` };
  return { amount: BigInt(choice).toString() };
}
