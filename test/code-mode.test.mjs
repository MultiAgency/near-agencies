import assert from "node:assert/strict";
import { describe, test } from "node:test";

// The worker folder's own logic, imported from the repository root, where its
// node_modules are not installed — hence code-mode.mjs imports nothing.
import {
  allowedTools, codeAccess, deliversCodeSeat, isCodeSeat, mayClaim,
  GIT_CREDENTIAL_HELPER,
} from "../agents/claude-worker/code-mode.mjs";

const seat = (labels, assignees = []) => ({
  labels: labels.map(name => ({ name })),
  assignees: assignees.map(login => ({ login })),
});

describe("code seat eligibility", () => {
  const codeSeat = seat(["ready", "agent-eligible", "skill:code"]);

  test("a code seat is claimable when the agent has the code skill", () => {
    assert.equal(mayClaim(codeSeat, ["code"]), true);
    assert.equal(mayClaim(codeSeat, ["research", "writing", "code"]), true);
  });

  test("a code seat is not claimable without the code skill", () => {
    assert.equal(mayClaim(codeSeat, ["research", "writing"]), false);
  });

  test("a seat needing a second skill the agent lacks is not claimable", () => {
    const both = seat(["ready", "agent-eligible", "skill:code", "skill:review"]);
    assert.equal(mayClaim(both, ["code"]), false);
    assert.equal(mayClaim(both, ["code", "review"]), true);
  });

  test("the other claim rules still hold on a code seat", () => {
    assert.equal(mayClaim(seat(["agent-eligible", "skill:code"]), ["code"]), false, "not ready");
    assert.equal(mayClaim(seat(["ready", "skill:code"]), ["code"]), false, "not agent-eligible");
    assert.equal(mayClaim(seat(["ready", "agent-eligible", "skill:code"], ["near-builder"]), ["code"]), false, "assigned");
    assert.equal(mayClaim(seat(["ready", "agent-eligible", "human-only", "skill:code"]), ["code"]), false, "human-only");
  });

  test("a code seat is one labelled skill:code", () => {
    assert.equal(isCodeSeat(codeSeat), true);
    assert.equal(isCodeSeat(seat(["ready", "skill:writing"])), false);
  });
});

describe("CODE_ACCESS", () => {
  test("an agent without the code skill has none, whatever CODE_ACCESS says", () => {
    assert.equal(codeAccess(["research", "writing"], undefined), null);
    assert.equal(codeAccess(["research", "writing"], "branch"), null);
  });

  test("fork and branch are the two modes", () => {
    assert.equal(codeAccess(["code"], "fork"), "fork");
    assert.equal(codeAccess(["writing", "code"], "branch"), "branch");
  });

  test("an agent with the code skill must choose one", () => {
    assert.throws(() => codeAccess(["code"], undefined), /CODE_ACCESS is required/);
    assert.throws(() => codeAccess(["code"], ""), /CODE_ACCESS is required/);
    assert.throws(() => codeAccess(["code"], "sudo"), /CODE_ACCESS must be fork or branch/);
  });
});

describe("the git credential helper", () => {
  // gitcredentials(7): git runs a helper that is neither '!'-prefixed nor an
  // absolute path as `git credential-<value>`, and
  // `git credential-gh auth git-credential` does not exist — so a bare
  // "gh auth git-credential" makes every push fail.
  test("git runs it as a shell command, not as git credential-<value>", () => {
    assert.equal(GIT_CREDENTIAL_HELPER.startsWith("!"), true);
  });
});

