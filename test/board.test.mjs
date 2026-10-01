import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { assignmentClaims, isChangeRequest, revisionNotice } from "../lib/coordinator.mjs";
import { fence, fenced } from "../lib/github.mjs";
import { byGithub, covers, isProfileUpdate } from "../lib/roster.mjs";
import { eligibility, handoffProblem, isClaim, pinProblem, seat, selfReviewProblem } from "../lib/seats.mjs";

// Requests go only to the fetch stubs below; the token just has to resolve.
process.env.GITHUB_TOKEN = "test-token";

const issue = (overrides = {}) => ({
  number: 11,
  title: "Write: comparison",
  html_url: "https://github.com/MultiAgency/kanban-sandbox/issues/11",
  state: "open",
  updated_at: "2026-09-28T01:00:00Z",
  assignees: [],
  labels: [{ name: "ready" }, { name: "skill:writing" }, { name: "agent-eligible" }],
  body: [
    "Part of job #5.",
    "",
    "Turn the research into a comparison.",
    "",
    "Depends on:",
    "- [ ] #10",
    "",
    fence("terms", { engagement: 5, amount: "1000000", asset: "usdc" }),
  ].join("\n"),
  ...overrides,
});

const agent = { kind: "agent", skills: ["research", "writing"] };
const human = { kind: "human", skills: ["review"] };

// Serves the default seat's dependency #10: its assignees and the claims its
// thread records. A ready seat's dependencies are closed, so checking who
// delivered them reads each dependency issue and its comments.
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const comment = (id, login, body) => ({ id, user: { login }, body });
const claimedRecord = (id, by, login) =>
  comment(id, by, `Claimed by @${login}. Once the work is signed off, 1 USDC is paid to \`x.testnet\`.`);
const serveDependency = (assignees = [], records = []) => {
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    const get = (options.method ?? "GET") === "GET";
    const json = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (get && u.pathname === "/user") return json({ login: "multi-agency" });
    if (get && u.pathname === "/repos/MultiAgency/kanban-sandbox/issues/10") {
      return json({ number: 10, assignees: assignees.map(login => ({ login })) });
    }
    if (get && u.pathname === "/repos/MultiAgency/kanban-sandbox/issues/10/comments") return json(records);
    const permission = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/);
    if (get && permission) return json({ role_name: "read" });
    throw new Error(`unexpected request: ${options.method ?? "GET"} ${u.pathname}${u.search}`);
  };
};

describe("fenced blocks", () => {
  test("round-trips a handoff block", () => {
    const body = `**Handoff:** done\n\n${fence("handoff", { payout: { account_id: "a.testnet" } })}\n\nnotes`;
    assert.deepEqual(fenced(body, "handoff"), { payout: { account_id: "a.testnet" } });
  });

  test("returns null for a missing or malformed block", () => {
    assert.equal(fenced("no block here", "handoff"), null);
    assert.equal(fenced("```handoff\n{not json}\n```", "handoff"), null);
  });
});

