import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { USDC } from "../lib/near.mjs";
import { AUDIT_PAGE_CAP, closeIfPaid, duplicatePayoutProblem, filedProposal, payoutAuditCapped, pendingPayouts, payoutProblem, proposalDescription, proposePayouts, recordApprovals } from "../lib/payouts.mjs";
import { digest, fence } from "../lib/github.mjs";

process.env.GITHUB_TOKEN ??= "test-token";
// The sweep's proposing gate (lib/coordinator.mjs) reads this; without a
// proposer it skips the checks the volunteer-edit test below is about.
process.env.PROPOSER_ACCOUNT ??= "proposer.testnet";
// payout.mjs runs in-process below (the terminal approve's refusal) and
// refuses to start without the board bot's login spelled out.
process.env.BOARD_BOT ??= "multi-agency";

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
// A member as pendingPayouts reads it: the payout recorded on its task, with
// the proposal's live state beside it.
const recorded = (issue, overrides = {}, status = "InProgress") => {
  const m = member(issue, overrides);
  return {
    ...m,
    payout: { proposal_id: 40, treasury: "multiagency.sputnikv2.testnet", payee: m.payee, amount: m.amount, status },
    proposal: { proposer: "proposer.testnet", kind: { Transfer: { token_id: USDC, receiver_id: m.payee, amount: m.amount, msg: null } } },
  };
};

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

  test("a volunteer task gates on its work, never on who would be paid", async () => {
    const volunteer = overrides => member(31, { amount: "0", ...overrides });
    assert.equal(await payoutProblem({ members: [volunteer()] }), null);
    assert.equal(await payoutProblem({ members: [volunteer({ payee: null })] }), null, "a volunteer need not be paid to an account");
    assert.equal(await payoutProblem({ members: [volunteer({ handoff: { payout: { account_id: "other.testnet" } } })] }), null);
    assert.equal(await payoutProblem({ members: [volunteer({ skills: ["skill:code"], handoff: { payout: { account_id: "near-builder.testnet" }, links: [] } })] }),
      null, "a volunteer code task owes no merged pull request to the treasury");
    assert.match(await payoutProblem({ members: [volunteer({ state: "open" })] }), /not closed with a handoff/,
      "whatever the payout, the work itself still gates");
    assert.match(await payoutProblem({ members: [volunteer({ handoff: null })] }), /not closed with a handoff/);
    assert.match(await payoutProblem({ members: [member(29, { payee: null }), volunteer()] }),
      /no roster payout account for the claimant of #29/, "a volunteer beside it changes nothing for a paid task");
  });
});

