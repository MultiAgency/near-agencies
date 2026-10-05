import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AGENCY,
  REVIEWER,
  authorAllowed,
  codeownersMatches,
  codeownersRules,
  newestVerdictArtifact,
  openCandidates,
  ownersForPath,
  reviewerCovers,
  stagingApproval,
  testVerdict,
  uncoveredPath,
  verdictArtifactName,
  verdictArtifactNumbers,
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
  roster: { status: "absent" },
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

  test("check 3: an author outside team internal, the agency account and the roster holds", () => {
    const { outcome, reason } = stagingApproval(passing({ author: "drive-by", internal: ["saadiqbal-dev"] }));
    assert.equal(outcome, "hold");
    assert.match(reason, /@drive-by is not in team internal/);
  });

  test("check 3: a team internal that cannot be read fails closed, whoever the author is", () => {
    const { outcome, reason } = stagingApproval(passing({ internal: null }));
    assert.equal(outcome, "hold");
    assert.match(reason, /internal could not be read/);
  });

  test("check 3: a rostered agent whose operator is in team internal passes", () => {
    const agent = passing({ author: "agency-builder", internal: ["jlwaugh"], roster: { status: "record", kind: "agent", operator: "jlwaugh" } });
    assert.equal(stagingApproval(agent).outcome, "approve");
  });

  test("check 3: a rostered agent whose operator is outside team internal holds", () => {
    const { outcome, reason } = stagingApproval(passing({ author: "agency-builder", internal: ["saadiqbal-dev"], roster: { status: "record", kind: "agent", operator: "someone-else" } }));
    assert.equal(outcome, "hold");
    assert.match(reason, /@agency-builder is not in team internal/);
  });

  test("check 3: a rostered agent with no operator, or a record naming no kind, holds", () => {
    for (const roster of [{ status: "record", kind: "agent", operator: null }, { status: "record", kind: null, operator: "jlwaugh" }]) {
      const { outcome } = stagingApproval(passing({ author: "agency-builder", internal: ["saadiqbal-dev"], roster }));
      assert.equal(outcome, "hold");
    }
  });

  test("check 3: a roster that cannot be read fails closed for an author the team alone cannot allow", () => {
    const { outcome, reason } = stagingApproval(passing({ author: "drive-by", internal: ["saadiqbal-dev"], roster: { status: "unreadable" } }));
    assert.equal(outcome, "hold");
    assert.match(reason, /roster could not be read/);
  });

  test("check 3: an unreadable roster does not hold an author team internal allows", () => {
    const { outcome } = stagingApproval(passing({ roster: { status: "unreadable" } }));
    assert.equal(outcome, "approve");
  });

  test("check 4: a test check that has not passed holds", () => {
    for (const test of ["pending", "failure", null, undefined]) {
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

  test("a pull request is judged on both paths of a rename", () => {
    // A rename lands as two changed paths: the old one leaves its owner's
    // protection and the new one enters the allowlist. Moving a money or
    // permission file into an allowlisted directory must hold.
    const moved = passing({ paths: ["docs/roster.json", "roster.json"] });
    const { outcome, reason } = stagingApproval(moved);
    assert.equal(outcome, "hold");
    assert.match(reason, /roster\.json/);
    assert.equal(stagingApproval(passing({ paths: ["docs/new.md", "docs/old.md"] })).outcome, "approve");
  });

  test("a second allowlist line after the reviewer's keeps a file off the allowlist", () => {
    const overridden = codeownersRules(`${CODEOWNERS}\n/lib/brief.mjs          @jlwaugh @MultiAgency/internal`);
    const { outcome } = stagingApproval(passing({ rules: overridden }));
    assert.equal(outcome, "hold");
  });

  test("a later ** rule that does not name the reviewer keeps its deep paths off the allowlist", () => {
    const narrowed = codeownersRules(`${CODEOWNERS}\n/test/private/**        @jlwaugh`);
    assert.equal(uncoveredPath(narrowed, ["test/private/deep/unit.test.mjs"]), "test/private/deep/unit.test.mjs");
    const { outcome } = stagingApproval(passing({ rules: narrowed, paths: ["test/private/deep/unit.test.mjs"] }));
    assert.equal(outcome, "hold");
  });
});

describe("authorAllowed", () => {
  test("the names the issue allows, case apart", () => {
    assert.equal(authorAllowed({ author: AGENCY }), true);
    assert.equal(authorAllowed({ author: "jlwaugh", internal: ["jlwaugh"] }), true);
    assert.equal(authorAllowed({ author: "agency-builder", internal: ["jlwaugh"], roster: { status: "record", kind: "agent", operator: "jlwaugh" } }), true);
    assert.equal(authorAllowed({ author: "JLWAUGH", internal: ["jlwaugh"] }), true);
  });

  test("nobody else, and an unreadable team or roster holds nobody in", () => {
    assert.equal(authorAllowed({ author: "stranger" }), false);
    assert.equal(authorAllowed({ author: "stranger", internal: null }), false);
    assert.equal(authorAllowed({ author: "stranger", roster: { status: "unreadable" } }), false);
    assert.equal(authorAllowed({ author: "agency-builder", internal: ["jlwaugh"], roster: { status: "record", kind: "agent", operator: "someone-else" } }), false);
    assert.equal(authorAllowed({ author: "agency-builder", internal: ["jlwaugh"], roster: { status: "record", kind: "agent", operator: null } }), false);
    assert.equal(authorAllowed({ author: "agency-builder", internal: ["jlwaugh"], roster: { status: "record", kind: "human", operator: "jlwaugh" } }), false);
    assert.equal(authorAllowed({ author: "agency-builder", internal: ["jlwaugh"], roster: { status: "absent" } }), false);
  });

  test("the roster answers for who the agent is, never for who answers for it", () => {
    // The operator counts only as a member GitHub's own team read names;
    // the roster pairing agent with operator is not itself the membership.
    assert.equal(authorAllowed({ author: "agency-builder", internal: [], roster: { status: "record", kind: "agent", operator: "jlwaugh" } }), false);
  });
});

describe("openCandidates", () => {
  test("the event's pull requests, the commit's, and the verdict artifacts', deduplicated", () => {
    assert.deepEqual(
      openCandidates([{ number: 12 }, { number: 7 }], [{ number: 7, state: "open" }, { number: 9 }], [9, 15]),
      [12, 7, 9, 15],
    );
  });

  test("entries without a number count for nothing", () => {
    assert.deepEqual(openCandidates([{}, null], [undefined]), []);
    assert.deepEqual(openCandidates(), []);
  });
});

describe("verdictArtifactNumbers", () => {
  test("reads the pull request number out of artifacts named for it", () => {
    assert.deepEqual(
      verdictArtifactNumbers([{ name: "ai-review-verdict-108" }, { name: "ai-review-verdict-12" }, { name: "other" }, { name: "ai-review-verdict-x" }, {}]),
      [108, 12],
    );
    assert.deepEqual(verdictArtifactNumbers([]), []);
    assert.deepEqual(verdictArtifactNumbers(null), []);
  });
});

describe("newestVerdictArtifact", () => {
  test("the newest artifact still held and named for the pull request decides", () => {
    const artifacts = [
      { id: 31, name: "ai-review-verdict-108", expired: false, workflow_run: { id: 901 } },
      { id: 30, name: "ai-review-verdict-108", expired: false, workflow_run: { id: 900 } },
      { id: 29, name: "ai-review-verdict-12", expired: false, workflow_run: { id: 899 } },
      { id: 28, name: "ai-review-verdict-108", expired: true, workflow_run: { id: 898 } },
      { id: 27, name: "other", expired: false, workflow_run: { id: 897 } },
      { name: "ai-review-verdict-108" },
    ];
    assert.equal(newestVerdictArtifact(artifacts, 108)?.workflow_run?.id, 901);
    assert.equal(newestVerdictArtifact(artifacts, 12)?.workflow_run?.id, 899);
    assert.deepEqual(verdictArtifactName(108), "ai-review-verdict-108");
  });

  test("a pull_request_target run's head_branch names the base branch, and the artifact decides anyway", () => {
    // GitHub answers a pull_request_target run with head_branch "staging"
    // and staging's head as its head_sha, so nothing the run reports names
    // the pull request it reviewed. The artifact's name ties the verdict to
    // #108, and the run behind it is read from the artifact itself.
    const found = newestVerdictArtifact([{ id: 31, name: "ai-review-verdict-108", expired: false, workflow_run: { id: 901 } }], 108);
    assert.equal(found.workflow_run.id, 901);
  });

  test("nothing held, nothing named for the pull request, or no run behind it, is no artifact", () => {
    assert.equal(newestVerdictArtifact([], 108), null);
    assert.equal(newestVerdictArtifact(null, 108), null);
    assert.equal(newestVerdictArtifact([{ id: 31, name: "ai-review-verdict-108", expired: true, workflow_run: { id: 901 } }], 108), null);
    assert.equal(newestVerdictArtifact([{ id: 31, name: "ai-review-verdict-108", expired: false }], 108), null);
    assert.equal(newestVerdictArtifact([{ id: 31, name: "ai-review-verdict-12", expired: false, workflow_run: { id: 901 } }], 108), null);
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

  test("** crosses directories, as gitignore and GitHub match it", () => {
    assert.equal(codeownersMatches("**/logs", "logs"), true);
    assert.equal(codeownersMatches("**/logs", "a/b/logs"), true);
    assert.equal(codeownersMatches("**/logs", "a/b/logs/under"), true);
    assert.equal(codeownersMatches("**/logs", "a/b/logsname"), false);
    assert.equal(codeownersMatches("docs/**", "docs/x/y"), true);
    assert.equal(codeownersMatches("docs/**", "other/x"), false);
    assert.equal(codeownersMatches("a/**/b", "a/b"), true);
    assert.equal(codeownersMatches("a/**/b", "a/x/y/b"), true);
    assert.equal(codeownersMatches("a/**/b", "a/x/c"), false);
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
