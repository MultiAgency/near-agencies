import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  combineRoster,
  countableApprovals,
  countedApprovals,
  operatorApproval,
  ownersFromCodeowners,
  ownersFromEnv,
  REVIEWED_TEAMS,
  rosterFromApi,
  rosterRecord,
  unrecognizedApprovals,
} from "../lib/operator-approval.mjs";

const review = (login, state, submitted_at = "2026-10-04T10:00:00Z") => ({ user: { login }, state, submitted_at });
const approve = (login, at) => review(login, "APPROVED", at);
const record = (kind, operator) => ({ status: "record", kind, operator });
const pass = reason => ({ outcome: "pass", reason });
const fail = reason => ({ outcome: "fail", reason });

describe("countedApprovals", () => {
  test("counts a reviewer's latest approving review", () => {
    assert.deepEqual(countedApprovals([approve("jlwaugh")], "agency-builder"), ["jlwaugh"]);
  });

  test("a later dismissal supersedes an earlier approval", () => {
    assert.deepEqual(countedApprovals([approve("jlwaugh"), review("jlwaugh", "DISMISSED", "2026-10-04T11:00:00Z")], "agency-builder"), []);
  });

  test("a comment leaves an approval standing, as GitHub's review requirement does", () => {
    assert.deepEqual(countedApprovals([approve("jlwaugh"), review("jlwaugh", "COMMENTED", "2026-10-04T11:00:00Z")], "agency-builder"), ["jlwaugh"]);
  });

  test("requesting changes after an approval drops it", () => {
    assert.deepEqual(countedApprovals([approve("jlwaugh"), review("jlwaugh", "CHANGES_REQUESTED", "2026-10-04T11:00:00Z")], "agency-builder"), []);
  });

  test("an approval after a dismissal counts again", () => {
    assert.deepEqual(
      countedApprovals([approve("jlwaugh"), review("jlwaugh", "DISMISSED", "2026-10-04T11:00:00Z"), approve("jlwaugh", "2026-10-04T12:00:00Z")], "agency-builder"),
      ["jlwaugh"],
    );
  });

  test("the PR author's own review never counts", () => {
    assert.deepEqual(countedApprovals([approve("multi-agency")], "multi-agency"), []);
  });

  test("one entry per reviewer, whoever came last", () => {
    assert.deepEqual(
      countedApprovals([approve("saadiqbal-dev"), approve("jlwaugh"), review("jlwaugh", "CHANGES_REQUESTED", "2026-10-04T12:00:00Z")], "multi-agency"),
      ["saadiqbal-dev"],
    );
  });

  test("reviews without a reviewer or a state count for nothing", () => {
    assert.deepEqual(countedApprovals([{ state: "APPROVED" }, { user: { login: "jlwaugh" } }], "multi-agency"), []);
  });
});

describe("ownersFromCodeowners", () => {
  const text = [
    "# comment",
    "*                        @MultiAgency/internal @jlwaugh",
    "/.github/                @jlwaugh",
    "/lib/pay.mjs             @jlwaugh @MultiAgency/internal",
    "",
  ].join("\n");

  test("collects the users it names, teams aside, once each", () => {
    assert.deepEqual(ownersFromCodeowners(text), ["jlwaugh"]);
  });

  test("no text, no users", () => {
    assert.deepEqual(ownersFromCodeowners(null), []);
    assert.deepEqual(ownersFromCodeowners(""), []);
  });
});

describe("countableApprovals", () => {
  const internal = ["saadiqbal-dev"];

  test("a login CODEOWNERS names or OWNER names counts", () => {
    assert.deepEqual(countableApprovals(["jlwaugh", "stranger"], ["jlwaugh"], [], internal), ["jlwaugh"]);
    assert.deepEqual(countableApprovals(["somebody"], [], ["somebody"], internal), ["somebody"]);
  });

  test("the gate's approval counts once CODEOWNERS names it, as #77 must for the gate to work", () => {
    assert.deepEqual(countableApprovals(["multai-builder"], ["multai-builder"], [], internal), ["multai-builder"]);
  });

  test("a member of team internal counts", () => {
    assert.deepEqual(countableApprovals(["saadiqbal-dev"], [], [], internal), ["saadiqbal-dev"]);
  });

  test("a rostered person outside team internal does not: a declared kind decides nothing", () => {
    assert.deepEqual(countableApprovals(["rostered-outsider"], [], [], []), []);
  });

  test("an agent's approval counts for nothing: siblings never count as reviewers", () => {
    assert.deepEqual(countableApprovals(["agency-builder"], [], ["jlwaugh"], internal), []);
  });

  test("nor does a stranger's or an alt's", () => {
    assert.deepEqual(countableApprovals(["stranger", "jlwaugh-alt"], [], [], internal), []);
  });

  // The roster's and coordinator's declared kinds no longer vouch a reviewer
  // at all: they answer for the PR's author only, never for its approvers.

  test("with no names at all, nobody counts", () => {
    assert.deepEqual(countableApprovals(["jlwaugh"], [], [], []), []);
  });
});

