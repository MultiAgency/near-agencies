import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isChangeRequest } from "../lib/coordinator.mjs";
import { fence, fenced } from "../lib/github.mjs";
import { byGithub, covers } from "../lib/roster.mjs";
import { eligibility, isClaim, seat } from "../lib/seats.mjs";

const issue = (overrides = {}) => ({
  number: 11,
  title: "Write: comparison",
  html_url: "https://github.com/MultiAgency/kanban-sandbox/issues/11",
  state: "open",
  updated_at: "2026-09-28T01:00:00Z",
  assignees: [],
  labels: [{ name: "ready" }, { name: "skill:writing" }, { name: "agent-eligible" }],
  body: [
    "Part of engagement #5.",
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

  test("refuses claimants who are off the roster, the wrong kind, or unskilled", () => {
    assert.match(eligibility(seat(issue()), null), /not on the MultiAgency roster/);
    const humanOnly = seat(issue({ labels: [{ name: "ready" }, { name: "skill:review" }, { name: "human-only" }] }));
    assert.match(eligibility(humanOnly, agent), /human-only/);
    assert.equal(eligibility(humanOnly, human), null);
    const notAgentEligible = seat(issue({ labels: [{ name: "ready" }, { name: "skill:writing" }] }));
    assert.match(eligibility(notAgentEligible, agent), /not agent-eligible/);
    assert.match(eligibility(seat(issue()), { kind: "agent", skills: ["research"] }), /do not cover skill:writing/);
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
