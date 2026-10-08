import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

process.env.GITHUB_TOKEN = "test-token";
const { comments, repoAssign, repoUnassign, repoReact, repoReactionsOf } = await import("../lib/github.mjs");

describe("reading comments", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("follows pagination across a thread longer than one page", async () => {
    const urls = [];
    globalThis.fetch = async url => {
      urls.push(String(url));
      const page = Number(new URL(url).searchParams.get("page"));
      const body = page === 1
        ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }))
        : Array.from({ length: 50 }, (_, i) => ({ id: i + 101 }));
      return new Response(JSON.stringify(body));
    };
    const thread = await comments(11);
    assert.equal(thread.length, 150);
    assert.deepEqual(thread.map(c => c.id), Array.from({ length: 150 }, (_, i) => i + 1));
    assert.equal(urls.length, 2);
    const first = new URL(urls[0]);
    assert.equal(first.pathname, "/repos/MultiAgency/kanban-sandbox/issues/11/comments");
    assert.equal(first.searchParams.get("per_page"), "100");
    assert.equal(first.searchParams.get("page"), "1");
    assert.equal(new URL(urls[1]).searchParams.get("page"), "2");
  });

  test("throws rather than dropping comments when there are more pages than it reads", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i }))));
    await assert.rejects(() => comments(11), /more than 5000 comments on issue 11/);
  });
});

// The request shape each sends, and the response shape each returns, checked
// against GitHub's own REST reference for these endpoints (no `gh api`
// access from this environment to capture a live response instead):
// docs.github.com/en/rest/issues/assignees and
// docs.github.com/en/rest/reactions/reactions. The assignees array these two
// return sits on the full issue object already captured for real in
// test/fixtures/github/task-issue-58.json; the reaction array repoReact and
// repoReactionsOf handle has no captured example, so the stub below is
// shaped from the documented fields alone: id, user, content, created_at.
describe("the cross-repo claim writes an auto job's task needs (#189, #212 F7)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const issueWithAssignees = logins => ({ number: 9, assignees: logins.map(login => ({ login })) });

  test("repoAssign POSTs the assignees array to the issue's own endpoint, and returns the updated issue", async () => {
    let seen;
    globalThis.fetch = async (url, options) => {
      seen = { method: options.method, pathname: new URL(url).pathname, body: JSON.parse(options.body) };
      return new Response(JSON.stringify(issueWithAssignees(["agency-builder"])), { status: 201 });
    };
    const issue = await repoAssign("MultiAgency/near-agencies", 9, ["agency-builder"]);
    assert.deepEqual(seen, { method: "POST", pathname: "/repos/MultiAgency/near-agencies/issues/9/assignees", body: { assignees: ["agency-builder"] } });
    assert.deepEqual(issue.assignees.map(a => a.login), ["agency-builder"]);
  });

  test("repoUnassign DELETEs the same endpoint with the same body shape", async () => {
    let seen;
    globalThis.fetch = async (url, options) => {
      seen = { method: options.method, pathname: new URL(url).pathname, body: JSON.parse(options.body) };
      return new Response(JSON.stringify(issueWithAssignees([])), { status: 200 });
    };
    const issue = await repoUnassign("MultiAgency/near-agencies", 9, ["agency-builder"]);
    assert.deepEqual(seen, { method: "DELETE", pathname: "/repos/MultiAgency/near-agencies/issues/9/assignees", body: { assignees: ["agency-builder"] } });
    assert.equal(issue.assignees.length, 0);
  });

  test("repoReact POSTs a content string to the comment's reactions endpoint, and returns the reaction GitHub made", async () => {
    let seen;
    globalThis.fetch = async (url, options) => {
      seen = { method: options.method, pathname: new URL(url).pathname, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ id: 1, node_id: "x", user: { login: "multi-agency" }, content: "+1", created_at: "2026-10-08T00:00:00Z" }), { status: 201 });
    };
    const reaction = await repoReact("MultiAgency/near-agencies", 55, "+1");
    assert.deepEqual(seen, { method: "POST", pathname: "/repos/MultiAgency/near-agencies/issues/comments/55/reactions", body: { content: "+1" } });
    assert.equal(reaction.content, "+1");
  });

  test("repoReactionsOf GETs the same endpoint and returns the array GitHub lists there", async () => {
    let seen;
    globalThis.fetch = async url => {
      seen = new URL(url);
      return new Response(JSON.stringify([{ id: 1, user: { login: "multi-agency" }, content: "+1", created_at: "2026-10-08T00:00:00Z" }]));
    };
    const reactions = await repoReactionsOf("MultiAgency/near-agencies", 55);
    assert.equal(seen.pathname, "/repos/MultiAgency/near-agencies/issues/comments/55/reactions");
    assert.equal(seen.searchParams.get("per_page"), "100");
    assert.deepEqual(reactions.map(r => r.user.login), ["multi-agency"]);
  });
});