describe("a duplicated payout proposal", () => {
  const approvers = ["approver.testnet"];

  test("two matching live proposals hold the job's approval, naming the extra", async () => {
    const m = recorded(29);
    const { pending, problem } = await pendingPayouts({ members: [m] }, approvers, [proposal(40, m), proposal(41, m)]);
    assert.equal(pending.length, 1, "the recorded proposal is still what an approver would vote on");
    assert.match(problem, /#29/);
    assert.match(problem, /\b40\b/, "both duplicates are named");
    assert.match(problem, /\b41\b/, "both duplicates are named");
    assert.match(problem, /reject 41/, "the proposal the payout is not recorded with is the extra one");
  });

  test("an approved duplicate becomes the payment and the recorded proposal the rejection", async () => {
    const m = recorded(29);
    const { pending, problem } = await pendingPayouts({ members: [m] }, approvers, [proposal(40, m), proposal(41, m, { status: "Approved" })]);
    assert.match(problem, /\b41\b.*approved/, "the approved duplicate is named as the payment");
    assert.match(problem, /reject 40/, "the recorded proposal is the one an approver must now reject");
    assert.equal(pending.length, 1, "the recorded proposal is still votable, for its rejection");
  });

  test("a recorded proposal approved beside its live duplicate still holds the panel", async () => {
    const m = recorded(29, {}, "Approved");
    const { pending, problem } = await pendingPayouts({ members: [m] }, approvers, [proposal(40, m, { status: "Approved" }), proposal(41, m)]);
    assert.equal(pending.length, 0, "the approved proposal no longer waits for a vote");
    assert.match(problem, /#29/, "the duplicate holds the panel whatever the recorded proposal's status");
    assert.match(problem, /reject 41/);
  });

  test("a dead recorded proposal makes a live one the payment to approve", async () => {
    const m = recorded(29, {}, "Expired");
    const { pending, problem } = await pendingPayouts({ members: [m] }, approvers, [proposal(40, m, { status: "Expired" }), proposal(41, m), proposal(42, m)]);
    assert.equal(pending.length, 0, "a dead recorded proposal waits for no vote");
    assert.match(problem, /\b40\b/, "the dead recorded proposal is named");
    assert.match(problem, /approve 41/, "a live proposal is what an approver is told to approve");
    assert.match(problem, /reject 42/);
    assert.doesNotMatch(problem, /approve 40\b/, "the dead proposal is not the payment the advice names");
  });

  test("one live proposal behaves as today", async () => {
    const m = recorded(29);
    const { problem } = await pendingPayouts({ members: [m] }, approvers, [proposal(40, m)]);
    assert.equal(problem, null);
  });

  test("a dead second proposal is no duplicate", async () => {
    const m = recorded(29);
    const { problem } = await pendingPayouts({ members: [m] }, approvers, [proposal(40, m), proposal(41, m, { status: "Rejected" })]);
    assert.equal(problem, null);
  });

  test("a live proposal for another task is no duplicate", async () => {
    const m = recorded(29);
    const { problem } = await pendingPayouts({ members: [m] }, approvers, [proposal(40, m), proposal(41, member(30))]);
    assert.equal(problem, null);
  });

  // The refusal payout.mjs approve votes by: a real duplicate refuses, a
  // payout that stands alone does not.
  test("the approve refusal keys to a duplicate, not to any payout", async () => {
    const m = recorded(29);
    assert.equal(await duplicatePayoutProblem({ members: [m] }, [proposal(40, m)]), null);
    assert.equal(await duplicatePayoutProblem({ members: [] }, [proposal(40, m), proposal(41, m)]), null, "a team without recorded payouts is never refused");
    assert.match(await duplicatePayoutProblem({ members: [m] }, [proposal(40, m), proposal(41, m)]), /reject 41/);
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
  const codeTask = (links, claimedBy = ["multi-agency"], repo) =>
    member(29, {
      claimedBy,
      skills: ["skill:code"],
      payee: "agent.agency.testnet",
      ...(repo ? { repo } : {}),
      handoff: { payout: { account_id: "agent.agency.testnet" }, links },
    });
  const right = "https://github.com/MultiAgency/near-agencies/pull/50";
  const social = "https://github.com/MultiAgency/legion-social/pull/9";

  test("counts a merged pull request from the task's repository by its claimant", async () => {
    serve([pull(50)]);
    assert.equal(await payoutProblem({ members: [codeTask([right])] }), null);
  });

  test("counts a merged pull request in the repository the task's terms name", async () => {
    serve([pull(9)]);
    assert.equal(await payoutProblem({ members: [codeTask([social], ["multi-agency"], "MultiAgency/legion-social")] }), null);
    assert.match(
      await payoutProblem({ members: [codeTask([right], ["multi-agency"], "MultiAgency/legion-social")] }),
      /is in another repository; the pull request must be in MultiAgency\/legion-social\./,
      "near-agencies is not the repository a legion-social task delivers to",
    );
  });

  test("holds a task whose terms name a repository outside the registry", async () => {
    serve([pull(50)]);
    assert.match(
      await payoutProblem({ members: [codeTask([right], ["multi-agency"], "octocat/hello-world")] }),
      /#29's terms name a repository code tasks do not deliver against/,
    );
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

  test("a proposed payout stands after its claimant leaves the roster", async () => {
    serve([pull(50)]);
    const proposed = member(29, {
      payee: "agent.agency.testnet",
      skills: ["skill:code"],
      claimedBy: ["gone-builder"],
      payout: { proposal_id: 40, treasury: "treasury.testnet", payee: "agent.agency.testnet", amount: "1000000", status: "InProgress" },
      handoff: { payout: { account_id: "agent.agency.testnet" }, links: [right] },
    });
    assert.equal(await payoutProblem({ members: [proposed, codeTask([right])] }), null);
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

// A mocked board and treasury, enough for the payout sweep's whole path over
// one job: GitHub through api.github.com, the chain through the RPC host.
describe("filing proposals and closing a job", async () => {
  const { coordinatorHealth, settlePayouts } = await import("../lib/coordinator.mjs");
  const { loadEngagement } = await import("../lib/engagement-state.mjs");
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const rpcValue = value => new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { result: [...new TextEncoder().encode(JSON.stringify(value))] },
  }), { headers: { "content-type": "application/json" } });

  // Serves `issues` by number (PATCHes apply, so a close is visible to settle),
  // `threads` by issue number (and single comments within them, by id, as
  // commentAt reads a deliverable), pull requests from `pulls`, open `jobs`
  // for the sweep's listing, and the treasury's reads from `proposals` —
  // windowed as the chain reads them: `get_proposals` carries `from_index`
  // and `limit` in its contract args, and returns ids from `from_index` up —
  // one proposal from `proposal`, and the indexed vote transactions in `txs`.
  // `lastId` is the treasury's proposal counter, which may sit far above the
  // proposals a job's audit must still see.
  const serve = ({ issues = {}, threads = {}, proposals = [], jobs = [], proposal = null, txs = [], pulls = {}, lastId = null } = {}) => {
    const reads = [];
    const writes = [];
    globalThis.fetch = async (url, options = {}) => {
      const u = new URL(url);
      const method = options.method ?? "GET";
      const json = body => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (u.hostname !== "api.github.com") {
        reads.push(u.hostname);
        const body = JSON.parse(options.body);
        const args = JSON.parse(Buffer.from(body.params?.args_base64 ?? "", "base64").toString() || "{}");
        if (body.params?.method_name === "get_last_proposal_id") return rpcValue(lastId ?? proposals.at(-1)?.id ?? 41);
        if (body.params?.method_name === "get_proposals") {
          const from = args.from_index ?? 0;
          return rpcValue(proposals.filter(p => p.id >= from && p.id < from + args.limit));
        }
        if (body.params?.method_name === "get_proposal") return rpcValue(proposal);
        if (u.pathname === "/v0/account") return json({ account_txs: txs.map(t => ({ transaction_hash: t.transaction.hash })) });
        if (u.pathname === "/v0/transactions") return json({ transactions: txs });
        throw new Error(`unexpected rpc: ${body.method} ${body.params?.method_name ?? body.params?.request_type}`);
      }
      let m;
      if (method === "GET" && u.pathname === "/user") return json({ login: "multi-agency" });
      if (method === "GET" && u.pathname.endsWith("/issues") && u.searchParams.get("labels") === "engagement" && u.searchParams.get("state") === "open") return json(jobs);
      if (method === "GET" && /\/collaborators\/[^/]+\/permission$/.test(u.pathname)) return json({ role_name: "admin" });
      if ((m = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(u.pathname)) && method === "GET") {
        const found = pulls[Number(m[1])];
        if (!found) throw new Error(`unexpected pull read: ${u.pathname}`);
        return json({ number: Number(m[1]), user: { login: "multi-agency" }, merged: true, ...found });
      }
      if ((m = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(u.pathname)) && method === "GET") {
        const found = Object.values(threads).flat().find(c => c.id === Number(m[1]));
        if (!found) throw new Error(`unexpected comment read: ${u.pathname}`);
        return json(found);
      }
      if ((m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(u.pathname))) {
        const issue = issues[Number(m[1])];
        if (!issue) throw new Error(`unexpected ${method} ${u.pathname}`);
        if (method === "GET") return json(issue);
        Object.assign(issue, JSON.parse(options.body));
        writes.push({ path: u.pathname, body: JSON.parse(options.body) });
        return json(issue);
      }
      if ((m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments/.exec(u.pathname))) {
        const thread = threads[Number(m[1])] ?? [];
        if (method === "GET") return json(thread);
        const posted = { id: 900 + thread.length, user: { login: "multi-agency" }, ...JSON.parse(options.body) };
        thread.push(posted);
        writes.push({ path: u.pathname, body: JSON.parse(options.body) });
        return json(posted);
      }
      throw new Error(`unexpected request: ${method} ${u.pathname}${u.search}`);
    };
    return { reads, writes };
  };

  const terms = (issue, amount) => ({ issue, engagement: 28, key: `task-${issue}`, amount, asset: USDC });
  // A task that closed with its handoff: delivered, whatever its payout.
  const closed = issue => ({
    number: issue,
    state: "closed",
    labels: [],
    assignees: [{ login: "multi-agency" }],
    html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/${issue}`,
  });
  // A member as the payout sweep reads it (loadEngagement's shape).
  const shaped = (issue, amount, overrides = {}) => ({
    issue,
    title: `Task ${issue}`,
    url: closed(issue).html_url,
    payee: "agent.agency.testnet",
    amount,
    ...overrides,
  });
  const handoff = (issue, pins = {}) => ({
    id: issue,
    user: { login: "multi-agency" },
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/${issue}#issuecomment-${issue}`,
    body: `**Handoff:** done\n\n${fence("handoff", { payout: { account_id: "agent.agency.testnet" }, ...pins })}`,
  });
  const epic = (members, overrides = {}) => ({
    number: 28,
    title: "Job: Write the guide",
    state: "open",
    user: { login: "multi-agency" },
    labels: [{ name: "blocked" }, { name: "engagement" }],
    html_url: "https://github.com/MultiAgency/kanban-sandbox/issues/28",
    body: [
      "**Job** opened by `acme.testnet`.",
      "",
      fence("engagement", { engagement_id: "ma-x", org: "acme.testnet", deposit: { amount: "3000000", asset: USDC, treasury: "multiagency.sputnikv2.testnet", transaction: "tx", network: "testnet" } }),
      "",
      "## Team",
      "",
      ...members.map(m => `- [ ] #${m.issue} — ${Number(m.amount) ? `${Number(m.amount) / 1e6} USDC` : "volunteer"}`),
      "",
      fence("team", {
        committed: members.reduce((sum, m) => sum + BigInt(m.amount), 0n).toString(),
        members,
      }),
    ].join("\n"),
    ...overrides,
  });
  const board = (members, { records = {} } = {}) => {
    const issues = { 28: epic(members) };
    const threads = {};
    for (const m of members) {
      issues[m.issue] = { ...closed(m.issue, m.amount), ...records[m.issue] };
      threads[m.issue] = [handoff(m.issue), ...(records[m.issue]?.thread ?? [])];
    }
    return { issues, threads };
  };

  test("a job with only volunteer tasks closes with no proposals and no payouts", async () => {
    const members = [shaped(29, "0")];
    const { reads, writes } = serve(board([terms(29, "0")]));
    await proposePayouts({ members }, "unused.testnet", () => {});
    assert.equal(reads.length, 0, "the treasury is not read for volunteers");
    assert.equal(writes.length, 0, "no proposal is filed for a volunteer task");
    await closeIfPaid(28, () => {});
    const complete = writes.filter(w => w.path.endsWith("/issues/28/comments"));
    assert.equal(complete.length, 1);
    assert.match(complete[0].body.body, /^\*\*Job complete\.\*\* 0 payouts executed/);
    const patches = writes.filter(w => w.path.endsWith("/issues/28"));
    assert.equal(patches.length, 2, "the job closes, then settles");
    assert.equal(patches[0].body.state, "closed");
    assert.equal(writes.filter(w => w.path.includes("/issues/29/comments")).length, 0, "no payout or paid record lands on the task");
    assert.match(patches[1].body.body, /- \[x\] #29 — volunteer/, "the delivered volunteer task ticks the checklist");
    assert.deepEqual(patches[1].body.labels, ["engagement"]);
  });

  test("a mixed job pays only its paid tasks, and closes once they are paid", async () => {
    const members = [shaped(29, "0"), shaped(30, "1000000")];
    const onChain = {
      id: 41,
      status: "InProgress",
      description: proposalDescription(28, members[1]),
      kind: { Transfer: { token_id: USDC, receiver_id: "agent.agency.testnet", amount: "1000000", msg: null } },
    };
    const { reads, writes } = serve({
      ...board([terms(29, "0"), terms(30, "1000000")]),
      proposals: [onChain],
    });
    await proposePayouts({ members }, "unused.testnet", () => {});
    const filed = writes.filter(w => w.path.endsWith("/issues/30/comments"));
    assert.equal(filed.length, 1, "the paid task's proposal is announced");
    assert.match(filed[0].body.body, /\*\*Payout proposed:\*\* DAO proposal 41/);
    assert.equal(writes.filter(w => w.path.endsWith("/issues/29/comments")).length, 0, "the volunteer task gets none");
    assert.ok(reads.length > 0, "the treasury is read for the paid task");
    assert.equal(reads.filter(host => host !== "api.github.com").length, 2, "no proposal is filed on chain: the live one is reused");

    // Paid but not yet recorded, the job waits; recorded, it closes, counting
    // the paid task only.
    const waiting = serve(board([terms(29, "0"), terms(30, "1000000")]));
    await closeIfPaid(28, () => {});
    assert.equal(waiting.writes.length, 0, "an unpaid paid task holds the job open");
    const done = serve(board([terms(29, "0"), terms(30, "1000000")], {
      records: { 30: { thread: [{ id: 50, user: { login: "multi-agency" }, body: `**Paid:** x\n\n${fence("paid", { proposal_id: 41, treasury: "t", payee: "agent.agency.testnet", amount: "1000000", transaction: "tx", approver: "a" })}` }] } },
    }));
    await closeIfPaid(28, () => {});
    const complete = done.writes.filter(w => w.path.endsWith("/issues/28/comments"));
    assert.equal(complete.length, 1);
    assert.match(complete[0].body.body, /^\*\*Job complete\.\*\* 1 payouts executed/);
  });

  // A volunteer task is never proposed or paid, so closeIfPaid is the only
  // place its delivery is checked: a job does not complete over one that is
  // not delivered, however its paid tasks stand.
  test("a volunteer-only job does not close over an undelivered task", async () => {
    const reopened = serve(board([terms(29, "0")], { records: { 29: { state: "open" } } }));
    await closeIfPaid(28, () => {});
    assert.equal(reopened.writes.length, 0, "an open volunteer task holds the job open");
    const bare = serve({
      issues: { 28: epic([terms(29, "0")]), 29: closed(29) },
      threads: { 28: [], 29: [] },
    });
    await closeIfPaid(28, () => {});
    assert.equal(bare.writes.length, 0, "a volunteer task closed without a handoff holds the job open");
  });

  test("a volunteer-only job does not close over an edited deliverable", async () => {
    const edited = { id: 777, user: { login: "multi-agency" }, body: "the guide, with a fix after sign-off" };
    const { writes } = serve({
      issues: { 28: epic([terms(29, "0")]), 29: closed(29) },
      threads: {
        28: [],
        29: [handoff(29, { deliverable: { url: "https://github.com/MultiAgency/kanban-sandbox/issues/29#issuecomment-777", sha256: digest("the original guide") } }), edited],
      },
    });
    await closeIfPaid(28, () => {});
    assert.equal(writes.length, 0, "the deliverable no longer matches its pin, so the job stays open");
  });

  // Whatever the payout, a code task owes the merged pull request it delivers:
  // a volunteer's too, matched to its claimant rather than to a payee.
  test("a volunteer code task owes its merged pull request before the job closes", async () => {
    const right = "https://github.com/MultiAgency/near-agencies/pull/50";
    const code = (pins, pulls = {}) => serve({
      issues: { 28: epic([terms(29, "0")]), 29: { ...closed(29), labels: [{ name: "skill:code" }] } },
      threads: { 28: [], 29: [handoff(29, pins)] },
      pulls,
    });
    const unmerged = code({ links: [right] }, { 50: { merged: false } });
    await closeIfPaid(28, () => {});
    assert.equal(unmerged.writes.length, 0, "an unmerged pull request holds the job open");
    const bare = code({ links: [] });
    await closeIfPaid(28, () => {});
    assert.equal(bare.writes.length, 0, "a handoff that links no pull request holds the job open");
    const merged = code({ links: [right] }, { 50: {} });
    await closeIfPaid(28, () => {});
    const complete = merged.writes.filter(w => w.path.endsWith("/issues/28/comments"));
    assert.equal(complete.length, 1, "merged by its claimant, the volunteer code task delivers");
    assert.match(complete[0].body.body, /^\*\*Job complete\.\*\* 0 payouts executed/);
  });

  // One mixed job on the sweep: task 29 is a volunteer whose signed-off
  // deliverable was edited after task 30's proposal was filed and voted
  // through. The edit holds proposing (payoutProblem covers every member),
  // but not the recording and closing of the paid work.
  test("a volunteer's edited deliverable does not hold the paid tasks' recording", async () => {
    const edited = { id: 777, user: { login: "multi-agency" }, body: "the guide, with a fix after sign-off" };
    const filed = {
      id: 780,
      user: { login: "multi-agency" },
      body: `**Payout proposed:** DAO proposal 41\n\n${fence("payout", { proposal_id: 41, treasury: "multiagency.sputnikv2.testnet", payee: "agent.agency.testnet", amount: "1000000", proposed_tx: "votetx" })}`,
    };
    const recorded = `**Paid:** \`approver.testnet\` approved DAO proposal 41; 1 USDC sent to \`agent.agency.testnet\`.\n\n${fence("paid", { proposal_id: 41, treasury: "multiagency.sputnikv2.testnet", payee: "agent.agency.testnet", amount: "1000000", transaction: "votetx", approver: "approver.testnet" })}`;
    const vote = {
      transaction: {
        hash: "votetx",
        signer_id: "approver.testnet",
        receiver_id: "multiagency.sputnikv2.testnet",
        actions: [{ FunctionCall: { method_name: "act_proposal", args: Buffer.from(JSON.stringify({ id: 41, action: "VoteApprove" })).toString("base64") } }],
      },
      receipts: [{ receipt: { block_height: 500 } }],
    };
    const mixed = (pin, paid = []) => serve({
      jobs: [epic([terms(29, "0"), terms(30, "1000000")])],
      issues: {
        28: epic([terms(29, "0"), terms(30, "1000000")]),
        29: closed(29),
        30: closed(30),
      },
      threads: {
        29: [handoff(29, { deliverable: { url: "https://github.com/MultiAgency/kanban-sandbox/issues/29#issuecomment-777", sha256: pin } }), edited],
        30: [handoff(30), filed, ...paid],
      },
      proposal: { id: 41, status: "Approved" },
      txs: [vote],
    });
    const held = mixed(digest("the original guide"));
    await settlePayouts("multi-agency", { now: 1_000_000 });
    const paid = held.writes.filter(w => w.path.endsWith("/issues/30/comments"));
    assert.equal(paid.length, 1, "the paid task's payout is recorded despite the volunteer's edit");
    assert.match(paid[0].body.body, /^\*\*Paid:\*\*/);
    const holds = held.writes.filter(w => w.path.endsWith("/issues/28/comments"));
    assert.equal(holds.length, 1, "the job says once why it is not completing");
    assert.match(holds[0].body.body, /^\*\*Delivery on hold:\*\* #29's deliverable was edited after its handoff/);
    assert.equal(held.writes.some(w => w.path.endsWith("/issues/28") && w.body.state === "closed"), false, "the job stays open while the volunteer's delivery is out of order");

    // The volunteer re-pins the deliverable as it now reads; the next sweep
    // closes the job over the recorded payment.
    const settled = mixed(digest(edited.body), [{ id: 781, user: { login: "multi-agency" }, body: recorded }]);
    await settlePayouts("multi-agency", { now: 1_121_000 });
    const complete = settled.writes.filter(w => w.path.endsWith("/issues/28/comments"));
    assert.equal(complete.length, 1);
    assert.match(complete[0].body.body, /^\*\*Job complete\.\*\* 1 payouts executed/);
    assert.equal(settled.writes.some(w => w.path.endsWith("/issues/28") && w.body.state === "closed"), true, "the job closes once the volunteer's delivery is in order");
  });

  // Two coordinators raced to file one task's payout: both proposals are live
  // and identical, the task's recorded payout names the first, and only one of
  // the two must ever be approved. The sweep flags the task once, naming both.
  const filed = {
    id: 41,
    user: { login: "multi-agency" },
    body: `**Payout proposed:** DAO proposal 41\n\n${fence("payout", { proposal_id: 41, treasury: "multiagency.sputnikv2.testnet", payee: "agent.agency.testnet", amount: "1000000", proposed_tx: "votetx" })}`,
  };
  const onChain = (id, status = "InProgress") => ({
    id,
    status,
    description: proposalDescription(28, shaped(30, "1000000")),
    kind: { Transfer: { token_id: USDC, receiver_id: "agent.agency.testnet", amount: "1000000", msg: null } },
  });
  const vote = (id, hash) => ({
    transaction: {
      hash,
      signer_id: "approver.testnet",
      receiver_id: "multiagency.sputnikv2.testnet",
      actions: [{ FunctionCall: { method_name: "act_proposal", args: Buffer.from(JSON.stringify({ id, action: "VoteApprove" })).toString("base64") } }],
    },
    receipts: [{ receipt: { block_height: 500 } }],
  });
  const paidRecord = (proposalId, tx) =>
    `**Paid:** \`approver.testnet\` approved DAO proposal ${proposalId}; 1 USDC sent to \`agent.agency.testnet\`.\n\n${fence("paid", { proposal_id: proposalId, treasury: "multiagency.sputnikv2.testnet", payee: "agent.agency.testnet", amount: "1000000", transaction: tx, approver: "approver.testnet" })}`;
  const dupBoard = (proposals, { proposalStatus = "InProgress", txs = [], records = [], lastId = null } = {}) => ({
    jobs: [epic([terms(30, "1000000")])],
    issues: { 28: epic([terms(30, "1000000")]), 30: closed(30) },
    threads: { 28: [], 30: [handoff(30), filed, ...records] },
    proposals,
    proposal: { id: 41, status: proposalStatus },
    txs,
    lastId,
  });
  const flagsOn = writes => writes.filter(w => w.path.endsWith("/issues/30/comments") && w.body.body.startsWith("**Duplicate payout proposals:**"));
  const doublesOn = writes => writes.filter(w => w.path.endsWith("/issues/30/comments") && w.body.body.startsWith("**Double payout:**"));
  const paidOn = writes => writes.filter(w => w.path.endsWith("/issues/30/comments") && w.body.body.startsWith("**Paid:**"));
  const closesJob = writes => writes.some(w => w.path.endsWith("/issues/28") && w.body.state === "closed");

  test("two matching live proposals are flagged on their task, once", async () => {
    const run = serve(dupBoard([onChain(41), onChain(42)]));
    await settlePayouts("multi-agency", { now: 2_000_000 });
    assert.equal(flagsOn(run.writes).length, 1, "one comment names the duplicates");
    assert.match(flagsOn(run.writes)[0].body.body, /DAO proposals 41 and 42 on `multiagency\.sputnikv2\.testnet` each pay this task 1 USDC to `agent\.agency\.testnet`/);
    assert.match(flagsOn(run.writes)[0].body.body, /Approve 41 alone and reject 42/);
    await settlePayouts("multi-agency", { now: 2_121_000 });
    assert.equal(flagsOn(run.writes).length, 1, "flagged once, however often the sweep runs");
    assert.equal(run.writes.filter(w => w.path.endsWith("/issues/30/comments")).length, 1, "the flag is the only comment the task draws");
  });

  test("one matching live proposal draws no flag", async () => {
    const { writes } = serve(dupBoard([onChain(41)]));
    await settlePayouts("multi-agency", { now: 3_000_000 });
    assert.equal(writes.filter(w => w.path.endsWith("/issues/30/comments")).length, 0, "the task's thread is untouched");
  });

  test("a duplicate proposal is never the payment that is recorded", async () => {
    // The recorded proposal 41 was voted through while its duplicate 42 still
    // stands: recording keys to the task's payout, never to the extra.
    const vote = {
      transaction: {
        hash: "votetx",
        signer_id: "approver.testnet",
        receiver_id: "multiagency.sputnikv2.testnet",
        actions: [{ FunctionCall: { method_name: "act_proposal", args: Buffer.from(JSON.stringify({ id: 41, action: "VoteApprove" })).toString("base64") } }],
      },
      receipts: [{ receipt: { block_height: 500 } }],
    };
    const { writes } = serve(dupBoard([onChain(41), onChain(42)], { proposalStatus: "Approved", txs: [vote] }));
    await settlePayouts("multi-agency", { now: 4_000_000 });
    const paid = writes.filter(w => w.path.endsWith("/issues/30/comments") && w.body.body.startsWith("**Paid:**"));
    assert.equal(paid.length, 1, "recorded once, from the proposal the task's payout names");
    assert.match(paid[0].body.body, /approved DAO proposal 41;/);
    assert.doesNotMatch(paid[0].body.body, /proposal 42/);
  });

  // The owner's race: proposal 41 — the one the task's payout records — was
  // approved in Trezu before a sweep could flag its duplicate. The payment
  // records from 41 all the same, 42 stays flagged for rejection, and the job
  // waits for it to die; once it is rejected, the job closes.
  test("an approved recording proposal keeps its duplicate flagged and the job open", async () => {
    const run = serve(dupBoard([onChain(41, "Approved"), onChain(42)], { proposalStatus: "Approved", txs: [vote(41, "votetx")] }));
    await settlePayouts("multi-agency", { now: 5_000_000 });
    const paid = paidOn(run.writes);
    assert.equal(paid.length, 1, "the payment records once, from the proposal that was approved");
    assert.match(paid[0].body.body, /approved DAO proposal 41;/);
    const flags = flagsOn(run.writes);
    assert.equal(flags.length, 1, "the duplicate is flagged although the recorded proposal is no longer InProgress");
    assert.match(flags[0].body.body, /Proposal 41 was approved; reject 42/);
    assert.equal(closesJob(run.writes), false, "the job does not close while proposal 42 is still live");
    const holds = run.writes.filter(w => w.path.endsWith("/issues/28/comments"));
    assert.equal(holds.length, 1);
    assert.match(holds[0].body.body, /^\*\*Delivery on hold:\*\* #30 has 2 payout proposals \(41 and 42\)/);

    const settled = serve(dupBoard([onChain(41, "Approved"), onChain(42, "Rejected")], {
      proposalStatus: "Approved",
      txs: [vote(41, "votetx")],
      records: [{ id: 782, user: { login: "multi-agency" }, body: paidRecord(41, "votetx") }],
    }));
    await settlePayouts("multi-agency", { now: 5_121_000 });
    assert.equal(flagsOn(settled.writes).length, 0, "a rejected duplicate is no duplicate");
    const complete = settled.writes.filter(w => w.path.endsWith("/issues/28/comments"));
    assert.equal(complete.length, 1, "the job closes once the duplicate is rejected");
    assert.match(complete[0].body.body, /^\*\*Job complete\.\*\* 1 payouts executed/);
  });

  // The mirror: the EXTRA proposal 42 is the one approved while the recorded
  // 41 still waits. The payment adopts 42 — the transfer that really ran —
  // and 41, now pointless, is what an approver must reject.
  test("an approved duplicate is adopted as the payment and the recorded proposal flagged", async () => {
    const run = serve(dupBoard([onChain(41), onChain(42, "Approved")], { txs: [vote(42, "votetx2")] }));
    await settlePayouts("multi-agency", { now: 6_000_000 });
    const paid = paidOn(run.writes);
    assert.equal(paid.length, 1, "the payment records once");
    assert.match(paid[0].body.body, /approved DAO proposal 42;/);
    assert.doesNotMatch(paid[0].body.body, /proposal 41/);
    const flags = flagsOn(run.writes);
    assert.equal(flags.length, 1);
    assert.match(flags[0].body.body, /Proposal 42 was approved, so the payment is recorded with it; reject 41/);
    assert.equal(closesJob(run.writes), false, "the recorded proposal is still live, so the job waits");

    const settled = serve(dupBoard([onChain(41, "Rejected"), onChain(42, "Approved")], {
      proposalStatus: "Rejected",
      txs: [vote(42, "votetx2")],
      records: [{ id: 782, user: { login: "multi-agency" }, body: paidRecord(42, "votetx2") }],
    }));
    await settlePayouts("multi-agency", { now: 6_121_000 });
    const complete = settled.writes.filter(w => w.path.endsWith("/issues/28/comments"));
    assert.equal(complete.length, 1, "the job closes once the recorded proposal is rejected");
    assert.match(complete[0].body.body, /^\*\*Job complete\.\*\* 1 payouts executed/);
  });

  // Both proposals approved: the task was paid twice. Nothing records, the
  // task says so loudly once, and the incident shows in /api/health.
  test("two approved proposals are reported as a double payment and never recorded", async () => {
    const run = serve(dupBoard([onChain(41, "Approved"), onChain(42, "Approved")], {
      proposalStatus: "Approved",
      txs: [vote(41, "votetx"), vote(42, "votetx2")],
    }));
    await settlePayouts("multi-agency", { now: 7_000_000 });
    assert.equal(paidOn(run.writes).length, 0, "a task paid twice records no payment");
    const doubles = doublesOn(run.writes);
    assert.equal(doubles.length, 1);
    assert.match(doubles[0].body.body, /DAO proposals 41 and 42 on `multiagency\.sputnikv2\.testnet` were all approved/);
    assert.match(doubles[0].body.body, /paid more than once/);
    assert.equal(closesJob(run.writes), false);
    const { coordinatorHealth } = await import("../lib/coordinator.mjs");
    assert.deepEqual(coordinatorHealth().paid_twice.map(p => [p.job, p.task, p.proposals]), [[28, 30, [41, 42]]],
      "the double payment shows in /api/health");
    await settlePayouts("multi-agency", { now: 7_121_000 });
    assert.equal(doublesOn(run.writes).length, 1, "said once, however often the sweep runs");
  });

  // The treasury moves on: once its counter sits far above a job's proposals,
  // a newest-100 read no longer reaches them. The audit must still see a
  // task's proposals beside its recorded one, or the eviction quietly turns a
  // double payment into a recorded payment and a closed job — and paid_twice
  // must be found again after a restart, when nothing is memoized.
  test("a double payment stays reported however far the treasury has moved on", async () => {
    const board = dupBoard([onChain(41, "Approved"), onChain(42, "Approved")], {
      proposalStatus: "Approved",
      txs: [vote(41, "votetx"), vote(42, "votetx2")],
      lastId: 400,
    });
    // A restart reads the chain again over an unchanged board: the clone is
    // taken before the first sweep writes into the board it serves.
    const restartedBoard = structuredClone(board);
    const run = serve(board);
    await settlePayouts("multi-agency", { now: 8_000_000 });
    assert.equal(paidOn(run.writes).length, 0, "the proposals leaving the newest-100 window must not turn a double payment into a recording");
    assert.equal(doublesOn(run.writes).length, 1, "the double payment is still reported on the task");
    assert.equal(closesJob(run.writes), false);
    const restarted = serve(restartedBoard);
    await settlePayouts("multi-agency", { now: 8_121_000 });
    assert.equal(paidOn(restarted.writes).length, 0, "still nothing records once nothing is memoized");
    assert.equal(doublesOn(restarted.writes).length, 1, "paid_twice is found again after a restart");
    assert.equal(closesJob(restarted.writes), false);
  });

  // A job's recorded proposal and a duplicate filed for it can sit further
  // apart than one page of 100: the audit reads every page up to the newest.
  test("a duplicate beyond the first page is still flagged", async () => {
    const run = serve(dupBoard([onChain(41), onChain(341)], { lastId: 400 }));
    await settlePayouts("multi-agency", { now: 8_300_000 });
    const flags = flagsOn(run.writes);
    assert.equal(flags.length, 1, "the duplicate 300 ids on is seen");
    assert.match(flags[0].body.body, /DAO proposals 41 and 341 /);
    assert.deepEqual(payoutAuditCapped(), [], "a read within the page cap reports nothing");
  });

  test("a read that reaches the page cap is reported on /api/health", async () => {
    const run = serve(dupBoard([onChain(41), onChain(3000)], { lastId: 5000 }));
    await settlePayouts("multi-agency", { now: 8_600_000 });
    assert.equal(flagsOn(run.writes).length, 0, "the duplicate lies past the cap, so this cycle does not see it");
    const [entry] = coordinatorHealth().payout_audit_capped;
    assert.equal(entry.job, 28);
    assert.equal(entry.pages, AUDIT_PAGE_CAP);
  });

  // A capped audit cannot vouch for a duplicate past where it stopped — a
  // payment already recorded must still hold, not complete, over the
  // incomplete read.
  test("a capped audit holds duplicatePayoutProblem, pendingPayouts and closeIfPaid", async () => {
    const run = serve(dupBoard([onChain(41, "Approved"), onChain(3000)], {
      proposalStatus: "Approved",
      txs: [vote(41, "votetx")],
      records: [{ id: 782, user: { login: "multi-agency" }, body: paidRecord(41, "votetx") }],
      lastId: 5000,
    }));
    const job = await loadEngagement(28);
    const problem = await duplicatePayoutProblem(job);
    assert.match(problem, /payout audit stopped at its page cap \(1000 proposals/);
    const { problem: pendingProblem } = await pendingPayouts(job, ["approver.testnet"]);
    assert.match(pendingProblem, /payout audit stopped at its page cap/);
    const held = await closeIfPaid(28, () => {});
    assert.match(held, /payout audit stopped at its page cap/);
    assert.equal(run.writes.some(w => w.path.endsWith("/issues/28") && w.body.state === "closed"), false,
      "the job does not close over an incomplete audit");
  });

  test("recordApprovals records nothing for a job whose audit is capped", async () => {
    const run = serve(dupBoard([onChain(41, "Approved"), onChain(3000)], {
      proposalStatus: "Approved",
      txs: [vote(41, "votetx")],
      lastId: 5000,
    }));
    const job = await loadEngagement(28);
    await recordApprovals(job, () => {});
    assert.equal(paidOn(run.writes).length, 0, "a capped audit must not record a payment it cannot fully vouch for");
  });

  // The recorded proposal can die beside live extras — expired while an
  // approver sorts the duplicates out. The flag must not send an approver to
  // the dead one: proposePayouts never files again for a task with a recorded
  // payout, so the payment has to land on a live proposal.
  test("a dead recorded proposal hands its payment to a live one", async () => {
    const run = serve(dupBoard([onChain(41, "Expired"), onChain(42), onChain(43)], { proposalStatus: "Expired" }));
    await settlePayouts("multi-agency", { now: 9_000_000 });
    const flags = flagsOn(run.writes);
    assert.equal(flags.length, 1);
    assert.match(flags[0].body.body, /approve 42 and reject 43/, "a live proposal is named as the payment");
    assert.doesNotMatch(flags[0].body.body, /approve 41\b/, "the dead recorded proposal is not what an approver is told to approve");
    assert.equal(paidOn(run.writes).length, 0);
    assert.equal(closesJob(run.writes), false);
  });

  // payout.mjs approve — the terminal path — refuses to vote while a
  // duplicate stands, by the same check the panel and the sweep read.
  test("the terminal approve refuses to vote while a duplicate stands", async () => {
    const argv = process.argv;
    process.argv = ["node", "payout.mjs", "approve", "28", "--as", "approver.testnet"];
    try {
      const { writes } = serve(dupBoard([onChain(41), onChain(42)]));
      await assert.rejects(import("../payout.mjs"), /Refusing to vote: #30 has 2 payout proposals \(41 and 42\)/);
      assert.equal(paidOn(writes).length, 0, "nothing was voted or recorded");
    } finally {
      process.argv = argv;
    }
  });
});
