import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { ftTransfers, functionCalls } from "../lib/history.mjs";

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

describe("deposit discovery", () => {
  const deposit = fixture("testnet-memo-deposit.json");

  test("finds the USDC transfer into the treasury with its memo code", () => {
    assert.deepEqual(ftTransfers(deposit, USDC), [{
      old_owner_id: "agency.testnet",
      new_owner_id: "multiagency.sputnikv2.testnet",
      amount: "3000000",
      memo: "ma-3d1d8b8107",
      receipt_id: deposit.receipts[0].receipt.receipt_id,
    }]);
  });

  test("ignores other tokens and failed receipts", () => {
    assert.deepEqual(ftTransfers(deposit, "wrap.testnet"), []);
    const failed = structuredClone(deposit);
    for (const r of failed.receipts) r.execution_outcome.outcome.status = { Failure: {} };
    assert.deepEqual(ftTransfers(failed, USDC), []);
  });
});

describe("approval discovery", () => {
  test("attributes a Trezu-relayed vote to the member who signed it, not the relayer", () => {
    const vote = fixture("mainnet-trezu-vote.json");
    assert.equal(vote.transaction.signer_id, "sponsor.trezu.near");
    const [call] = functionCalls(vote);
    assert.equal(call.sender, "agenticweb.near");
    assert.equal(call.receiver, "multiagency.sputnik-dao.near");
    assert.equal(call.method, "act_proposal");
    assert.equal(call.args.id, 47);
    assert.equal(call.args.action, "VoteApprove");
  });
});
