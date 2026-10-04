import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_TIMEOUT_MS = "50";
const { fence, fenced } = await import("../lib/github.mjs");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const TITLE = "MultiAgency coordinator liveness";
const RECORD = "coordinator-live";
const BOT = "multi-agency";

// Each import with a fresh query string is a separate coordinator instance,
// with its own id and health — how two deployments share one board here. The
// takeover window is read once per instance, so a test can shrink it by
// setting the variable just before its import and restoring it after.
const instance = tag => import(`../lib/coordinator.mjs?instance=${tag}`);

const secondsAgo = s => new Date(Date.now() - s * 1000).toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A board of issues behind globalThis.fetch. Search and the newest-issues read
// both serve it, so findRecord sees what a real board would; `hidden` keeps an
// issue out of the search index only, like one created seconds ago. Writes are
// logged, so a test can assert an instance made none.
function board({ issues = [], hidden = new Set() } = {}) {
  const writes = [];
  const searchable = i => i.title === TITLE && !i.pull_request && !hidden.has(i.number);
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? "GET";
    const { pathname } = new URL(url);
    const json = body => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (pathname === "/search/issues") return json({ items: issues.filter(searchable) });
    if (pathname === "/user") return json({ login: BOT });
    if (pathname === "/repos/MultiAgency/kanban-sandbox/issues") {
      if (method === "POST") {
        const created = { number: Math.max(0, ...issues.map(i => i.number)) + 1, state: "open", user: { login: BOT }, ...JSON.parse(options.body) };
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

// A record issue as the board would hold one: by default authored by the bot,
// since only an issue the bot created is trusted as the record at all.
const record = (number, { id, at, login = BOT } = {}) => ({
  number,
  title: TITLE,
  state: "closed",
  user: { login },
  body: fence(RECORD, { id, at }),
});

const recordOn = (state, number) => fenced(state.issues.find(i => i.number === number)?.body, RECORD);
const claims = state => state.writes.filter(w => w.method === "PATCH" && w.body.body !== undefined);
const created = state => state.writes.filter(w => w.method === "POST");

describe("one coordinator per board", () => {
  test("a bare board gains a record issue, closed, and the instance runs", async () => {
    const state = board();
    const a = await instance("bare");
    await a.scheduledCycle();
    assert.equal(a.coordinatorHealth().standby, false);
    assert.equal(a.coordinatorHealth().cycles, 1);
    const [recordIssue] = state.issues;
    assert.equal(recordIssue.title, TITLE);
    assert.equal(recordIssue.state, "closed");
    assert.ok(recordOn(state, recordIssue.number), "the record names its writer in a fence");
  });

  test("a second instance against a live record stands by and writes nothing", async () => {
    const state = board();
    const a = await instance("runner");
    const b = await instance("bystander");
    await a.scheduledCycle();
    const recordIssue = state.issues[0].number;
    const before = state.writes.length;
    await b.scheduledCycle();
    assert.equal(b.coordinatorHealth().standby, true);
    assert.equal(b.coordinatorHealth().other, recordOn(state, recordIssue).id, "standby names who holds the board");
    assert.equal(b.coordinatorHealth().cycles, 0);
    assert.equal(state.writes.length, before, "a standby makes no write at all");
    assert.equal(state.issues.length, 1, "a standby creates no duplicate record");
    // The holder keeps running: its next pass refreshes the record in place.
    const held = recordOn(state, recordIssue);
    await a.scheduledCycle();
    assert.equal(a.coordinatorHealth().cycles, 2);
    assert.ok(Date.parse(recordOn(state, recordIssue).at) > Date.parse(held.at), "the holder's heartbeat advances");
  });

  test("a record silent past the takeover window is claimed by the next cycle", async () => {
    const state = board({ issues: [record(5, { id: "gone", at: secondsAgo(120) })] });
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
      const state = board({ issues: [{ number: 5, title: TITLE, state: "closed", user: { login: BOT }, body }] });
      const a = await instance(`unreadable-${i}`);
      await a.scheduledCycle();
      assert.equal(a.coordinatorHealth().standby, false, body);
      assert.equal(claims(state).length, 1, body);
    }
  });

  test("a stranger's record issue, however fresh, holds nobody back", async () => {
    const state = board({
      issues: [record(5, { id: "saboteur", at: new Date(Date.now() + 365 * 24 * 3600_000).toISOString(), login: "someone-else" })],
    });
    const a = await instance("unheld");
    await a.scheduledCycle();
    assert.equal(a.coordinatorHealth().standby, false, "a stranger's issue is not the record");
    assert.equal(created(state).length, 1, "the bot opened its own record");
    assert.equal(state.issues.length, 2);
  });

  test("a timestamp ahead of the takeover window is not freshness", async () => {
    const state = board({ issues: [record(5, { id: "liar", at: new Date(Date.now() + 365 * 24 * 3600_000).toISOString() })] });
    const a = await instance("unfooled");
    await a.scheduledCycle();
    assert.equal(a.coordinatorHealth().standby, false);
    assert.notEqual(recordOn(state, 5).id, "liar");
  });

  test("a record the search index has not caught up with is still found", async () => {
    const state = board({ issues: [record(5, { id: "runner", at: secondsAgo(5) })], hidden: new Set([5]) });
    const a = await instance("finder");
    await a.scheduledCycle();
    assert.equal(a.coordinatorHealth().standby, true);
    assert.equal(a.coordinatorHealth().other, "runner");
    assert.equal(created(state).length, 0, "no duplicate record");
  });

  test("the record is the lowest-numbered issue of that title, never a fresher one", async () => {
    const state = board({
      issues: [
        record(3, { id: "old", at: secondsAgo(120) }),
        record(7, { id: "live", at: secondsAgo(1) }),
      ],
    });
    const a = await instance("picky");
    await a.scheduledCycle();
    assert.equal(a.coordinatorHealth().standby, false, "#3 is stale, so the board is claimable through it");
    assert.equal(claims(state).length, 1);
    assert.match(state.writes.at(-1).path, /issues\/3$/, "the claim went to #3, not the fresher #7");
  });

  test("the heartbeat keeps the record fresh while a long cycle runs", async () => {
    process.env.COORDINATOR_TAKEOVER_MS = "600";
    try {
      const state = board();
      const a = await instance("beating");
      let release;
      const slow = a.scheduledCycle(() => new Promise(resolve => { release = resolve; }));
      // The gate's claim lands, then the heartbeat rewrites the record while
      // the cycle it is holding the board for is still running.
      for (let t = 0; claims(state).length < 2 && t < 3000; t += 10) await sleep(10);
      assert.ok(claims(state).length >= 2, "the record was rewritten during the cycle");
      const midCycle = recordOn(state, state.issues[0].number);
      const b = await instance("patient");
      await b.scheduledCycle();
      assert.equal(b.coordinatorHealth().standby, true, "mid-cycle, the board is still held");
      assert.equal(b.coordinatorHealth().other, midCycle.id);
      release();
      await slow;
    } finally {
      process.env.COORDINATOR_TAKEOVER_MS = "60000";
    }
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