describe("seats", () => {
  test("parses terms, skills and dependencies", () => {
    const s = seat(issue());
    assert.deepEqual(s.terms, { engagement: 5, amount: "1000000", asset: "usdc" });
    assert.deepEqual(s.skills, ["skill:writing"]);
    assert.deepEqual(s.dependsOn, [10]);
  });

  test("an agent may take an agent-eligible seat its skills cover", () => {
    assert.equal(eligibility(seat(issue()), agent), null);
  });

  test("refuses claimants who are off the roster or the wrong kind; skills only suggest", () => {
    assert.match(eligibility(seat(issue()), null), /not on the MultiAgency roster/);
    const humanOnly = seat(issue({ labels: [{ name: "ready" }, { name: "skill:review" }, { name: "human-only" }] }));
    assert.match(eligibility(humanOnly, agent), /human-only/);
    assert.equal(eligibility(humanOnly, human), null);
    const notAgentEligible = seat(issue({ labels: [{ name: "ready" }, { name: "skill:writing" }] }));
    assert.match(eligibility(notAgentEligible, agent), /not agent-eligible/);
    assert.equal(eligibility(seat(issue()), { kind: "agent", skills: ["research"] }), null);
  });

  test("refuses a claimant who delivered a seat this one reviews", async () => {
    const review = seat(issue({ labels: [{ name: "ready" }, { name: "skill:review" }] }));
    serveDependency(["jlwaugh"]);
    assert.match(await selfReviewProblem(review, "jlwaugh"),
      /this task reviews #10, which you delivered — a sign-off means someone else checked the work/);
    assert.equal(await selfReviewProblem(review, "multi-agency"), null);
  });

  test("the coordinator's claimed record refuses too, but only from the bot or an owner", async () => {
    const review = seat(issue({ labels: [{ name: "ready" }, { name: "skill:review" }] }));
    serveDependency([], [claimedRecord(1, "multi-agency", "jlwaugh")]);
    assert.match(await selfReviewProblem(review, "jlwaugh"), /reviews #10, which you delivered/);
    serveDependency([], [claimedRecord(2, "stranger", "jlwaugh")]);
    assert.equal(await selfReviewProblem(review, "jlwaugh"), null, "a forged record counts for nothing");
  });

  test("a seat that only builds on its dependency gates nobody", async () => {
    serveDependency(["jlwaugh"]);
    assert.equal(await selfReviewProblem(seat(issue()), "jlwaugh"), null);
    assert.equal(await selfReviewProblem(seat(issue({ body: fence("terms", { engagement: 5, amount: "1000000" }) })), "jlwaugh"), null);
  });
});

describe("native assignment claims", () => {
  const assigned = (...logins) =>
    seat(issue({ assignees: logins.map(login => ({ login })) }));
  const humanOnly = assignees =>
    seat(issue({ labels: [{ name: "ready" }, { name: "skill:review" }, { name: "human-only" }], assignees }));

  test("an eligible assignee is accepted, naming the payout account", async () => {
    serveDependency();
    const { accepted, refused } = await assignmentClaims(assigned("multi-agency"));
    assert.ok(accepted);
    assert.equal(accepted.login, "multi-agency");
    assert.equal(accepted.builder.nearAccount, "agent.agency.testnet");
    assert.deepEqual(refused, []);
  });

  test("a human assignee may take a human-only seat", async () => {
    serveDependency();
    const { accepted } = await assignmentClaims(humanOnly([{ login: "jlwaugh" }]));
    assert.ok(accepted);
    assert.equal(accepted.builder.nearAccount, "reviewer.agency.testnet");
  });

  test("ineligible assignees are refused with the /claim reasons", async () => {
    serveDependency();
    const offRoster = await assignmentClaims(assigned("stranger"));
    assert.equal(offRoster.accepted, null);
    assert.match(offRoster.refused[0].refusal, /not on the MultiAgency roster/);
    assert.match(await assignmentClaims(humanOnly([{ login: "multi-agency" }])).then(r => r.refused[0].refusal), /human-only/);
    const notAgentEligible = seat(issue({ labels: [{ name: "ready" }, { name: "skill:writing" }], assignees: [{ login: "multi-agency" }] }));
    assert.match((await assignmentClaims(notAgentEligible)).refused[0].refusal, /not agent-eligible/);
    const outsideSkills = seat(issue({ labels: [{ name: "ready" }, { name: "skill:review" }, { name: "agent-eligible" }], assignees: [{ login: "multi-agency" }] }));
    assert.equal((await assignmentClaims(outsideSkills)).accepted?.login, "multi-agency");
  });

  test("an assignee who delivered a dependency is refused; another roster member still gets the seat", async () => {
    serveDependency(["jlwaugh"]);
    const reviewOf = logins => seat(issue({
      labels: [{ name: "ready" }, { name: "skill:review" }, { name: "agent-eligible" }],
      assignees: logins.map(login => ({ login })),
    }));
    const { accepted, refused } = await assignmentClaims(reviewOf(["jlwaugh", "multi-agency"]));
    assert.equal(accepted.login, "multi-agency");
    assert.deepEqual(refused.map(claim => claim.login), ["jlwaugh"]);
    assert.match(refused[0].refusal, /this task reviews #10, which you delivered — a sign-off means someone else checked the work/);
  });

  test("the first eligible assignee wins and ineligible ones are refused", async () => {
    serveDependency();
    const { accepted, refused } = await assignmentClaims(assigned("stranger", "multi-agency", "nobody"));
    assert.equal(accepted.login, "multi-agency");
    assert.deepEqual(refused.map(claim => claim.login), ["stranger", "nobody"]);
  });

  test("two eligible assignees: the first wins and the second is refused naming the winner", async () => {
    serveDependency();
    const contested = seat(issue({
      labels: [{ name: "ready" }, { name: "agent-eligible" }],
      assignees: [{ login: "multi-agency" }, { login: "jlwaugh" }],
    }));
    const { accepted, refused } = await assignmentClaims(contested);
    assert.equal(accepted.login, "multi-agency");
    assert.deepEqual(refused.map(claim => claim.login), ["jlwaugh"]);
    assert.match(refused[0].refusal, /@multi-agency claimed it first/);
  });

  test("a seat nobody assigned has nothing to settle", async () => {
    serveDependency();
    const { accepted, refused } = await assignmentClaims(seat(issue()));
    assert.equal(accepted, null);
    assert.deepEqual(refused, []);
  });
});

describe("roster", () => {
  test("maps GitHub logins to payout accounts, case-insensitively", () => {
    assert.equal(byGithub("Multi-Agency")?.nearAccount, "agent.agency.testnet");
    assert.equal(byGithub("nobody"), null);
  });

  test("checks skill coverage against skill labels", () => {
    assert.equal(covers(agent, ["skill:research", "skill:writing"]), true);
    assert.equal(covers(agent, ["skill:review"]), false);
  });
});

describe("comments", () => {
  test("recognizes claims", () => {
    assert.equal(isClaim({ body: "/claim" }), true);
    assert.equal(isClaim({ body: "  /claim please" }), true);
    assert.equal(isClaim({ body: "I'd like to /claim this" }), false);
  });

  test("recognizes change requests but not the bot's routing notes", () => {
    assert.equal(isChangeRequest({ body: "Changes requested before acceptance:\n\n1. fix it" }), true);
    const routed = `**Changes requested** by @jlwaugh\n\n${fence("changes", { review: 12 })}`;
    assert.equal(isChangeRequest({ body: routed }), false);
    assert.equal(isChangeRequest({ body: "Looks good" }), false);
  });
});

describe("handoffs", () => {
  const builder = { nearAccount: "agency-builder.testnet" };
  const handoff = { payout: { account_id: "agency-builder.testnet" }, links: ["https://github.com/MultiAgency/kanban-sandbox/issues/21"] };

  test("a handoff paid to its author's roster account can close its seat", async () => {
    assert.equal(await handoffProblem(handoff, builder), null);
  });

  test("refuses an author off the roster, a different payout account, or an unpinned deliverable", async () => {
    assert.match(await handoffProblem(handoff, null), /not on the roster/);
    assert.match(await handoffProblem({ ...handoff, payout: { account_id: "thief.testnet" } }, builder), /not agency-builder\.testnet/);
    const unpinned = { ...handoff, links: ["https://github.com/MultiAgency/kanban-sandbox/issues/20#issuecomment-1"] };
    assert.match(await handoffProblem(unpinned, builder), /without pinning/);
    assert.equal(pinProblem(unpinned), "it links a deliverable comment without pinning its sha256");
  });
});

describe("revisions", () => {
  const changes = n => ({ body: `**Changes requested** by @jlwaugh\n\n${fence("changes", { review: 27, requested_by: "jlwaugh", request: `r${n}` })}` });
  const handoff = { html_url: "https://example/handoff", body: `**Handoff:** revised\n\n${fence("handoff", { deliverable: { url: "https://example/deliverable-2", sha256: "x" } })}` };

  test("tells the reviewer on the review task which round is in, linking the revised work", () => {
    assert.deepEqual(revisionNotice(26, [changes(1), handoff], handoff), {
      review: 27,
      body: "@jlwaugh, round 2 of #26 is in: https://example/deliverable-2. It passed the handoff checks: sign it off here, or ask for another round.",
    });
    assert.match(revisionNotice(26, [changes(1), changes(2), handoff], handoff).body, /round 3 of #26/);
  });
});

describe("profile updates", () => {
  const member = { nearAccount: "alice.testnet", kind: "agent", operator: "bob", skills: ["research"], name: "Alice" };

  test("a request that keeps the account, kind and operator only updates the profile", () => {
    assert.equal(isProfileUpdate(member, { ...member, skills: ["research", "writing"], name: "Alice B" }), true);
  });

  test("anything else needs an owner: a new member, account, kind or operator", () => {
    assert.equal(isProfileUpdate(null, member), false);
    assert.equal(isProfileUpdate(member, { ...member, nearAccount: "other.testnet" }), false);
    assert.equal(isProfileUpdate(member, { ...member, kind: "human" }), false);
    assert.equal(isProfileUpdate(member, { ...member, operator: "carol" }), false);
    assert.equal(isProfileUpdate({ ...member, operator: undefined }, { ...member, operator: undefined }), true);
  });
});
