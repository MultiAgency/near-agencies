import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { USDC } from "../lib/near.mjs";
import { filedProposal, payoutProblem, proposalDescription } from "../lib/payouts.mjs";

const member = (issue, overrides = {}) => ({
  issue,
  title: `Task ${issue}`,
  url: `https://github.com/MultiAgency/kanban-sandbox/issues/${issue}`,
  payee: "near-builder.testnet",
  amount: "1000000",
  state: "closed",
  handoff: { payout: { account_id: "near-builder.testnet" } },
  ...overrides,
});
const proposal = (id, m, overrides = {}) => ({
  id,
  status: "InProgress",
  description: proposalDescription(28, m),
  kind: { Transfer: { token_id: USDC, receiver_id: m.payee, amount: m.amount, msg: null } },
  ...overrides,
});

describe("payout proposals", () => {
  test("finds a task's live proposal by task, payee, amount and token", () => {
    const research = member(29);
    const writing = member(30);
    const recent = [proposal(40, research), proposal(41, writing)];
    assert.equal(filedProposal(recent, research).id, 40);
    assert.equal(filedProposal(recent, writing).id, 41);
  });

  test("never reuses a dead proposal or one that pays something else", () => {
    const m = member(29);
    for (const status of ["Rejected", "Failed", "Expired", "Removed"]) {
      assert.equal(filedProposal([proposal(40, m, { status })], m), null, status);
    }
    assert.equal(filedProposal([proposal(40, { ...m, amount: "500000" })], m), null);
    assert.equal(filedProposal([proposal(40, { ...m, payee: "someone.testnet" })], m), null);
    assert.equal(filedProposal([proposal(40, m, { kind: { Transfer: { token_id: "other.testnet", receiver_id: m.payee, amount: m.amount } } })], m), null);
    assert.equal(filedProposal([proposal(40, m, { description: "not json" })], m), null);
    assert.equal(filedProposal([proposal(40, m, { kind: { FunctionCall: {} } })], m), null);
  });

  test("an approved proposal still counts as filed", () => {
    const m = member(29);
    assert.equal(filedProposal([proposal(40, m, { status: "Approved" })], m).id, 40);
  });

  test("holds payouts until every task has closed with a handoff to its payee", async () => {
    assert.match(await payoutProblem({ members: [] }), /no team/);
    assert.match(await payoutProblem({ members: [member(29), member(30, { state: "open" })] }), /#30 has not closed with a handoff/);
    assert.match(await payoutProblem({ members: [member(29, { handoff: null }), member(30, { handoff: null })] }), /#29, #30 have not/);
    assert.match(await payoutProblem({ members: [member(29, { payee: null })] }), /no roster payout account for the claimant of #29/);
    assert.match(await payoutProblem({ members: [member(29, { handoff: { payout: { account_id: "other.testnet" } } })] }), /differs from the payee on #29/);
    assert.equal(await payoutProblem({ members: [member(29), member(30)] }), null);
  });
});

describe("reading a payout proposal", async () => {
  const { proposalState } = await import("../lib/engagement-state.mjs");
  // The RPC error for a removed proposal, as testnet returns it.
  const panic = code => async () => {
    throw new Error(`{"name":"contract_error","message":"wasm execution failed with error: HostError(GuestPanic { panic_msg: \\"panicked at '${code}', sputnikdao2/src/views.rs:102:48\\" })"}`);
  };

  test("a removed proposal reads as Removed instead of failing the job", async () => {
    assert.deepEqual(await proposalState("dao.testnet", 43, panic("ERR_NO_PROPOSAL")), { status: "Removed" });
  });

  test("any other failure still fails, so a slow RPC is never mistaken for a removal", async () => {
    await assert.rejects(proposalState("dao.testnet", 43, async () => { throw new Error("NEAR view timed out"); }), /timed out/);
  });

  test("a live proposal is returned as the treasury has it", async () => {
    assert.deepEqual(await proposalState("dao.testnet", 7, async () => ({ id: 7, status: "InProgress" })), { id: 7, status: "InProgress" });
  });
});