describe("allowed tools per CODE_ACCESS", () => {
  const n = 14;
  const login = "near-builder";
  const base = [
    "Read(./**)", "Write(./**)", "Edit(./**)", "Glob", "Grep", "WebSearch", "WebFetch",
    "Bash(gh issue view:*)", "Bash(gh issue comment:*)", "Bash(gh api:*)",
    "mcp__multiagency__deliverable_sha256",
  ];

  test("without code mode: the board, the deliverable and research, nothing else", () => {
    assert.deepEqual(allowedTools(null, n, login), base);
  });

  test("branch mode adds only the exact commands the instructions give task 14", () => {
    assert.deepEqual(allowedTools("branch", n, login), [
      ...base,
      "Bash(git clone https://github.com/MultiAgency/near-agencies.git .)",
      "Bash(git checkout:*)", "Bash(git add:*)", "Bash(git commit:*)",
      "Bash(git push -u origin task-14)",
      "Bash(npm ci)", "Bash(npm run check)", "Bash(npm test)",
      "Bash(gh pr create:*)", "Bash(gh pr view:*)",
    ]);
  });

  test("fork mode clones, forks and syncs the agent's fork, not the repository", () => {
    assert.deepEqual(allowedTools("fork", n, login), [
      ...base,
      "Bash(git clone https://github.com/near-builder/near-agencies.git .)",
      "Bash(git checkout:*)", "Bash(git add:*)", "Bash(git commit:*)",
      "Bash(git push -u origin task-14)",
      "Bash(npm ci)", "Bash(npm run check)", "Bash(npm test)",
      "Bash(gh pr create:*)", "Bash(gh pr view:*)",
      "Bash(gh repo fork MultiAgency/near-agencies --clone=false)",
      "Bash(gh repo sync near-builder/near-agencies)",
    ]);
  });

  test("the push is the task's branch only: another task's branch is not pushable", () => {
    const tools = allowedTools("branch", 15, login);
    assert.equal(tools.includes("Bash(git push -u origin task-15)"), true);
    assert.equal(tools.includes("Bash(git push -u origin task-14)"), false);
  });

  test("no mode hands Claude the whole shell, a force-push or an arbitrary clone", () => {
    for (const tools of [allowedTools(null, n, login), allowedTools("fork", n, login), allowedTools("branch", n, login)]) {
      assert.equal(tools.includes("Bash(git status:*)"), false);
      assert.equal(tools.includes("Bash(git config:*)"), false);
      assert.equal(tools.includes("Bash(git push:*)"), false, "push:* would also allow --force and --delete on any branch");
      assert.equal(tools.includes("Bash(git clone:*)"), false, "clone:* accepts -c and --upload-pack, which run commands");
      assert.equal(tools.includes("Bash(npm install:*)"), false);
      assert.equal(tools.includes("Bash(npm publish:*)"), false);
      assert.equal(tools.includes("Bash(gh repo delete:*)"), false);
    }
  });
});

describe("code tools only on a delivered code seat", () => {
  const codeSeat = seat(["ready", "agent-eligible", "skill:code"]);
  const writingSeat = seat(["ready", "agent-eligible", "skill:writing"]);

  test("delivering a code seat is the one task that gets code mode", () => {
    assert.equal(deliversCodeSeat({ action: "deliver", seat: codeSeat }), true);
    assert.equal(deliversCodeSeat({ action: "deliver", seat: codeSeat, revision: true }), true);
  });

  test("claiming a code seat does not: a claim only comments /claim", () => {
    assert.equal(deliversCodeSeat({ action: "claim", seat: codeSeat }), false);
  });

  test("delivering any other seat does not, whatever the agent's skills", () => {
    assert.equal(deliversCodeSeat({ action: "deliver", seat: writingSeat }), false);
    assert.equal(deliversCodeSeat({ action: "deliver", seat: seat([]) }), false);
  });

  test("a code seat assigned to an agent without code mode gets none of it", () => {
    // Native GitHub assignment counts as a claim without a skill check, so a
    // worker without the code skill (codeMode null) can find itself delivering
    // a skill:code seat. It must neither ship it nor hand it out to Claude:
    // the gate is code mode as well as the seat, and the run says on the task
    // why it cannot take it instead.
    assert.equal(deliversCodeSeat({ action: "deliver", seat: codeSeat }), true, "the seat alone would ship it");
    const withoutCodeMode = Boolean(null) && deliversCodeSeat({ action: "deliver", seat: codeSeat });
    assert.equal(withoutCodeMode, false);
    const withCodeMode = Boolean("fork") && deliversCodeSeat({ action: "deliver", seat: codeSeat });
    assert.equal(withCodeMode, true);
    // The same gate, expressed the way worker.mjs runs it.
    assert.equal(allowedTools(withoutCodeMode ? "branch" : null, 14, "near-builder").includes("Bash(npm ci)"), false);
    assert.equal(allowedTools(withCodeMode ? "branch" : null, 14, "near-builder").includes("Bash(npm ci)"), true);
  });
});
