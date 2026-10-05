// Code that reads GitHub, run against responses captured from GitHub itself
// (test/fixtures/github/README.md) rather than stubs written by hand.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { fenced } from "../lib/github.mjs";
import { seat } from "../lib/seats.mjs";
import { taskList } from "../lib/tasks.mjs";

const captured = name => JSON.parse(readFileSync(new URL(`./fixtures/github/${name}`, import.meta.url), "utf8"));
const task = captured("task-issue-58.json");
const job = captured("job-issue-57.json");
const pull = captured("pull-139.json");

describe("a captured task issue", () => {
  test("reads as a seat: terms, labels, skills, assignee", () => {
    const s = seat(task);
    assert.equal(s.number, 58);
    assert.deepEqual(s.terms, { engagement: 57, key: "build", amount: "0", asset: s.terms.asset, repo: "MultiAgency/near-agencies", source: "MultiAgency/near-agencies#149" });
    assert.deepEqual(s.skills, ["skill:code"]);
    assert.deepEqual(s.assignees, ["agency-builder"]);
    assert.deepEqual(s.dependsOn, []);
  });

  test("appears in the open task list as claimed work on its job", () => {
    const [entry] = taskList([seat(task)]);
    assert.equal(entry.job, 57);
    assert.equal(entry.state, "in-progress");
    assert.equal(entry.assignee, "agency-builder");
    assert.equal(entry.for, "people and agents");
    assert.equal(entry.amount, "0");
    assert.equal(entry.url, task.html_url);
  });
});

describe("a captured job issue", () => {
  test("carries an engagement block for a zero-deposit board job", () => {
    const engagement = fenced(job.body, "engagement");
    assert.equal(engagement.channel, "board");
    assert.equal(engagement.deposit.amount, "0");
    assert.equal(engagement.source, "MultiAgency/near-agencies#149");
  });
});

describe("a captured comment list", () => {
  test("is an array of comments with the fields the board code reads", () => {
    const thread = captured("task-issue-58-comments.json");
    assert.ok(Array.isArray(thread) && thread.length > 0);
    for (const c of thread) {
      for (const field of ["id", "body", "html_url", "created_at", "updated_at"]) assert.ok(field in c, `comment lacks ${field}`);
      assert.equal(typeof c.user.login, "string");
    }
  });
});

describe("a captured merged pull request", () => {
  // The payout's pullsProblem reads these (lib/payouts.mjs).
  test("has the fields a payout checks: author, merged, base branch, body", () => {
    assert.equal(typeof pull.user.login, "string");
    assert.equal(pull.merged, true);
    assert.equal(pull.base.ref, "staging");
    assert.equal(typeof pull.body, "string");
    assert.match(pull.html_url, /\/pull\/139$/);
  });
});
