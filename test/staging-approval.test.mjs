import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AGENCY,
  REVIEWER,
  authorAllowed,
  codeownersMatches,
  codeownersRules,
  ownersForPath,
  reviewerCovers,
  stagingApproval,
  testVerdict,
  uncoveredPath,
  verdictFrom,
} from "../lib/staging-approval.mjs";

// The base branch's CODEOWNERS as #77's owner edits would leave it: `*`
// first, the allowlist after, money and permission paths keeping their own
// rules — the last match decides.
const CODEOWNERS = [
  "*                        @MultiAgency/internal @jlwaugh",
  "/lib/pay.mjs            @jlwaugh @MultiAgency/internal",
  "/docs/                  @MultiAgency/internal @jlwaugh @multai-builder",
  "/lib/brief.mjs          @MultiAgency/internal @jlwaugh @multai-builder",
].join("\n");

const rules = () => codeownersRules(CODEOWNERS);
const verdict = sha => ({ sha, important: 0 });
const SHA = "5e0a1f2a3b4c5d6e7f8091011121314151617181";
const passing = (over = {}) => ({
  base: "staging",
  fork: false,
  author: "saadiqbal-dev",
  internal: ["saadiqbal-dev"],
  internalAgents: [],
  paths: ["docs/setup.md", "lib/brief.mjs"],
  rules: rules(),
  test: "passed",
  verdict: verdict(SHA),
  sha: SHA,
  ...over,
});

describe("stagingApproval", () => {
  test("check 1: a pull request not targeting staging holds", () => {
    for (const base of ["main", "release", ""]) {
      const { outcome, reason } = stagingApproval(passing({ base }));
      assert.equal(outcome, "hold");
      assert.match(reason, /not staging/);
    }
  });

  test("check 2: a fork's pull request holds", () => {
    const { outcome, reason } = stagingApproval(passing({ fork: true }));
    assert.equal(outcome, "hold");
    assert.match(reason, /fork/);
  });

  test("check 3: an author outside team internal, internal-agents and the agency account holds", () => {
    const { outcome, reason } = stagingApproval(passing({ author: "drive-by", internal: ["saadiqbal-dev"] }));
    assert.equal(outcome, "hold");
    assert.match(reason, /@drive-by is not in/);
  });

  test("check 3: a team internal that cannot be read fails closed, whoever the author is", () => {
    const { outcome, reason } = stagingApproval(passing({ internal: null }));
    assert.equal(outcome, "hold");
    assert.match(reason, /internal could not be read/);
  });

  test("check 4: a test check that has not passed holds", () => {
    for (const test of ["pending", "failure", null]) {
      const { outcome, reason } = stagingApproval(passing({ test }));
      assert.equal(outcome, "hold");
      assert.match(reason, /test/);
    }
  });

  test("check 5: one changed file off the allowlist holds, and the log names it", () => {
    const { outcome, reason } = stagingApproval(passing({ paths: ["docs/setup.md", "lib/github.mjs"] }));
    assert.equal(outcome, "hold");
    assert.match(reason, /lib\/github\.mjs/);
    assert.match(reason, /multai-builder/);
  });

  test("check 5: a pull request changing no file approves nothing", () => {
    const { outcome } = stagingApproval(passing({ paths: [] }));
    assert.equal(outcome, "hold");
  });

  test("check 6: no verdict, or one that does not parse, holds", () => {
    for (const v of [null, {}, { sha: SHA }, { sha: SHA, important: "none" }, { sha: SHA, important: -1 }]) {
      const { outcome, reason } = stagingApproval(passing({ verdict: v }));
      assert.equal(outcome, "hold");
      assert.match(reason, /ai-review/);
    }
  });

  test("check 6: a verdict for an older SHA holds", () => {
    const { outcome, reason } = stagingApproval(passing({ verdict: verdict("0000000000000000000000000000000000000000") }));
    assert.equal(outcome, "hold");
    assert.match(reason, /not this head SHA/);
  });

  test("check 6: a verdict counting Important findings holds", () => {
    const { outcome, reason } = stagingApproval(passing({ verdict: { sha: SHA, important: 2 } }));
    assert.equal(outcome, "hold");
    assert.match(reason, /2 Important findings/);
  });

  test("the passing case: every check holds, so the approval posts", () => {
    const { outcome, reason } = stagingApproval(passing());
    assert.equal(outcome, "approve");
    assert.match(reason, new RegExp(`@${REVIEWER} owns every changed file`));
    assert.match(reason, /0 Important findings/);
  });

  test("an author in internal-agents passes like one in internal", () => {
    const agent = passing({ author: "agency-builder", internal: ["jlwaugh"], internalAgents: ["agency-builder"] });
    assert.equal(stagingApproval(agent).outcome, "approve");
  });

  test("a second allowlist line after the reviewer's keeps a file off the allowlist", () => {
    const overridden = codeownersRules(`${CODEOWNERS}\n/lib/brief.mjs          @jlwaugh @MultiAgency/internal`);
    const { outcome } = stagingApproval(passing({ rules: overridden }));
    assert.equal(outcome, "hold");
  });
});

