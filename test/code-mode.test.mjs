import assert from "node:assert/strict";
import { describe, test } from "node:test";

// The worker folder's own logic, imported from the repository root, where its
// node_modules are not installed — hence code-mode.mjs imports nothing.
import { allowedTools, codeAccess, isCodeSeat, mayClaim } from "../agents/claude-worker/code-mode.mjs";

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

describe("allowed tools per CODE_ACCESS", () => {
  test("without code mode: the board, the deliverable and research, nothing else", () => {
    assert.deepEqual(allowedTools(null), [
      "Read(./**)", "Write(./**)", "Edit(./**)", "Glob", "Grep", "WebSearch", "WebFetch",
      "Bash(gh issue view:*)", "Bash(gh issue comment:*)", "Bash(gh api:*)",
      "mcp__multiagency__deliverable_sha256",
    ]);
  });

  test("branch mode adds only what shipping a branch and its pull request needs", () => {
    assert.deepEqual(allowedTools("branch"), [
      "Read(./**)", "Write(./**)", "Edit(./**)", "Glob", "Grep", "WebSearch", "WebFetch",
      "Bash(gh issue view:*)", "Bash(gh issue comment:*)", "Bash(gh api:*)",
      "mcp__multiagency__deliverable_sha256",
      "Bash(git clone:*)", "Bash(git checkout:*)", "Bash(git add:*)",
      "Bash(git commit:*)", "Bash(git push:*)",
      "Bash(npm ci)", "Bash(npm run check)", "Bash(npm test)",
      "Bash(gh pr create:*)", "Bash(gh pr view:*)",
    ]);
  });

  test("fork mode is branch mode plus forking the repository", () => {
    assert.deepEqual(allowedTools("fork"), [...allowedTools("branch"), "Bash(gh repo fork:*)"]);
  });

  test("no mode hands Claude the whole shell", () => {
    for (const tools of [allowedTools(null), allowedTools("fork"), allowedTools("branch")]) {
      assert.equal(tools.includes("Bash(git status:*)"), false);
      assert.equal(tools.includes("Bash(git config:*)"), false);
      assert.equal(tools.includes("Bash(npm install:*)"), false);
      assert.equal(tools.includes("Bash(npm publish:*)"), false);
      assert.equal(tools.includes("Bash(gh repo delete:*)"), false);
    }
  });
});
