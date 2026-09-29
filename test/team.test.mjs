import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { draftFor, isApproval } from "../lib/coordinator.mjs";
import { fence } from "../lib/github.mjs";
import { tasksMade, teamProblem } from "../lib/team.mjs";

const job = (overrides = {}) => ({
  number: 28,
  state: "open",
  body: `**Job** opened by \`org.testnet\`.\n\nA brief.\n\n${fence("engagement", { deposit: { amount: "3000000" } })}`,
  ...overrides,
});
const task = (key, overrides = {}) => ({
  key,
  title: `Task ${key}`,
  body: "Deliver the thing. Acceptance criteria: it is done.",
  amount: "1000000",
  labels: ["skill:research", "agent-eligible"],
  ...overrides,
});

describe("team drafts", () => {
  test("accepts a team that fits the deposit, with dependencies on earlier tasks", () => {
    assert.equal(teamProblem(job(), [
      task("research"),
      task("writing", { labels: ["skill:writing", "agent-eligible"], depends_on: ["research"] }),
      task("review", { amount: "500000", labels: ["skill:review", "human-only"], depends_on: ["writing"] }),
    ]), null);
  });

  test("refuses a job that is not open, not a job, or already has a team", () => {
    assert.match(teamProblem(job({ state: "closed" }), [task("a")]), /is closed/);
    assert.match(teamProblem(job({ body: "no block" }), [task("a")]), /not a job/);
    assert.match(teamProblem(job({ body: `${job().body}\n\n${fence("team", { members: [] })}` }), [task("a")]), /already has a team/);
  });

  test("refuses tasks the board could not run", () => {
    assert.match(teamProblem(job(), []), /no tasks/);
    assert.match(teamProblem(job(), [task("Bad Key")]), /key of lowercase/);
    assert.match(teamProblem(job(), [task("a"), task("a")]), /share the key a/);
    assert.match(teamProblem(job(), [task("a", { body: " " })]), /no body/);
    assert.match(teamProblem(job(), [task("a", { amount: "1.5" })]), /whole number/);
    assert.match(teamProblem(job(), [task("a", { labels: ["agent-eligible"] })]), /exactly one of skill:/);
    assert.match(teamProblem(job(), [task("a", { labels: ["skill:design", "agent-eligible"] })]), /exactly one of skill:/);
    assert.match(teamProblem(job(), [task("a", { labels: ["skill:research"] })]), /agent-eligible and human-only/);
    assert.match(teamProblem(job(), [task("a", { labels: ["skill:research", "agent-eligible", "human-only"] })]), /agent-eligible and human-only/);
    assert.match(teamProblem(job(), [task("a", { labels: ["skill:research", "agent-eligible", "ready"] })]), /labels a team does not set: ready/);
    assert.match(teamProblem(job(), [task("a", { depends_on: ["b"] }), task("b")]), /depends on b, which is not an earlier task/);
  });

  test("refuses a team that pays out more than the deposit", () => {
    assert.match(teamProblem(job(), [task("a", { amount: "2000000" }), task("b", { amount: "1000001" })]),
      /pay 3.000001 USDC, more than the 3 USDC deposit/);
  });

  test("finds the tasks an interrupted run already made, by key and job", () => {
    const made = tasksMade([
      { number: 29, body: fence("terms", { engagement: 28, key: "research" }) },
      { number: 12, body: fence("terms", { engagement: 5, key: "research" }) },
      { number: 30, body: fence("terms", { engagement: 28 }) },
      { number: 31, pull_request: {}, body: fence("terms", { engagement: 28, key: "writing" }) },
      { number: 28, body: null },
    ], 28);
    assert.deepEqual([...made], [["research", 29]]);
  });
});

describe("/approve", () => {
  const comment = (id, body) => ({ id, body, html_url: `https://example/c${id}`, user: { login: "jlwaugh" } });
  const draft = n => comment(n, `**Maintainer:** draft ${n}\n\n\`\`\`team-draft\n${JSON.stringify({ issues: [task(`t${n}`)] })}\n\`\`\``);

  test("recognises the command", () => {
    assert.equal(isApproval(comment(1, "/approve")), true);
    assert.equal(isApproval(comment(1, " /approve looks good")), true);
    assert.equal(isApproval(comment(1, "I approve")), false);
  });

  test("takes the latest draft posted before the command, never a later one", () => {
    const command = comment(4, "/approve");
    const thread = [draft(1), comment(2, "chatter"), draft(3), command, draft(5)];
    const found = draftFor(thread, command);
    assert.equal(found.comment.id, 3);
    assert.deepEqual(found.issues.map(i => i.key), ["t3"]);
    assert.equal(draftFor([command, draft(5)], command), undefined);
  });

  test("reports a draft whose block is not valid JSON, rather than skipping it", () => {
    const broken = comment(1, "```team-draft\n{ not json\n```");
    const command = comment(2, "/approve");
    assert.deepEqual(draftFor([broken, command], command), { comment: broken, issues: null });
  });
});
