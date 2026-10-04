import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_TIMEOUT_MS = "50";
process.env.COORDINATOR_TAKEOVER_MS = "60000";
const { fence, fenced } = await import("../lib/github.mjs");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const TITLE = "MultiAgency coordinator liveness";
const RECORD = "coordinator-live";

// Each import with a fresh query string is a separate coordinator instance,
// with its own id and health — how two deployments share one board here.
const instance = tag => import(`../lib/coordinator.mjs?instance=${tag}`);

const secondsAgo = s => new Date(Date.now() - s * 1000).toISOString();

// A board of issues behind globalThis.fetch. Search and the newest-issues read
// both serve it, so findRecord sees what a real board would; `hidden` keeps an
// issue out of the search index only, like one created seconds ago. Writes are
// logged, so a test can assert an instance made none.
function board({ issues = [], hidden = new Set() } = {}) {
  const writes = [];
  const recordIssue = i => i.title === TITLE && !i.pull_request;
  const searchable = i => recordIssue(i) && !hidden.has(i.number);
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? "GET";
    const { pathname } = new URL(url);
    const json = body => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (pathname === "/search/issues") return json({ items: issues.filter(searchable) });
    if (pathname === "/user") return json({ login: "multi-agency" });
    if (pathname === "/repos/MultiAgency/kanban-sandbox/issues") {
      if (method === "POST") {
        const created = { number: Math.max(0, ...issues.map(i => i.number)) + 1, state: "open", ...JSON.parse(options.body) };
        issues.push(created);
        writes.push({ method, path: pathname, body: created });
        return json(created);
      }
      return json([...issues].sort((a, b) => b.number - a.number));
    }
    const single = pathname.match(/^\/repos\/MultiAgency\/kanban-sandbox\/issues\/(\d+)$/);
    if (single) {
      const found = issues.find(i => i.number === Number(single[1]));
      if (!found) return new Response("no such issue", { status: 404 });
      if (method === "GET") return json(found);
      Object.assign(found, JSON.parse(options.body ?? "{}"));
      writes.push({ method, path: pathname, body: JSON.parse(options.body ?? "{}") });
      return json(found);
    }
    // An empty board answers every other read the coordinator's cycle makes.
    if (method === "GET") return json([]);
    return new Response(`unexpected ${method} ${pathname}`, { status: 404 });
  };
  return { issues, writes };
}

const recordOn = (state, number) => fenced(state.issues.find(i => i.number === number)?.body, RECORD);
const claims = state => writes(state).map(w => fenced(w.body.body, RECORD)).filter(Boolean);
const writes = state => state.writes.filter(w => w.method === "PATCH" && w.body.body !== undefined);
const created = state => state.writes.filter(w => w.method === "POST");

describe("one coordinator per board", () => {
  test("a bare board gains a record issue, closed, and the instance runs", async () => {
    const state = board();
    const a = await instance("bare");
    await a.scheduledCycle();
    assert.equal(a.coordinatorHealth().standby, false);
    assert.equal(a.coordinatorHealth().cycles, 1);
    const [record] = state.issues;
    assert.equal(record.title, TITLE);
    assert.equal(record.state, "closed");
    assert.ok(recordOn(state, record.number), "the record names its writer in a fence");
  });

  test("a second instance against a live record stands by and writes nothing", async () => {
    const state = board();
    const a = await instance("runner");
    const b = await instance("bystander");
    await a.scheduledCycle();
    const record = state.issues[0].number;
    const before = state.writes.length;
    await b.scheduledCycle();
    assert.equal(b.coordinatorHealth().standby, true);
    assert.equal(b.coordinatorHealth().other, recordOn(state, record).id, "standby names who holds the board");
    assert.equal(b.coordinatorHealth().cycles, 0);
    assert.equal(state.writes.length, before, "a standby makes no write at all");
    assert.equal(state.issues.length, 1, "a standby creates no duplicate record");
    // The holder keeps running: its next pass refreshes the record in place.
    const held = recordOn(state, record);
    await a.scheduledCycle();
    assert.equal(a.coordinatorHealth().cycles, 2);
    assert.ok(Date.parse(recordOn(state, record).at) > Date.parse(held.at), "the holder's heartbeat advances");
  });

  test("a record silent past the takeover window is claimed by the next cycle", async () => {
    const state = board({ issues: [{ number: 5, title: TITLE, state: "closed", body: fence(RECORD, { id: "gone", at: secondsAgo(120) }) }] });
    const a = await instance("taker");
    await a.scheduledCycle();
    assert.equal(a.coordinatorHealth().standby, false);
    assert.equal(a.coordinatorHealth().cycles, 1, "the taker's cycle ran");
    assert.notEqual(recordOn(state, 5).id, "gone");
  });

  test("a record that parses to nothing is not liveness: the board is claimed", async () => {
    const unreadable = [
      "a hand-edited body with no fence",
      fence(RECORD, { id: 7, at: "soon" }),
      fence(RECORD, { id: "x", at: "not a time" }),
    ];
    for (const [i, body] of unreadable.entries()) {
      const state = board({ issues: [{ number: 5, title: TITLE, state: "closed", body }] });
      const a = await instance(`unreadable-${i}`);
      await a.scheduledCycle();
      assert.equal(a.coordinatorHealth().standby, false, body);
      assert.equal(claims(state).length, 1, body);
    }
  });

  test("a record the search index has not caught up with is still found", async () => {
    const state = board({ issues: [{ number: 5, title: TITLE, state: "closed", body: fence(RECORD, { id: "runner", at: secondsAgo(5) }) }], hidden: new Set([5]) });
    const a = await instance("finder");
    await a.scheduledCycle();
    assert.equal(a.coordinatorHealth().standby, true);
    assert.equal(a.coordinatorHealth().other, "runner");
    assert.equal(created(state).length, 0, "no duplicate record");
  });

  test("the record is the lowest-numbered issue of that title, never a fresher one", async () => {
    const state = board({
      issues: [
        { number: 3, title: TITLE, state: "closed", body: fence(RECORD, { id: "old", at: secondsAgo(120) }) },
        { number: 7, title: TITLE, state: "closed", body: fence(RECORD, { id: "live", at: secondsAgo(1) }) },
      ],
    });
    const a = await instance("picky");
    await a.scheduledCycle();
    assert.equal(a.coordinatorHealth().standby, false, "#3 is stale, so the board is claimable through it");
    assert.equal(claims(state).length, 1);
    assert.match(state.writes.at(-1).path, /issues\/3$/, "the claim went to #3, not the fresher #7");
  });

  test("a gate that cannot read the board leaves the cycle unrun and says so", async () => {
    globalThis.fetch = async () => new Response("search is down", { status: 500 });
    const a = await instance("blinded");
    await a.scheduledCycle();
    assert.match(a.coordinatorHealth().last_error.message, /500/);
    assert.equal(a.coordinatorHealth().cycles, 0);
    // The error is honest; the next pass retries whatever the board says now.
  });
});
