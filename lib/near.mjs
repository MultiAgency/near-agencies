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
  // A server holds its keys in the environment: the proposer's, which can only
  // file proposals (lib/payouts.mjs), and the registrar's, a small account that
  // pays members' USDC registrations (lib/onboarding.mjs).
  for (const role of ["PROPOSER", "REGISTRAR"]) {
    if (process.env[`${role}_KEY`] && accountId === process.env[`${role}_ACCOUNT`]) return { private_key: process.env[`${role}_KEY`] };
  }
  const path = join(homedir(), ".near-credentials", network.networkId, `${accountId}.json`);
  return JSON.parse(await readFile(path, "utf8"));
}

// NEAR reads fail after RPC_TIMEOUT_MS rather than wait forever. Signed calls
// (payout.mjs) are not bounded: abandoning one mid-flight could mean retrying
// a transaction that still lands.
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? "30000");
export function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function view(contractId, methodName, args = {}) {
  return withTimeout(near.view({ contractId, methodName, args }), RPC_TIMEOUT_MS, `NEAR view ${contractId}.${methodName}`);
}

export async function ftBalance(accountId, token = USDC) {
  return BigInt(await view(token, "ft_balance_of", { account_id: accountId }));
}

export function rpc(method, params) {
  return withTimeout(near.sendRpc(method, params), RPC_TIMEOUT_MS, `NEAR RPC ${method}`).then(reply => reply.result);
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
