import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

process.env.GITHUB_TOKEN = "test-token";
const { fence } = await import("../lib/github.mjs");
const { idleJobs, idleReport, readySince } = await import("../lib/idle.mjs");
const { seat } = await import("../lib/seats.mjs");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const terms = job => fence("terms", { engagement: job, amount: "1000000", asset: "usdc" });

const seatIssue = (number, { job = 5, labels = ["ready", "agent-eligible"], assignees = [], created_at = "2026-09-28T00:00:00Z" } = {}) => ({
  number,
  title: `Write: comparison #${number}`,
  html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/${number}`,
  state: "open",
  created_at,
  updated_at: created_at,
  assignees: assignees.map(login => ({ login })),
  labels: labels.map(name => ({ name })),
  body: [`Part of job #${job}.`, "", terms(job)].join("\n"),
});

const labeled = (at, name = "ready") => ({ event: "labeled", label: { name }, created_at: at });
const unlabeled = (at, name = "ready") => ({ event: "unlabeled", label: { name }, created_at: at });

// 2026-09-29T01:00:00Z; the threshold under test is 24 hours.
const NOW = Date.parse("2026-09-29T01:00:00Z");
const AFTER = 24 * 3600_000;
const report = (seats, events, options = {}) =>
  idleJobs(seats, async s => events[s.number] ?? [], { now: NOW, after: AFTER, ...options });

describe("readySince", () => {
  test("a seat became claimable at its latest ready label", () => {
    const events = [labeled("2026-09-27T00:00:00Z"), unlabeled("2026-09-27T12:00:00Z"), labeled("2026-09-28T12:00:00Z")];
    assert.equal(readySince(seat(seatIssue(20)), events), Date.parse("2026-09-28T12:00:00Z"));
  });

  test("without a ready label event, its creation counts", () => {
    assert.equal(readySince(seat(seatIssue(20)), []), Date.parse("2026-09-28T00:00:00Z"));
  });
});

describe("idle jobs", () => {
  test("a fresh ready seat is not reported", async () => {
    const events = { 20: [labeled("2026-09-28T23:00:00Z")] }; // ready for 2h
    assert.deepEqual(await report([seat(seatIssue(20))], events), []);
  });

  test("a job whose ready seat outlasted the threshold is reported with job, age and seat count", async () => {
    const events = { 20: [labeled("2026-09-28T00:00:00Z")] }; // ready for 25h
    assert.deepEqual(await report([seat(seatIssue(20))], events), [{ job: 5, oldest_ready_seconds: 90_000, ready_seats: 1 }]);
  });

  test("a seat with no label event ages from its creation", async () => {
    assert.deepEqual(await report([seat(seatIssue(20))], {}), [{ job: 5, oldest_ready_seconds: 90_000, ready_seats: 1 }]);
  });

  test("a released seat counts from its latest ready label, not its first", async () => {
    const events = { 20: [labeled("2026-09-28T00:00:00Z"), unlabeled("2026-09-28T05:00:00Z"), labeled("2026-09-28T20:00:00Z")] };
    assert.deepEqual(await report([seat(seatIssue(20))], events), [], "ready again for 5h only");
  });

  test("the oldest seat of a job sets the age; every unclaimed ready seat counts", async () => {
    const events = { 20: [labeled("2026-09-28T00:00:00Z")], 21: [labeled("2026-09-28T23:00:00Z")] };
    const seats = [seat(seatIssue(21)), seat(seatIssue(20))];
    assert.deepEqual(await report(seats, events), [{ job: 5, oldest_ready_seconds: 90_000, ready_seats: 2 }]);
  });

  test("a claimed seat is not unclaimed work", async () => {
    const events = { 20: [labeled("2026-09-28T00:00:00Z")] };
    const claimed = seat(seatIssue(20, { assignees: ["jlwaugh"] }));
    assert.deepEqual(await report([claimed], events), []);
  });

  test("seats that are not open, ready, or name no job are skipped", async () => {
    const events = { 22: [labeled("2026-09-28T00:00:00Z")], 23: [labeled("2026-09-28T00:00:00Z")] };
    const seats = [
      seat(seatIssue(21, { labels: ["in-progress", "skill:writing"] })),
      seat(seatIssue(23, { labels: ["blocked", "skill:writing"] })),
      seat({ ...seatIssue(22), body: `Part of job #6.\n\n${fence("terms", { amount: "1000000" })}` }),
    ];
    assert.deepEqual(await report(seats, events), []);
  });

  test("jobs are reported separately, most stale first", async () => {
    const events = { 20: [labeled("2026-09-28T00:00:00Z")], 23: [labeled("2026-09-27T19:00:00Z")] }; // 25h and 30h
    const seats = [seat(seatIssue(20)), seat(seatIssue(23, { job: 6 }))];
    assert.deepEqual(await report(seats, events), [
      { job: 6, oldest_ready_seconds: 108_000, ready_seats: 1 },
      { job: 5, oldest_ready_seconds: 90_000, ready_seats: 1 },
    ]);
  });
});

describe("the cached board read behind /api/health", () => {
  test("reads the board once and serves repeat health calls from the cache", async () => {
    const readyAgo = new Date(Date.now() - 25 * 3600_000).toISOString(); // past the 24h default threshold
    const stale = seatIssue(20);
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      const u = new URL(url);
      calls.push(`${options.method ?? "GET"} ${u.pathname}${u.search}`);
      const json = body => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (u.pathname === "/repos/MultiAgency/kanban-sandbox/issues" && u.searchParams.get("state") === "open") return json([stale]);
      const events = u.pathname.match(/^\/repos\/MultiAgency\/kanban-sandbox\/issues\/(\d+)\/events$/);
      if (events) return json([labeled(readyAgo)]);
      return json({ message: `unexpected request: ${u.pathname}` }, 500);
    };

    const expected = Math.round((Date.now() - Date.parse(readyAgo)) / 1000);
    const first = await idleReport();
    assert.deepEqual(first, [{ job: 5, oldest_ready_seconds: expected, ready_seats: 1 }]);
    assert.deepEqual(calls.filter(c => c.includes("/events")).length, 1, "one events read per idle seat");
    assert.deepEqual(await idleReport(), first, "a repeat call is served from the cache");
    assert.equal(calls.length, 2, "no GitHub requests beyond the first read");
  });
});
