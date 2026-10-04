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

// The worker reads the same threads with its own token and its own trust
// check (agents/claude-worker/trust.mjs), so its revision-round boundary —
// the ```changes block a handoff must be newer than — must land where the
// coordinator's does. These tests run both boundaries against one thread.
describe("the worker's changes boundary agrees with the coordinator's", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const changes = login => ({ user: { login }, body: `Once more:\n${fence("changes", { review: 41, requested_by: "jlwaugh" })}` });
  const done = { user: { login: "near-builder" }, body: `Done.\n\n${fence("handoff", { links: "x" })}` };
  const ownerRound = [done, changes("jlwaugh")];
  const seat = {
    number: 2, state: "open", created_at: "2026-10-01T00:00:00Z",
    body: `Part of job #1.\n\n${fence("terms", { engagement: "job 1" })}`,
    assignees: [{ login: "near-builder" }], labels: [],
  };
  // The worker's github(), as worker.mjs builds it, with a token that
  // cannot read board roles: every role lookup answers 403.
  const workerGithub = thread => async path => {
    if (path === "/issues?state=open&per_page=100") return [seat];
    if (/^\/issues\/2\/comments/.test(path)) return thread;
    if (/^\/collaborators\/[^/]+\/permission$/.test(path)) throw new Error(`GitHub GET ${path}: 403`);
    throw new Error(`unexpected GET ${path}`);
  };
  const deliver = async thread => {
    const { nextTask } = await import("../agents/claude-worker/next-task.mjs");
    return nextTask({
      github: workerGithub(thread), comment: async () => {},
      login: "near-builder", skills: ["writing"], codeMode: null, bot: "multi-agency",
    });
  };

  test("an owner's direct round: the coordinator counts it, and so does a worker that cannot read roles", async () => {
    board(ownerRound);
    const { routedRequests } = await import("../lib/coordinator.mjs");
    assert.deepEqual(await routedRequests(ownerRound), [changes("jlwaugh")], "the coordinator waits for a revision handoff");
    const picked = await deliver(ownerRound);
    assert.equal(picked.action, "deliver", "a fail-closed worker would skip the seat on every run and stall it");
    assert.equal(picked.revision, true);
    assert.deepEqual(picked.round, changes("jlwaugh"));
  });

  test("on such a token a stranger's block counts too — the fallback's documented cost", async () => {
    const strangerRound = [done, changes("stranger")];
    board(strangerRound);
    const { routedRequests } = await import("../lib/coordinator.mjs");
    assert.deepEqual(await routedRequests(strangerRound), [], "with a role-reading token the stranger's block is no round");
    const picked = await deliver(strangerRound);
    assert.equal(picked.revision, true, "without role lookups the worker cannot tell a stranger from an owner");
  });
});
