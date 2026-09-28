// Pay an x402 resource from a keychain account and verify the settlement
// independently of the facilitator.
import { createNearX402Client } from "@fastnear/x402";
import { createLocalNearSigner } from "@fastnear/x402/node";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { wrapFetchWithPayment } from "@x402/fetch";

import { USDC, credential, explorer, ftBalance, rpc } from "./near.mjs";
import { network as profile } from "./network.mjs";

const network = profile.caip2;
const rpcUrl = profile.rpc;
const relayer = process.env.RELAYER_ACCOUNT ?? "x402-relayer.agency.testnet";

/**
 * 1. Preflight: the payer key must be FullAccess (the facilitator rejects
 *    function-call keys; neither @fastnear/x402 nor @x402/near checks) and the
 *    payer must hold at least `amount`.
 * 2. Pay: the wrapped fetch answers the 402 with a signed NEP-366 delegate,
 *    refusing any requirement above `amount` (x402 spend controls; the $1
 *    default would block engagement deposits, and createNearPaymentFetch
 *    does not expose the setting).
 * 3. Verify: the relayer tx is FINAL with no failed receipt, and `payTo`
 *    received exactly `amount`.
 */
export async function payAndVerify({ payer, url, init, payTo, amount }) {
  const key = await credential(payer);
  const accessKey = await rpc("query", {
    request_type: "view_access_key",
    finality: "final",
    account_id: payer,
    public_key: key.public_key,
  });
  if (accessKey.permission !== "FullAccess") {
    throw new Error(`${key.public_key} is not a full-access key on ${payer}`);
  }
  const payerBalance = await ftBalance(payer);
  if (payerBalance < amount) {
    throw new Error(`${payer} holds ${payerBalance} atomic USDC, needs ${amount}`);
  }
  const payeeBefore = await ftBalance(payTo);

  const client = createNearX402Client({
    network,
    signer: createLocalNearSigner({ accountId: payer, secretKey: key.private_key, rpcUrls: { [network]: rpcUrl } }),
  }).setSpendControls({ allowedAssets: [{ network, asset: USDC, maxAmountPerPayment: String(amount) }] });
  const paidFetch = wrapFetchWithPayment(fetch, client);
  const response = await paidFetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`);
  const settlement = decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE"));

  const tx = await rpc("EXPERIMENTAL_tx_status", {
    tx_hash: settlement.transaction,
    sender_account_id: relayer,
    wait_until: "FINAL",
  });
  const failed = tx.receipts_outcome.filter(receipt => "Failure" in receipt.outcome.status);
  if (!("SuccessValue" in tx.status) || failed.length > 0) {
    throw new Error(`settlement tx did not fully succeed: ${JSON.stringify(failed.map(r => r.outcome.status))}`);
  }
  const received = (await ftBalance(payTo)) - payeeBefore;
  if (received !== amount) {
    throw new Error(`${payTo} received ${received}, expected ${amount}`);
  }
  return { body, settlement, received, link: explorer(settlement.transaction) };
}
