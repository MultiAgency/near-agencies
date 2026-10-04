import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { settledEpicPatch, stage } from "../lib/engagement-state.mjs";

// An assembled epic, shaped like assemble.mjs leaves it: a checklist of the
// team's seats under `## Team`, then the ```team fence, and `blocked` on it
// until every seat closes.
const epic = (overrides = {}) => ({
  number: 1,
  state: "closed",
  labels: [{ name: "blocked" }, { name: "engagement" }],
  body: [
    "Hire a team to write a brief.",
    "",
    "```engagement",
    JSON.stringify({ org: "acme", deposit: { amount: "3000000" } }, null, 2),
    "```",
    "",
    "## Team",
    "",
    "- [ ] #2 — 1 USDC",
    "- [ ] #3 — 1 USDC",
    "- [ ] #4 — 1 USDC",
    "",
    "```team",
    JSON.stringify({ committed: "3000000", members: [] }, null, 2),
    "```",
  ].join("\n"),
  ...overrides,
});

// The facts loadEngagement derives per seat; only state and handoff matter here.
const member = (issue, state, handoff) => ({ issue, state, handoff: handoff ? { payout: { account_id: "a.testnet" } } : null });

describe("settling a closed epic", () => {
  test("ticks the seats that closed with a handoff and strips `blocked`", () => {
    const patch = settledEpicPatch(epic(), [
      member(2, "closed", true),
      member(3, "closed", true),
      member(4, "closed", false),
    ]);
    assert.deepEqual(patch.labels, ["engagement"]);
    assert.equal(patch.body, epic({
      body: epic().body
        .replace("- [ ] #2", "- [x] #2")
        .replace("- [ ] #3", "- [x] #3"),
    }).body);
  });

  test("leaves open the box of a seat without a handoff, even one already ticked", () => {
    const patched = epic({ body: epic().body.replace("- [ ] #3", "- [x] #3") });
    const patch = settledEpicPatch(patched, [member(3, "closed", false)]);
    assert.deepEqual(patch.labels, ["engagement"]);
    assert.match(patch.body, /- \[ \] #3 — 1 USDC/);
  });

  test("a settled epic needs no patch at all", () => {
    const settled = epic({
      labels: [{ name: "engagement" }],
      body: epic().body.replace("- [ ] #2", "- [x] #2").replace("- [ ] #3", "- [x] #3").replace("- [ ] #4", "- [x] #4"),
    });
    assert.equal(settledEpicPatch(settled, [
      member(2, "closed", true),
      member(3, "closed", true),
      member(4, "closed", true),
    ]), null);
  });

  test("checkboxes outside the `## Team` section are not the checklist", () => {
    const withBriefBox = epic({
      body: epic().body.replace("Hire a team to write a brief.", "Hire a team to write a brief.\n\n- [ ] #2 milestone"),
    });
    const patch = settledEpicPatch(withBriefBox, [member(2, "closed", true)]);
    assert.match(patch.body, /- \[ \] #2 milestone/);
    assert.match(patch.body, /- \[x\] #2 — 1 USDC/);
  });

  test("boxes naming issues that are not team members are left alone", () => {
    const patch = settledEpicPatch(epic({ body: epic().body.replace("- [ ] #4", "- [ ] #999") }), [
      member(2, "closed", true),
      member(3, "closed", true),
    ]);
    assert.match(patch.body, /- \[ \] #999 — 1 USDC/);
  });

  test("an epic with no assembled team only drops the label", () => {
    const bare = epic({ body: "Hire a team.\n\n```engagement\n{}\n```" });
    assert.deepEqual(settledEpicPatch(bare, []), { labels: ["engagement"] });
  });

  test("a seat that is merely closed without a handoff, or open, stays unticked", () => {
    const patch = settledEpicPatch(epic(), [
      member(2, "closed", false),
      member(3, "open", true),
    ]);
    const body = patch.body ?? epic().body;
    assert.match(body, /- \[ \] #2 — 1 USDC/);
    assert.match(body, /- \[ \] #3 — 1 USDC/);
  });
});

describe("a job's stage", () => {
  const open = { state: "open", state_reason: null };
  const seat = (state, amount, payout) => ({ state, amount, payout });

  test("volunteer tasks hold neither accepting nor the close: all delivered, it is paying", () => {
    assert.equal(stage(open, { committed: "0" }, [seat("closed", "0")]), "paying");
    assert.equal(stage(open, { committed: "1000000" }, [seat("closed", "0"), seat("closed", "1000000", { proposal_id: 1 })]), "paying",
      "a volunteer beside a proposed payout does not hold it");
  });

  test("paid work without a proposal is still accepting, volunteer or not beside it", () => {
    assert.equal(stage(open, { committed: "1000000" }, [seat("closed", "1000000")]), "accepting");
    assert.equal(stage(open, { committed: "1000000" }, [seat("closed", "0"), seat("closed", "1000000")]), "accepting");
  });
});
