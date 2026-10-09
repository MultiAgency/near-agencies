import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

process.env.GITHUB_TOKEN = "test-token";
const { fence } = await import("../lib/github.mjs");
const { isGithubLogin, memberStatus } = await import("../lib/status.mjs");

describe("isGithubLogin", () => {
  test("accepts GitHub logins", () => {
    for (const login of ["a", "multi-agency", "User123", "a".repeat(39)]) assert.equal(isGithubLogin(login), true, login);
  });

  test("refuses anything else, so a login never reaches a search query", () => {
    for (const login of ["", "-lead", "trail-", "two words", "a".repeat(40), "a/b", "a:b", "a\nb", null, undefined]) {
      assert.equal(isGithubLogin(login), false, String(login));
    }
  });
});

describe("memberStatus", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const request = { number: 7, html_url: "https://github.com/MultiAgency/kanban-sandbox/issues/7", body: fence("roster-request", { nonce: "n" }), created_at: "2026-10-01T00:00:00Z", labels: [], state: "open" };
  const searching = items => { globalThis.fetch = async () => new Response(JSON.stringify({ items })); };

  test("no join request reads as none", async () => {
    searching([]);
    assert.deepEqual(await memberStatus("stranger"), { login: "stranger", stage: "none" });
  });

  test("an issue that is not a join request is ignored", async () => {
    searching([{ ...request, body: "just a question" }]);
    assert.equal((await memberStatus("stranger")).stage, "none");
  });

  test("an open request reads as checking, then verified once labelled", async () => {
    searching([request]);
    assert.deepEqual(await memberStatus("stranger"), { login: "stranger", stage: "checking", request: { number: 7, url: request.html_url } });
    searching([{ ...request, labels: [{ name: "roster-verified" }] }]);
    assert.equal((await memberStatus("stranger")).stage, "verified");
  });

  test("a request closed as not planned reads as refused; closed otherwise, none", async () => {
    searching([{ ...request, state: "closed", state_reason: "not_planned" }]);
    assert.equal((await memberStatus("stranger")).stage, "refused");
    searching([{ ...request, state: "closed", state_reason: "completed" }]);
    assert.equal((await memberStatus("stranger")).stage, "none");
  });

  test("the latest join request decides", async () => {
    const older = { ...request, number: 3, state: "closed", state_reason: "not_planned", created_at: "2026-09-01T00:00:00Z" };
    searching([older, request]);
    const status = await memberStatus("stranger");
    assert.equal(status.stage, "checking");
    assert.equal(status.request.number, 7);
  });

  test("a member sees the tasks open to them, split by their skills, and the ones they work on", async () => {
    const task = (number, labels, assignees = []) => ({
      number, title: `Task ${number}`, html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/${number}`, body: fence("terms", { amount: "5" }),
      labels: labels.map(name => ({ name })), assignees: assignees.map(login => ({ login })),
    });
    globalThis.fetch = async () => new Response(JSON.stringify([
      task(1, ["ready", "agent-eligible", "skill:research"]),
      task(2, ["ready", "agent-eligible", "skill:review"]),
      task(3, ["ready", "skill:research"]),
      task(4, ["ready", "agent-eligible", "skill:code"], ["other"]),
      task(5, ["blocked", "agent-eligible", "skill:code"], ["Multi-Agency"]),
      { ...task(6, ["ready", "agent-eligible"]), pull_request: {} },
    ]));
    const status = await memberStatus("MULTI-AGENCY");
    assert.equal(status.stage, "member");
    assert.equal(status.login, "multi-agency");
    assert.equal(status.member.kind, "agent");
    assert.deepEqual(status.tasks.map(t => t.number), [1]);
    assert.deepEqual(status.also.map(t => t.number), [2]);
    assert.deepEqual(status.working.map(t => t.number), [5]);
    assert.deepEqual(status.tasks[0], { number: 1, title: "Task 1", url: "https://github.com/MultiAgency/kanban-sandbox/issues/1", amount: "5", review: false });
    assert.equal(status.also[0].review, true);
  });
});
