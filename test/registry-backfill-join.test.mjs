import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

// This file reads the board the way a full-clone run does: as an owner, not
// as the coordinator. lib/github.mjs caches the token's own login for the
// process, so the identity matrix — who the run reads as, who the board's
// voice belongs to, who merely claims to speak for it — lives here, where
// /user answers an owner for every test. registry-write.test.mjs covers the
// run beside the coordinator, whose token is the coordinator's own.

// Pinned before the lib loads: CI has no gh login to fall back to, and the
// token's value itself reaches nothing — every request this file makes is
// answered by the stub below.
process.env.GITHUB_TOKEN = "test-token";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.COORDINATOR_LOGIN;
});

const { joinIssueAdmission } = await import("../scripts/registry-backfill.mjs");

const ADMITTED = "2026-10-01T00:00:00.000Z";
const COMPLETED = { state: "closed", state_reason: "completed", closed_at: "2026-10-03T00:00:00.000Z" };

// The board: the token's own login (`user`), each login's repository role,
// and the issues and comment threads a lookup asks for.
const board = ({ user = "jlwaugh", roles = {}, issues = {}, threads = {} }) => {
  globalThis.fetch = async url => {
    const u = String(url);
    const json = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (u === "https://api.github.com/user") return json({ login: user });
    const role = u.match(/^https:\/\/api\.github\.com\/repos\/MultiAgency\/kanban-sandbox\/collaborators\/([^/]+)\/permission$/);
    if (role) return json({ role_name: roles[decodeURIComponent(role[1])] ?? "read" });
    const issue = u.match(/^https:\/\/api\.github\.com\/repos\/MultiAgency\/kanban-sandbox\/issues\/(\d+)$/);
    if (issue) return json(issues[issue[1]] ?? {});
    const comments = u.match(/^https:\/\/api\.github\.com\/repos\/MultiAgency\/kanban-sandbox\/issues\/(\d+)\/comments\?/);
    if (comments) return json(threads[comments[1]] ?? []);
    throw new Error(`unexpected fetch: ${url}`);
  };
};

describe("the admission a join issue records", () => {
  test("an owner's run counts the coordinator's **Admitted** comment only once the run names the coordinator", async () => {
    const issues = { 18: COMPLETED };
    const threads = { 18: [{ user: { login: "multi-agency" }, body: "**Admitted** by @owner-jl.", created_at: ADMITTED }] };
    // The bot holds no admin this run could read: without the pin, its
    // comment is nobody the run can vouch for.
    board({ roles: { "multi-agency": "read" }, issues, threads });
    assert.deepEqual(await joinIssueAdmission("18"), { fallback: true, spoken: 1 }, "an unvouched-for comment is no admission, and the commit fallback may date the record instead");
    // Named, it is the board's voice, and its comment's time is the stamp.
    process.env.COORDINATOR_LOGIN = "multi-agency";
    assert.deepEqual(await joinIssueAdmission("18"), { at: ADMITTED });
  });

  test("an owner's own **Admitted** comment counts: the run reads as an owner the board trusts", async () => {
    board({ issues: { 19: COMPLETED }, threads: { 19: [{ user: { login: "jlwaugh" }, body: "**Admitted** by @jlwaugh.", created_at: ADMITTED }] } });
    assert.deepEqual(await joinIssueAdmission("19"), { at: ADMITTED });
  });

  test("a stranger's forged **Admitted** comment counts for nothing", async () => {
    board({
      roles: { "self-closer": "read" },
      issues: { 20: COMPLETED },
      threads: { 20: [{ user: { login: "self-closer" }, body: "**Admitted** by @self-closer.", created_at: "2026-09-01T00:00:00.000Z" }] },
    });
    process.env.COORDINATOR_LOGIN = "multi-agency";
    assert.deepEqual(await joinIssueAdmission("20"), { fallback: true, spoken: 1 }, "the forgery is ignored either way — it dates nothing and stops nothing but the board's own voice");
  });

  test("the latest **Admitted** comment wins: a re-admission re-stamps", async () => {
    board({
      issues: { 21: COMPLETED },
      threads: { 21: [
        { user: { login: "multi-agency" }, body: "**Admitted** by @owner-jl.", created_at: "2026-09-01T00:00:00.000Z" },
        { user: { login: "jlwaugh" }, body: "**Admitted** by @jlwaugh, back on the roster.", created_at: ADMITTED },
      ] },
    });
    process.env.COORDINATOR_LOGIN = "multi-agency";
    assert.deepEqual(await joinIssueAdmission("21"), { at: ADMITTED });
  });

  test("an issue with no admission says so by its state", async () => {
    board({
      issues: {
        22: { state: "open", state_reason: null, closed_at: null },
        23: { state: "closed", state_reason: "not_planned", closed_at: "2026-10-02T00:00:00.000Z" },
        24: COMPLETED,
      },
    });
    process.env.COORDINATOR_LOGIN = "multi-agency";
    assert.deepEqual(await joinIssueAdmission("22"), { why: "is still open and has no admission on it" });
    assert.deepEqual(await joinIssueAdmission("23"), { why: "was closed as not planned" });
    assert.deepEqual(await joinIssueAdmission("24"), { fallback: true, spoken: 0 }, "closed as done with no word of when: the commit fallback may date it");
  });
});
