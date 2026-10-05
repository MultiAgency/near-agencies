import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { seat } from "../lib/seats.mjs";
import { taskList, taskListFor, tasksHandler } from "../lib/tasks.mjs";

// Board issues as GitHub returns them, through the same seat() the board read
// uses. The base is a real board issue, captured with
// `gh api repos/MultiAgency/kanban-sandbox/issues/52 > test/fixtures/board-issue-52.json`,
// so the stubs carry GitHub's real shape and a renamed field fails here (#130).
const boardIssue = JSON.parse(readFileSync(new URL("./fixtures/board-issue-52.json", import.meta.url), "utf8"));
const terms = (job, amount) => "```terms\n" + JSON.stringify({ engagement: job, amount }) + "\n```";
const issue = (number, labels, { job = 28, amount = "0", assignees = [], title = `Task ${number}` } = {}) => seat({
  ...boardIssue,
  number,
  title,
  html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/${number}`,
  labels: labels.map(name => ({ ...boardIssue.labels[0], name })),
  assignees: assignees.map(login => ({ login })),
  body: terms(job, amount),
});

const seats = [
  issue(30, ["ready", "skill:research", "agent-eligible"], { amount: "1000000" }),
  issue(31, ["blocked", "skill:writing"], { job: 29 }),
  issue(32, ["in-progress", "skill:code", "agent-eligible"], { assignees: ["multi-agency"] }),
  issue(33, ["ready", "skill:review", "human-only"]),
  issue(34, ["ready", "skill:writing"]),
];
const byNumber = (list, number) => list.find(t => t.number === number);

describe("the open task list", () => {
  test("each task gives its job, state, who it is for, skills, amount and assignee", () => {
    const list = taskList(seats);
    assert.deepEqual(byNumber(list, 30), {
      number: 30,
      title: "Task 30",
      url: "https://github.com/MultiAgency/kanban-sandbox/issues/30",
      job: 28,
      skills: ["skill:research"],
      state: "ready",
      for: "people and agents",
      assignee: null,
      amount: "1000000",
    });
    assert.equal(byNumber(list, 31).state, "blocked");
    assert.equal(byNumber(list, 31).job, 29);
    assert.equal(byNumber(list, 32).state, "in-progress");
    assert.equal(byNumber(list, 32).assignee, "multi-agency");
    assert.equal(byNumber(list, 33).for, "people");
    assert.equal(byNumber(list, 34).for, "people");
    assert.equal(byNumber(list, 33).amount, "0", "a volunteer task keeps its zero amount for the page to name");
  });

  test("an unfiltered entry carries nothing about any member", () => {
    assert.equal("claimable" in taskList(seats)[0], false);
  });
});

describe("the list for a login", () => {
  test("a person can claim a ready, unclaimed task; a blocked or claimed one says why not", () => {
    const list = taskListFor(seats, "jlwaugh");
    assert.equal(byNumber(list, 33).claimable, true, "human-only, ready: open to a person");
    assert.equal(byNumber(list, 33).matches, true, "their review skill covers it");
    assert.equal(byNumber(list, 34).claimable, true);
    assert.equal(byNumber(list, 34).matches, false, "writing is not among their skills");
    assert.equal(byNumber(list, 31).claimable, false);
    assert.match(byNumber(list, 31).reason, /waiting on earlier tasks/);
    assert.equal(byNumber(list, 32).claimable, false);
    assert.match(byNumber(list, 32).reason, /already claimed/);
  });

  test("an agent cannot claim a human-only task or one not marked agent-eligible", () => {
    const list = taskListFor(seats, "multi-agency");
    assert.equal(byNumber(list, 30).claimable, true);
    assert.equal(byNumber(list, 30).matches, true);
    assert.match(byNumber(list, 33).reason, /human-only/);
    assert.match(byNumber(list, 34).reason, /not agent-eligible/);
  });

  test("a login not on the roster claims nothing", () => {
    for (const task of taskListFor(seats, "stranger")) {
      assert.equal(task.claimable, false);
      assert.equal(task.matches, false);
      assert.match(task.reason, /not on the MultiAgency roster/);
    }
  });
});

describe("GET /api/tasks", () => {
  const call = async (query, { limit = (request, response, next) => next() } = {}) => {
    const reads = [];
    const handler = tasksHandler(async () => (reads.push(1), seats), limit);
    const result = {};
    const response = { status(code) { result.status = code; return this; }, json(body) { result.body = body; } };
    await new Promise(resolve => {
      response.json = body => { result.body = body; resolve(); };
      handler({ query }, response, error => { result.error = error; resolve(); });
    });
    return { ...result, reads: reads.length };
  };

  test("lists every open task with no sign-in", async () => {
    const { body, status } = await call({});
    assert.equal(status, undefined);
    assert.equal(body.tasks.length, seats.length);
  });

  test("a login adds claimability for a person and an agent", async () => {
    assert.equal(byNumber((await call({ login: "jlwaugh" })).body.tasks, 33).claimable, true);
    assert.equal(byNumber((await call({ login: "multi-agency" })).body.tasks, 33).claimable, false);
  });

  test("a login that is not a GitHub login gets a 400 and reads nothing", async () => {
    for (const login of ["not a login", "-bad", "a".repeat(40), "", ["a", "b"]]) {
      const { status, body, reads } = await call({ login });
      assert.equal(status, 400, JSON.stringify(login));
      assert.match(body.error, /not a GitHub login/);
      assert.equal(reads, 0);
    }
  });

  test("the login lookup runs behind the rate limit", async () => {
    const { error, reads } = await call({ login: "jlwaugh" }, { limit: (request, response, next) => next(new Error("limited")) });
    assert.equal(error.message, "limited");
    assert.equal(reads, 0);
  });
});
