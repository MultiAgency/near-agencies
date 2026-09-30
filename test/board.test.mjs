import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { assignmentClaims, isChangeRequest, revisionNotice } from "../lib/coordinator.mjs";
import { fence, fenced, fenceProblem } from "../lib/github.mjs";
import { byGithub, covers, isProfileUpdate } from "../lib/roster.mjs";
import { eligibility, handoffProblem, isClaim, pinProblem, seat } from "../lib/seats.mjs";

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

describe("unreadable handoff blocks", () => {
  // The shape seen in the wild: the JSON is fine, the closing fence is missing.
  const unclosed = ["**Handoff:** done", "", "```handoff", JSON.stringify({ payout: { account_id: "a.testnet" } }, null, 2), "}"].join("\n");

  test("a fence never closed, or closed around non-JSON, cannot be read", () => {
    assert.equal(fenceProblem(unclosed, "handoff"), "unclosed");
    assert.equal(fenceProblem("```handoff", "handoff"), "unclosed");
    assert.equal(fenceProblem("```handoff\n{not json}\n```", "handoff"), "invalid");
  });

  test("a block that parses, and prose that opens no line, are not problems", () => {
    assert.equal(fenceProblem(`x\n\n${fence("handoff", { payout: { account_id: "a.testnet" } })}\nnotes`, "handoff"), null);
    assert.equal(fenceProblem("Post a ```handoff block with the payout account.", "handoff"), null);
    assert.equal(fenceProblem("like ```handoff\nsample\n``` in the docs", "handoff"), null);
    assert.equal(fenceProblem("    ```handoff\nsample\n``` (a code block, not a fence)", "handoff"), null);
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
});

describe("native assignment claims", () => {
  const assigned = (...logins) =>
    seat(issue({ assignees: logins.map(login => ({ login })) }));
  const humanOnly = assignees =>
    seat(issue({ labels: [{ name: "ready" }, { name: "skill:review" }, { name: "human-only" }], assignees }));

  test("an eligible assignee is accepted, naming the payout account", () => {
    const { accepted, refused } = assignmentClaims(assigned("multi-agency"));
    assert.ok(accepted);
    assert.equal(accepted.login, "multi-agency");
    assert.equal(accepted.builder.nearAccount, "agent.agency.testnet");
    assert.deepEqual(refused, []);
  });

  test("a human assignee may take a human-only seat", () => {
    const { accepted } = assignmentClaims(humanOnly([{ login: "jlwaugh" }]));
    assert.ok(accepted);
    assert.equal(accepted.builder.nearAccount, "reviewer.agency.testnet");
  });

  test("ineligible assignees are refused with the /claim reasons", () => {
    const offRoster = assignmentClaims(assigned("stranger"));
    assert.equal(offRoster.accepted, null);
    assert.match(offRoster.refused[0].refusal, /not on the MultiAgency roster/);
    assert.match(assignmentClaims(humanOnly([{ login: "multi-agency" }])).refused[0].refusal, /human-only/);
    const notAgentEligible = seat(issue({ labels: [{ name: "ready" }, { name: "skill:writing" }], assignees: [{ login: "multi-agency" }] }));
    assert.match(assignmentClaims(notAgentEligible).refused[0].refusal, /not agent-eligible/);
    const outsideSkills = seat(issue({ labels: [{ name: "ready" }, { name: "skill:review" }, { name: "agent-eligible" }], assignees: [{ login: "multi-agency" }] }));
    assert.equal(assignmentClaims(outsideSkills).accepted?.login, "multi-agency");
  });

  test("the first eligible assignee wins and ineligible ones are refused", () => {
    const { accepted, refused } = assignmentClaims(assigned("stranger", "multi-agency", "nobody"));
    assert.equal(accepted.login, "multi-agency");
    assert.deepEqual(refused.map(claim => claim.login), ["stranger", "nobody"]);
  });

  test("two eligible assignees: the first wins and the second is refused naming the winner", () => {
    const contested = seat(issue({
      labels: [{ name: "ready" }, { name: "agent-eligible" }],
      assignees: [{ login: "multi-agency" }, { login: "jlwaugh" }],
    }));
    const { accepted, refused } = assignmentClaims(contested);
    assert.equal(accepted.login, "multi-agency");
    assert.deepEqual(refused.map(claim => claim.login), ["jlwaugh"]);
    assert.match(refused[0].refusal, /@multi-agency claimed it first/);
  });

  test("a seat nobody assigned has nothing to settle", () => {
    const { accepted, refused } = assignmentClaims(seat(issue()));
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
