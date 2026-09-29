import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { fence } from "../lib/github.mjs";
import { classify } from "../lib/timeline.mjs";

describe("timeline events", () => {
  test("places each board event in the lane of whoever acted", () => {
    assert.deepEqual(classify("/claim", "agency-builder"), { lane: "agency-builder", kind: "claim" });
    assert.deepEqual(classify("**Team approved** by @jlwaugh, from [the team draft](https://example): #29 Research (1 USDC).", "multi-agency"), { lane: "jlwaugh", kind: "team-approved" });
    assert.deepEqual(classify("**Deliverable** for #20", "agency-builder"), { lane: "agency-builder", kind: "deliverable" });
    assert.deepEqual(classify(`**Handoff:** done\n\n${fence("handoff", { payout: {} })}`, "agency-builder"), { lane: "agency-builder", kind: "handoff" });
    assert.deepEqual(classify("Changes requested before acceptance: fix it", "jlwaugh"), { lane: "jlwaugh", kind: "changes-requested" });
    assert.deepEqual(classify("Claimed by @agency-builder. Once the work is signed off…", "multi-agency"), { lane: "coordinator", kind: "assigned" });
    assert.deepEqual(classify("**Job complete.** 3 payouts executed", "jlwaugh"), { lane: "treasury", kind: "complete" });
    assert.deepEqual(classify("**Paid:** `agency.testnet` approved…", "jlwaugh"), { lane: "treasury", kind: "paid" });
  });

  test("tells the maintainer from the coordinator, though both post as the same account", () => {
    const draft = "**Maintainer:** Team draft\n\n```team-draft\n{}\n```\n\n<!-- multiagency-maintainer -->";
    assert.deepEqual(classify(draft, "multi-agency"), { lane: "maintainer", kind: "team-draft" });
    assert.equal(classify("Just a remark", "someone"), null);
  });
});
