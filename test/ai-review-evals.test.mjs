import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { checks, ledgerOf } from "../evals/ai-review/checks.mjs";
import { interpolate, reviewConfig, splitArgs } from "../evals/ai-review/workflow.mjs";

describe("the ai-review evals read the workflow itself", () => {
  const config = reviewConfig(readFileSync(new URL("../.github/workflows/ai-review.yml", import.meta.url), "utf8"));

  test("the prompt, the claude_args and the Earlier rounds script are all found", () => {
    // A reformat of ai-review.yml that the extractor can't follow must fail
    // here, not leave the evals running an empty prompt.
    assert.match(config.prompt, /HEAD_SHA:/);
    assert.match(config.prompt, /ai-review-ledger/);
    assert.ok(splitArgs(config.claudeArgs).includes("--allowedTools"));
    assert.match(config.earlierRounds, /ledger\.json/);
    assert.match(config.verdict, /HEAD_SHA/);
    assert.match(config.post, /gh pr comment "\$PR" -R "\$REPO" --body-file summary\.md/);
  });

  test("the review itself runs no command, reads nothing past its checkout, and the checkout keeps no credentials", () => {
    // Any gh command can print the environment's secrets (--jq 'env.X' needs
    // no shell), so the model holds no Bash rule at all.
    const tools = splitArgs(config.claudeArgs)[splitArgs(config.claudeArgs).indexOf("--allowedTools") + 1].split(",");
    assert.ok(!tools.some(t => t.startsWith("Bash")), tools.join(","));
    for (const name of ["Read", "Grep", "Glob"]) assert.ok(tools.includes(`${name}(./**)`) && !tools.includes(name), name);
    assert.match(config.pull, /gh pr diff "\$PR" -R "\$REPO" > review\/pr\.diff/);
    // Within the checkout step itself, not anywhere in the file.
    const text = readFileSync(new URL("../.github/workflows/ai-review.yml", import.meta.url), "utf8");
    const checkout = text.match(/^(\s*)- uses: actions\/checkout@.*\n((?:\1  .*\n|\s*\n)*)/m);
    assert.ok(checkout, "no checkout step");
    assert.match(checkout[2], /^\s+persist-credentials: false$/m);
  });

  test("the evals know every expression the prompt uses, and refuse an unknown one", () => {
    const values = {
      "github.repository": "o/r",
      "github.event.pull_request.number || github.event.issue.number": "1",
      "github.event.pull_request.head.sha": "abc",
      "steps.pr.outputs.sha": "abc",
    };
    assert.doesNotMatch(interpolate(config.prompt, values), /\$\{\{/);
    assert.throws(() => interpolate("${{ secrets.X }}", values), /no value/);
  });

  test("claude_args split like a shell: a quoted tool list stays one argument", () => {
    assert.deepEqual(splitArgs('--max-turns 40\n--allowedTools "Read,Bash(gh pr diff:*)"\n--model m'),
      ["--max-turns", "40", "--allowedTools", "Read,Bash(gh pr diff:*)", "--model", "m"]);
  });
});

describe("what an eval run is judged on", () => {
  const head = "24ec161f53e1af8fb1bda514afc2337564774c00";
  const summary = ledger => `AI review\n\n<!-- ai-review-ledger ${JSON.stringify(ledger)} -->\n`;
  const good = {
    head,
    result: { permission_denials: [] },
    verdict: { sha: head, important: 0 },
    summary: summary({ sha: head, findings: [{ id: "F1", path: "a.mjs", line: 10, severity: "Important", status: "fixed" }] }),
    inline: [],
  };
  const failed = (run, expect) => checks(expect, run).filter(c => !c.note && !c.ok).map(c => c.name);

  test("a clean run passes every contract check", () => {
    assert.deepEqual(failed(good), []);
  });

  test("a refused verdict or summary write fails the contract; refused exploration is only a note", () => {
    const write = { ...good, result: { permission_denials: [{ tool_name: "Edit", tool_input: { file_path: "verdict.json" } }] } };
    assert.deepEqual(failed(write), ["the review ran and none of its own writes was refused"]);
    const post = { ...good, result: { permission_denials: [{ tool_name: "Bash", tool_input: { command: "gh pr comment 1 --body-file summary.md" } }] } };
    assert.deepEqual(failed(post), []);
    const read = { ...good, result: { permission_denials: [{ tool_name: "Bash", tool_input: { command: "gh api repos/o/r/contents/x" } }] } };
    assert.deepEqual(failed(read), []);
    assert.ok(checks({}, read).some(c => c.note));
  });

  test("no verdict, no summary, or a findings list for another head fails the contract", () => {
    assert.ok(failed({ ...good, verdict: null }).includes("the Verdict step left a verdict for this head"));
    assert.ok(failed({ ...good, verdict: { sha: "ffff", important: 0 } }).includes("the Verdict step left a verdict for this head"));
    assert.ok(failed({ ...good, summary: "" }).includes("a summary was posted"));
    assert.ok(failed({ ...good, summary: summary({ sha: "ffff", findings: [] }) }).includes("the summary ends with a findings list for this head"));
    assert.ok(failed({ ...good, summary: summary({ sha: "", findings: [] }) }).includes("the summary ends with a findings list for this head"));
  });

  test("a malformed inline comments file fails the contract without aborting the checks", () => {
    assert.deepEqual(failed({ ...good, inline: { path: "a" } }), ["the inline comments file is an array"]);
    assert.deepEqual(failed({ ...good, inline: [{ path: "a.mjs" }, "text", null] }, { mustNotRaise: [{ path: "a.mjs", word: "x" }] }), []);
  });

  test("with no verdict, an Important count check fails rather than passing on null", () => {
    assert.ok(failed({ ...good, verdict: null }, { importantMax: 0 }).includes("at most 0 Important"));
  });

  test("behavior checks: counts, a flagged range, nothing re-raised, a finding's status", () => {
    const run = {
      ...good,
      verdict: { sha: head, important: 1 },
      inline: [{ path: "s.mjs", line: 72, body: "Bugs, Important: the artifacts response object" }],
    };
    assert.deepEqual(failed(run, { importantMin: 1, mustFlag: [{ path: "s.mjs", from: 65, to: 80, what: "x" }] }), []);
    assert.equal(failed(run, { mustFlag: [{ path: "s.mjs", from: 1, to: 10, what: "x" }] }).length, 1);
    assert.equal(failed(run, { mustNotRaise: [{ path: "s.mjs", word: "ARTIFACTS" }] }).length, 1);
    assert.deepEqual(failed(good, { ledgerStatus: { F1: ["fixed"] } }), []);
    assert.equal(failed(good, { ledgerStatus: { F1: ["open"] } }).length, 1);
  });

  test("the last findings list in a summary is the one that counts; a broken one reads as none", () => {
    assert.equal(ledgerOf(`${summary({ sha: "a", findings: [] })}${summary({ sha: "b", findings: [] })}`).sha, "b");
    assert.equal(ledgerOf("<!-- ai-review-ledger {not json} -->"), null);
  });
});
