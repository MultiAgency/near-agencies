// Delivery-idempotency check: send one signed x402 engagement payment, with a
// payment-identifier, twice and byte-identical, as a client retrying after a
// lost response would. Both attempts must return the same engagement, and
// exactly one engagement opens for the one deposit.
//
//   node scripts/replay-check.mjs <payer>
import { createNearX402Client } from "@fastnear/x402";
import { createLocalNearSigner } from "@fastnear/x402/node";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { appendPaymentIdentifierToExtensions } from "@x402/extensions/payment-identifier";

import { USDC, credential } from "../lib/near.mjs";
import { network } from "../lib/network.mjs";

const payer = process.argv[2];
if (!payer) {
  console.error("usage: node scripts/replay-check.mjs <payer>");
  process.exit(64);
}
const url = `${process.env.SERVER_URL ?? "http://127.0.0.1:4021"}/engagements`;
const body = JSON.stringify({ title: "Replay check", brief: "Delivery-idempotency check: one signed payment sent twice." });
const headers = { "content-type": "application/json" };

const challenge = await fetch(url, { method: "POST", headers, body });
const required = decodePaymentRequiredHeader(challenge.headers.get("PAYMENT-REQUIRED"));
const key = await credential(payer);
const amount = required.accepts[0].amount;
const client = createNearX402Client({
  network: network.caip2,
  signer: createLocalNearSigner({ accountId: payer, secretKey: key.private_key, rpcUrls: { [network.caip2]: network.rpc } }),
}).setSpendControls({ allowedAssets: [{ network: network.caip2, asset: USDC, maxAmountPerPayment: amount }] });
appendPaymentIdentifierToExtensions(required.extensions ?? (required.extensions = {}));
const signature = encodePaymentSignatureHeader(await client.createPaymentPayload(required));

const results = [];
for (const attempt of [1, 2]) {
  const response = await fetch(url, { method: "POST", headers: { ...headers, "PAYMENT-SIGNATURE": signature }, body });
  const text = await response.text();
  let quote;
  try {
    quote = JSON.parse(text);
  } catch {
    results.push({ attempt, http: response.status, error: text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) });
    continue;
  }
  const header = response.headers.get("PAYMENT-RESPONSE");
  const settlement = header ? decodePaymentResponseHeader(header) : {};
  const status = quote.status_url ? await fetch(new URL(quote.status_url, url)).then(r => r.json()) : {};
  results.push({ attempt, http: response.status, code: quote.code, replayed: Boolean(quote.replayed), transaction: settlement.transaction, issue: status.issue });
}
console.table(results);
const codes = new Set(results.map(r => r.code));
const issues = new Set(results.map(r => r.issue));
const ok = results.every(r => r.issue) && codes.size === 1 && issues.size === 1 && results[1].replayed;
console.log(ok ? `ok: both attempts returned engagement #${[...issues][0]} (${[...codes][0]})` : "FAIL: the retry did not replay the original engagement");
process.exit(ok ? 0 : 1);
