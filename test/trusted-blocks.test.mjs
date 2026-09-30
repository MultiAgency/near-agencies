import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

process.env.GITHUB_TOKEN = "test-token";
const { fence } = await import("../lib/github.mjs");
const { loadEngagement } = await import("../lib/engagement-state.mjs");

// A job (#1) with one closed task (#2) claimed by near-builder, on a board
// whose bot is multi-agency and whose only owner is jlwaugh.
const epic = {
  number: 1, title: "Job: A job", state: "open", html_url: "https://github.com/x/y/issues/1",
  body: ["Brief", "", fence("engagement", { org: "org.testnet", deposit: { amount: "3000000", transaction: "tx" } }), "",
    fence("team", { committed: "1000000", members: [{ issue: 2, amount: "1000000" }] })].join("\n"),
};
const task = { number: 2, title: "Task", state: "closed", html_url: "https://github.com/x/y/issues/2", labels: [], assignees: [{ login: "near-builder" }] };
const handoff = login => ({ user: { login }, body: `**Handoff:** done\n\n${fence("handoff", { payout: { account_id: `${login}.testnet` } })}` });
const paid = login => ({ user: { login }, body: fence("paid", { transaction: "fake", approver: login }) });
const payout = login => ({ user: { login }, body: fence("payout", { proposal_id: 42, treasury: "dao.testnet", payee: `${login}.testnet` }) });

function board(thread) {
  globalThis.fetch = async url => {
    const path = new URL(url).pathname;
    const json = value => new Response(JSON.stringify(value));
    if (path === "/user") return json({ login: "multi-agency" });
    if (path.endsWith("/issues/1")) return json(epic);
    if (path.endsWith("/issues/2")) return json(task);
    if (path.endsWith("/issues/2/comments")) return json(thread);
    const permission = path.match(/\/collaborators\/([^/]+)\/permission$/);
    if (permission) return json({ role_name: permission[1] === "jlwaugh" ? "admin" : "read" });
    throw new Error(`unexpected ${url}`);
  };
}

describe("blocks count only from their rightful author", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("a stranger's paid block does not mark the task paid", async () => {
    board([handoff("near-builder"), paid("stranger")]);
    assert.equal((await loadEngagement(1)).members[0].paid, null);
  });

  test("a stranger's payout block is not the task's proposal", async () => {
    board([handoff("near-builder"), payout("stranger")]);
    assert.equal((await loadEngagement(1)).members[0].payout, null);
  });

  test("a stranger's handoff does not replace the claimant's", async () => {
    board([handoff("near-builder"), handoff("stranger")]);
    const [m] = (await loadEngagement(1)).members;
    assert.equal(m.handoffBy, "near-builder");
    assert.equal(m.handoff.payout.account_id, "near-builder.testnet");
  });

  test("an owner's paid block counts, as payout.mjs has written them", async () => {
    board([handoff("near-builder"), paid("jlwaugh")]);
    assert.equal((await loadEngagement(1)).members[0].paid.approver, "jlwaugh");
  });
});

describe("change requests count only when the coordinator routed them", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("a stranger's changes block is ignored", async () => {
    board([]);
    const { routedRequests } = await import("../lib/coordinator.mjs");
    const changes = login => ({ user: { login }, body: fence("changes", { review: 41, requested_by: "jlwaugh" }) });
    const routed = changes("multi-agency");
    assert.deepEqual(await routedRequests([routed, handoff("near-builder"), changes("stranger")]), [routed]);
  });
});