describe("unrecognizedApprovals", () => {
  const internal = ["saadiqbal-dev"];

  test("names the approvals no source here vouches for", () => {
    assert.deepEqual(
      unrecognizedApprovals(["jlwaugh", "saadiqbal-dev", "agency-builder", "stranger"], ["jlwaugh"], [], internal),
      ["agency-builder", "stranger"],
    );
  });

  test("a rostered person outside team internal is unrecognized too", () => {
    assert.deepEqual(unrecognizedApprovals(["jlwaugh", "new-person"], ["jlwaugh"], [], []), ["new-person"]);
  });

  test("an empty standing list names nobody", () => {
    assert.deepEqual(unrecognizedApprovals([], ["jlwaugh"], [], internal), []);
  });
});

describe("rosterRecord", () => {
  const builders = [
    { links: { github: "https://github.com/agency-builder" }, kind: "agent", operator: "jlwaugh" },
    { links: { github: "https://github.com/jlwaugh/" }, kind: "human" },
  ];

  test("finds an agent's record by its GitHub link, case and slash aside", () => {
    assert.deepEqual(rosterRecord(builders, "Agency-Builder"), record("agent", "jlwaugh"));
    assert.deepEqual(rosterRecord(builders, "jlwaugh"), record("human", null));
  });

  test("answers absent for a login no record names", () => {
    assert.deepEqual(rosterRecord(builders, "stranger"), { status: "absent" });
    assert.deepEqual(rosterRecord(undefined, "stranger"), { status: "absent" });
  });
});

describe("rosterFromApi", () => {
  test("reads the coordinator's member record", () => {
    const body = { login: "agency-builder", stage: "member", member: { kind: "agent", operator: "jlwaugh" } };
    assert.deepEqual(rosterFromApi(body), record("agent", "jlwaugh"));
  });

  test("reads a login the coordinator does not know as absent", () => {
    assert.deepEqual(rosterFromApi({ login: "multi-agency", stage: "none" }), { status: "absent" });
    assert.deepEqual(rosterFromApi({ login: "stranger", stage: "checking" }), { status: "absent" });
  });

  test("a response without a stage is unreadable, not absent", () => {
    assert.deepEqual(rosterFromApi({ error: "no" }), { status: "unreadable" });
  });
});

describe("combineRoster", () => {
  test("the coordinator's record wins when it has one", () => {
    assert.deepEqual(combineRoster(record("human", null), record("agent", "jlwaugh")), record("agent", "jlwaugh"));
  });

  test("an absent answer defers to roster.json: the coordinator's deployment can lag staging", () => {
    assert.deepEqual(combineRoster(record("agent", "jlwaugh"), { status: "absent" }), record("agent", "jlwaugh"));
  });

  test("absent from both homes is absent", () => {
    assert.deepEqual(combineRoster({ status: "absent" }, { status: "absent" }), { status: "absent" });
  });

  test("with no coordinator, roster.json answers only when it names the login", () => {
    assert.deepEqual(combineRoster(record("agent", "jlwaugh"), { status: "unreadable" }), record("agent", "jlwaugh"));
    assert.deepEqual(combineRoster({ status: "absent" }, { status: "unreadable" }), { status: "unreadable" });
    assert.deepEqual(combineRoster({ status: "unreadable" }, { status: "unreadable" }), { status: "unreadable" });
  });
});

describe("ownersFromEnv", () => {
  test("splits OWNER on commas and drops blanks", () => {
    assert.deepEqual(ownersFromEnv("jlwaugh"), ["jlwaugh"]);
    assert.deepEqual(ownersFromEnv(" jlwaugh , somebody "), ["jlwaugh", "somebody"]);
    assert.deepEqual(ownersFromEnv(undefined), []);
  });
});

