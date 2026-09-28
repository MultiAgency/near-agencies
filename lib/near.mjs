// NEAR reads and signed calls through @fastnear/api, with keys from the
// near-cli legacy keychain (~/.near-credentials/<network>/<account>.json).
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import * as near from "@fastnear/api";
import { signerFromPrivateKey } from "@fastnear/utils";

import { network, txLink } from "./network.mjs";

near.config({ networkId: network.networkId, nodeUrl: network.rpc });

export const USDC = network.usdc;
export const explorer = txLink;

export async function credential(accountId) {
  const path = join(homedir(), ".near-credentials", network.networkId, `${accountId}.json`);
  return JSON.parse(await readFile(path, "utf8"));
}

export function view(contractId, methodName, args = {}) {
  return near.view({ contractId, methodName, args });
}

export async function ftBalance(accountId, token = USDC) {
  return BigInt(await view(token, "ft_balance_of", { account_id: accountId }));
}

export function rpc(method, params) {
  return near.sendRpc(method, params).then(reply => reply.result);
}

/** Whether an RPC error means the account or key queried does not exist. */
export const isMissing = error => /does not exist/.test(`${error.message} ${JSON.stringify(error.data)}`);

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const isAccountId = id => typeof id === "string" && id.length >= 2 && id.length <= 64 && ACCOUNT_ID.test(id);

// Sign one FunctionCall with the account's keychain key and wait for FINAL.
// Returns the transaction hash and the decoded SuccessValue.
export async function call(signerId, contractId, methodName, args, { deposit = "0", gas = "100000000000000" } = {}) {
  const { private_key } = await credential(signerId);
  const reply = await near.sendTx({
    signerId,
    signer: signerFromPrivateKey(private_key),
    receiverId: contractId,
    actions: [near.actions.functionCall({ methodName, args, gas, deposit })],
    waitUntil: "FINAL",
  });
  const outcome = reply.result ?? reply;
  if (!("SuccessValue" in outcome.status)) {
    throw new Error(`${contractId}.${methodName} failed: ${JSON.stringify(outcome.status)}`);
  }
  const raw = Buffer.from(outcome.status.SuccessValue, "base64").toString();
  return { hash: outcome.transaction.hash, value: raw ? JSON.parse(raw) : null };
}