describe("authorAllowed", () => {
  test("the three names the issue allows, case apart", () => {
    assert.equal(authorAllowed({ author: AGENCY }), true);
    assert.equal(authorAllowed({ author: "jlwaugh", internal: ["jlwaugh"] }), true);
    assert.equal(authorAllowed({ author: "agency-builder", internalAgents: ["agency-builder"] }), true);
    assert.equal(authorAllowed({ author: "JLWAUGH", internal: ["jlwaugh"] }), true);
  });

  test("nobody else, and an unreadable team holds nobody in", () => {
    assert.equal(authorAllowed({ author: "stranger" }), false);
    assert.equal(authorAllowed({ author: "stranger", internal: null }), false);
    assert.equal(authorAllowed({ author: "stranger", internalAgents: null }), false);
  });
});

describe("codeownersRules", () => {
  test("keeps file order, drops comments and ownerless lines, lowercases owners", () => {
    assert.deepEqual(codeownersRules("# note\n*.md @Jlwaugh\n/no-owners\n"), [
      { pattern: "*.md", owners: ["jlwaugh"] },
    ]);
  });

  test("no text, no rules", () => {
    assert.deepEqual(codeownersRules(null), []);
    assert.deepEqual(codeownersRules(""), []);
  });
});

describe("codeownersMatches", () => {
  test("a trailing slash selects the directory's contents, and nothing outside it", () => {
    assert.equal(codeownersMatches("/docs/", "docs/setup.md"), true);
    assert.equal(codeownersMatches("/docs/", "docs/deep/setup.md"), true);
    assert.equal(codeownersMatches("/docs/", "src/docs/setup.md"), false);
    assert.equal(codeownersMatches("/docs/", "docs.md"), false);
  });

  test("a leading slash anchors at the root", () => {
    assert.equal(codeownersMatches("/README.md", "README.md"), true);
    assert.equal(codeownersMatches("/README.md", "docs/README.md"), false);
  });

  test("a pattern with no slash matches the name at any depth", () => {
    assert.equal(codeownersMatches("README.md", "README.md"), true);
    assert.equal(codeownersMatches("README.md", "docs/README.md"), true);
    assert.equal(codeownersMatches("README.md", "docs/deep/README.md"), true);
  });

  test("a wildcard covers one segment only", () => {
    assert.equal(codeownersMatches("/lib/*.mjs", "lib/brief.mjs"), true);
    assert.equal(codeownersMatches("/lib/*.mjs", "lib/deep/brief.mjs"), false);
  });

  test("garbage matches nothing", () => {
    assert.equal(codeownersMatches("", "README.md"), false);
    assert.equal(codeownersMatches("/docs/", ""), false);
    assert.equal(codeownersMatches("/docs/", null), false);
  });
});

describe("ownersForPath and uncoveredPath", () => {
  test("the last matching rule decides who owns a file", () => {
    assert.deepEqual(ownersForPath(rules(), "lib/pay.mjs"), ["jlwaugh", "multiagency/internal"]);
    assert.deepEqual(ownersForPath(rules(), "README.md"), ["multiagency/internal", "jlwaugh"]);
    assert.deepEqual(ownersForPath(rules(), "lib/other.mjs"), ["multiagency/internal", "jlwaugh"]);
  });

  test("uncoveredPath names the first file the reviewer does not own", () => {
    assert.equal(uncoveredPath(rules(), ["docs/setup.md", "lib/pay.mjs"]), "lib/pay.mjs");
    assert.equal(uncoveredPath(rules(), ["docs/setup.md", "lib/brief.mjs"]), null);
  });
});

describe("reviewerCovers", () => {
  test("true only when every changed file's last rule names the reviewer", () => {
    assert.equal(reviewerCovers(rules(), ["docs/setup.md", "lib/brief.mjs"]), true);
    assert.equal(reviewerCovers(rules(), ["docs/setup.md", "lib/pay.mjs"]), false);
    assert.equal(reviewerCovers(rules(), []), false);
    assert.equal(reviewerCovers(null, ["README.md"]), false);
  });
});

describe("testVerdict", () => {
  test("resolves the check run to passed, pending, or the conclusion", () => {
    assert.equal(testVerdict({ status: "completed", conclusion: "success" }), "passed");
    assert.equal(testVerdict({ status: "in_progress" }), "pending");
    assert.equal(testVerdict({ status: "completed", conclusion: "failure" }), "failure");
    assert.equal(testVerdict(null), null);
  });
});

describe("verdictFrom", () => {
  test("parses a verdict with a SHA and a non-negative count", () => {
    assert.deepEqual(verdictFrom(`{"sha":"${SHA}","important":0}`), { sha: SHA, important: 0 });
    assert.deepEqual(verdictFrom(`{"sha":"${SHA}","important":2}`), { sha: SHA, important: 2 });
  });

  test("anything else is no verdict", () => {
    for (const text of ["", "not json", "{}", '{"sha":"","important":0}', `{"sha":"${SHA}"}`, `{"sha":"${SHA}","important":1.5}`, `{"sha":"${SHA}","important":"0"}`, "null"]) {
      assert.equal(verdictFrom(text), null, text);
    }
  });
});
