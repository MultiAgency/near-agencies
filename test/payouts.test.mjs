import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { USDC } from "../lib/near.mjs";
import { filedProposal, payoutProblem, proposalDescription } from "../lib/payouts.mjs";

process.env.GITHUB_TOKEN ??= "test-token";

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

describe("a handoff's pull requests", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  // What pullRequest(url) reads, served by a mocked GitHub.
  const pull = (number, overrides = {}) => ({ number, user: { login: "multi-agency" }, merged: true, ...overrides });
  const serve = prs => {
    globalThis.fetch = async url => {
      const number = Number(/\/pulls\/(\d+)$/.exec(new URL(url).pathname)?.[1]);
      const found = prs.find(p => p.number === number);
      return found ? new Response(JSON.stringify(found)) : new Response("{}", { status: 404 });
    };
  };
  const codeTask = (links, claimedBy = ["multi-agency"]) =>
    member(29, {
      claimedBy,
      skills: ["skill:code"],
      payee: "agent.agency.testnet",
      handoff: { payout: { account_id: "agent.agency.testnet" }, links },
    });
  const right = "https://github.com/MultiAgency/near-agencies/pull/50";

  test("counts a merged pull request from the task's repository by its claimant", async () => {
    serve([pull(50)]);
    assert.equal(await payoutProblem({ members: [codeTask([right])] }), null);
  });

  test("holds a code task whose handoff links no pull request", async () => {
    serve([pull(50)]);
    assert.match(
      await payoutProblem({ members: [codeTask(["https://github.com/MultiAgency/kanban-sandbox/issues/29#issuecomment-555"])] }),
      /#29's handoff links no pull request/,
    );
  });

  test("reads a pull request link that carries trailing path", async () => {
    serve([pull(50)]);
    assert.match(
      await payoutProblem({ members: [codeTask(["https://github.com/someone/elsewhere/pull/9/files"])] }),
      /#29's pull request .* is in another repository/,
    );
  });

  test("holds a pull request by an assignee the handoff does not pay", async () => {
    serve([pull(50, { user: { login: "offroster" } })]);
    assert.match(
      await payoutProblem({ members: [codeTask([right], ["offroster", "multi-agency"])] }),
      /by @offroster, not the claimant/,
    );
  });

  test("counts the passing pull request among links a code task cites", async () => {
    serve([pull(50)]);
    assert.equal(await payoutProblem({ members: [codeTask(["https://github.com/someone/elsewhere/pull/9", right])] }), null);
  });

  test("a pull request another task kind cites does not gate its payout", async () => {
    serve([pull(50)]);
    const cited = member(29, { handoff: { payout: { account_id: "near-builder.testnet" }, links: ["https://github.com/someone/elsewhere/pull/9"] } });
    assert.equal(await payoutProblem({ members: [cited] }), null);
  });

  test("holds a pull request from another repository", async () => {
    serve([pull(50)]);
    assert.match(
      await payoutProblem({ members: [codeTask(["https://github.com/someone/elsewhere/pull/9"])] }),
      /#29's pull request .* is in another repository/,
    );
  });

  test("holds a pull request by someone other than the claimant", async () => {
    serve([pull(50, { user: { login: "stranger" } })]);
    assert.match(await payoutProblem({ members: [codeTask([right])] }), /by @stranger, not the claimant/);
  });

  test("holds a pull request that is not merged", async () => {
    serve([pull(50, { merged: false })]);
    assert.match(await payoutProblem({ members: [codeTask([right])] }), /#29's pull request .* is not merged yet/);
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