describe("REVIEWED_TEAMS", () => {
  test("the script reads one team only, and one that exists (#109)", () => {
    // #93's script also read internal-agents, a team that was never created:
    // the read could not succeed and the unreadable-teams gate failed every
    // same-repo PR closed. The script takes the teams it reads from this
    // list, so a second team cannot creep back into the reads without
    // changing it here — and this test with it.
    assert.deepEqual(REVIEWED_TEAMS, ["internal"]);
  });
});

describe("operatorApproval", () => {
  const staging = { base: "staging", owners: ["jlwaugh"] };

  test("the operator alone fails", () => {
    assert.deepEqual(
      operatorApproval({ ...staging, author: "new-agent", roster: record("agent", "saadiqbal-dev"), approvals: ["saadiqbal-dev"] }),
      fail("the only approval is @saadiqbal-dev, @new-agent's operator; an operator's approval alone does not approve their agent's PR"),
    );
  });

  test("the operator plus another approver passes", () => {
    assert.deepEqual(
      operatorApproval({ ...staging, author: "new-agent", roster: record("agent", "saadiqbal-dev"), approvals: ["saadiqbal-dev", "jlwaugh"] }).outcome,
      "pass",
    );
  });

  test("the operator plus an outside 'human' fails: only the operator's approval meets code-owner review", () => {
    // The script hands the verdict what it counted: the operator's approval
    // (a member of internal), the outsider's unrecognized — so the operator
    // stands alone whatever anyone outside CODEOWNERS' reach approved.
    assert.deepEqual(
      operatorApproval({ ...staging, author: "new-agent", roster: record("agent", "saadiqbal-dev"), approvals: ["saadiqbal-dev"], unvouched: ["outsider"] }),
      fail("the only approval is @saadiqbal-dev, @new-agent's operator; an operator's approval alone does not approve their agent's PR"),
    );
  });

  test("the owner alone on @multi-agency's PR passes", () => {
    assert.deepEqual(
      operatorApproval({ ...staging, author: "multi-agency", roster: record("agent", "jlwaugh"), approvals: ["jlwaugh"] }),
      pass("@jlwaugh operates @multi-agency as the owner, whose approval counts as it does today"),
    );
  });

  test("a person's PR is unaffected", () => {
    assert.deepEqual(
      operatorApproval({ ...staging, author: "jlwaugh", roster: record("human", null), approvals: ["jlwaugh"] }).outcome,
      "pass",
    );
  });

  test("so is a PR by someone no roster source names", () => {
    assert.deepEqual(
      operatorApproval({ ...staging, author: "stranger", roster: { status: "absent" }, approvals: ["stranger"] }).outcome,
      "pass",
    );
  });

  test("no approvals yet passes, as on a push before any review", () => {
    assert.deepEqual(
      operatorApproval({ ...staging, author: "agency-builder", roster: record("agent", "jlwaugh"), approvals: [] }).outcome,
      "pass",
    );
  });

  test("an approval nobody can vouch for fails closed, not as none yet", () => {
    assert.deepEqual(
      operatorApproval({ ...staging, author: "agency-builder", roster: record("agent", "jlwaugh"), approvals: [], unvouched: ["jlwaugh"] }).outcome,
      "fail",
    );
  });

  test("an unvouched approval alongside the operator's fails too", () => {
    assert.deepEqual(
      operatorApproval({ ...staging, author: "agency-builder", roster: record("agent", "jlwaugh"), approvals: [], unvouched: ["stranger", "jlwaugh"] }).outcome,
      "fail",
    );
  });

  test("a vouched approval besides the operator's passes over unvouched noise", () => {
    assert.deepEqual(
      operatorApproval({ ...staging, author: "agency-builder", roster: record("agent", "jlwaugh"), approvals: ["saadiqbal-dev"], unvouched: ["stranger"] }).outcome,
      "pass",
    );
  });

  test("@multai-builder's approval through the gate counts", () => {
    assert.deepEqual(
      operatorApproval({ ...staging, author: "agency-builder", roster: record("agent", "jlwaugh"), approvals: ["multai-builder"] }).outcome,
      "pass",
    );
  });

  test("an unreadable roster fails closed, approvals or none", () => {
    assert.deepEqual(
      operatorApproval({ ...staging, author: "multi-agency", roster: { status: "unreadable" }, approvals: [] }).outcome,
      "fail",
    );
    assert.deepEqual(
      operatorApproval({ ...staging, author: "multi-agency", roster: { status: "unreadable" }, approvals: ["jlwaugh"] }).outcome,
      "fail",
    );
  });

  test("an agent recorded with no operator fails closed", () => {
    assert.deepEqual(
      operatorApproval({ ...staging, author: "broken-agent", roster: record("agent", null), approvals: ["jlwaugh"] }).outcome,
      "fail",
    );
  });

  test("a self-declared person passes unchecked; owner decision 2026-10-05", () => {
    // No team names agents (owner decision, 2026-10-05: one team only,
    // `internal`, people only), so the roster record decides — and its kind
    // is a declaration the board never verifies. An account recorded as a
    // person therefore passes however it got there: an agent whose join said
    // `kind: "human"` ships on its operator's approval alone. That is the
    // risk the owner accepted by making the roster the one recognition
    // source (#109), not a protection this check provides. A rostered agent
    // still gets the operator check:
    assert.deepEqual(
      operatorApproval({ ...staging, author: "rogue-agent", roster: record("human", null), approvals: ["jlwaugh"] }).outcome,
      "pass",
    );
    assert.deepEqual(
      operatorApproval({ ...staging, author: "new-agent", roster: record("agent", "saadiqbal-dev"), internal: ["saadiqbal-dev"], approvals: ["saadiqbal-dev"] }),
      fail("the only approval is @saadiqbal-dev, @new-agent's operator; an operator's approval alone does not approve their agent's PR"),
    );
  });

  test("team internal unreadable fails closed, even off the roster", () => {
    assert.deepEqual(
      operatorApproval({ ...staging, author: "jlwaugh", roster: record("human", null), internal: null }).outcome,
      "fail",
    );
    assert.deepEqual(
      operatorApproval({ ...staging, author: "stranger", roster: { status: "absent" }, internal: null }).outcome,
      "fail",
    );
  });

  test("a fork, whose run gets no secrets and so no team, is judged on what needs no org token", () => {
    // GitHub refuses a fork's run every repository secret, so its team is
    // unread by design: judged on CODEOWNERS' own logins and OWNER, with the
    // roster still answering for the author.
    assert.deepEqual(
      operatorApproval({ ...staging, author: "stranger", roster: { status: "absent" }, internal: null, fork: true, approvals: [] }).outcome,
      "pass",
    );
    assert.deepEqual(
      operatorApproval({ ...staging, author: "fork-agent", roster: record("agent", "jlwaugh"), internal: null, fork: true, approvals: ["jlwaugh"] }).outcome,
      "pass",
    );
    assert.deepEqual(
      operatorApproval({ ...staging, author: "fork-agent", roster: record("agent", "jlwaugh"), internal: null, fork: true, approvals: [] }).outcome,
      "pass",
    );
    assert.deepEqual(
      operatorApproval({ ...staging, author: "fork-agent", roster: record("agent", "jlwaugh"), internal: null, fork: true, approvals: [], unvouched: ["jlwaugh"] }).outcome,
      "fail",
    );
  });

  test("a record naming no kind fails closed", () => {
    assert.deepEqual(
      operatorApproval({ ...staging, author: "broken-agent", roster: record(null, "jlwaugh"), approvals: ["jlwaugh"] }).outcome,
      "fail",
    );
  });

  test("with no OWNER set, even the owner's approval is discounted", () => {
    assert.deepEqual(
      operatorApproval({ base: "staging", owners: [], author: "multi-agency", roster: record("agent", "jlwaugh"), approvals: ["jlwaugh"] }).outcome,
      "fail",
    );
  });

  test("logins compare case-insensitively", () => {
    // An approval of the operator's counts as theirs however each spells it.
    assert.deepEqual(
      operatorApproval({ base: "staging", owners: [], author: "new-agent", roster: record("agent", "Saadiqbal-Dev"), approvals: ["saadiqbal-dev"] }).outcome,
      "fail",
    );
    assert.deepEqual(
      operatorApproval({ base: "staging", owners: ["jlwaugh"], author: "new-agent", roster: record("agent", "saadiqbal-dev"), approvals: ["JLWAUGH"] }).outcome,
      "pass",
    );
  });

  test("only a PR to staging is judged", () => {
    assert.deepEqual(
      operatorApproval({ base: "main", owners: ["jlwaugh"], author: "new-agent", roster: record("agent", "saadiqbal-dev"), approvals: ["saadiqbal-dev"] }).outcome,
      "pass",
    );
  });
});
