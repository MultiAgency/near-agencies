import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

process.env.GITHUB_TOKEN = "test-token";
const { cycle, coordinatorHealth } = await import("../lib/coordinator.mjs");
const { fence } = await import("../lib/github.mjs");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const REPO = "/repos/MultiAgency/kanban-sandbox";
const terms = fence("terms", { engagement: 5, amount: "1000000", asset: "usdc" });

const seatIssue = (number, labels, dependsOn = []) => ({
  number,
  title: `Write: comparison #${number}`,
  html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/${number}`,
  state: "open",
  updated_at: "2026-09-28T01:00:00Z",
  assignees: [],
  labels: labels.map(name => ({ name })),
  body: [
    "Turn the research into a comparison.",
    "",
    ...(dependsOn.length ? ["Depends on:", ...dependsOn.map(n => `- [ ] #${n}`), ""] : []),
    terms,
  ].join("\n"),
});

// A fetch stub serving the requests one cycle makes, with a log of everything
// it saw. `closes` lists seats flipped to state "closed" as soon as the open
// list has been served: an owner closing a seat mid-cycle, the race pinned here.
const board = ({ open = [], closes = [], issues = {}, closedByLabel = {} }) => {
  const state = { calls: [], comments: [], labelPosts: [] };
  const serve = async (url, options = {}) => {
    const method = options.method ?? "GET";
    const u = new URL(url);
    state.calls.push(`${method} ${u.pathname}${u.search}`);
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const refuse = () => json({ message: `unexpected request: ${method} ${u.pathname}${u.search}` }, 500);
    if (u.pathname === "/user") return json({ login: "multi-agency" });

    const seat = u.pathname.match(`${REPO}/issues/(\\d+)$`);
    if (seat) {
      const found = issues[Number(seat[1])];
      return found ? json(found) : refuse();
    }
    const thread = u.pathname.match(`${REPO}/issues/(\\d+)/comments$`);
    if (thread) {
      if (method === "GET") return json([]);
      state.comments.push({ number: Number(thread[1]), body: JSON.parse(options.body).body });
      return json({});
    }
    const posted = u.pathname.match(`${REPO}/issues/(\\d+)/labels$`);
    if (posted && method === "POST") {
      state.labelPosts.push({ number: Number(posted[1]), labels: JSON.parse(options.body).labels });
      return json([]);
    }
    const label = u.pathname.match(`${REPO}/issues/(\\d+)/labels/(.+)$`);
    if (label && method === "DELETE") return new Response(null, { status: 204 });
    if (u.pathname === `${REPO}/issues` && method === "GET") {
      const labels = u.searchParams.get("labels");
      if (u.searchParams.get("state") === "closed") return json(closedByLabel[labels] ?? []);
      if (labels) return json([]); // engagement jobs to approve or pay: none here
      for (const number of closes) issues[number].state = "closed";
      return json(open);
    }
    return refuse();
  };
  return { fetch: serve, ...state };
};

// Runs one real cycle against the fake board; a swallowed cycle error would
// otherwise look like a quiet no-op, so fail loudly on it instead.
const runCycle = async fake => {
  globalThis.fetch = fake.fetch;
  await cycle();
  assert.equal(coordinatorHealth().last_error, null, `the cycle failed: ${coordinatorHealth().last_error?.message}`);
  return fake;
};

const labelWrites = (fake, number) => fake.calls.filter(c => c.includes(`/issues/${number}/labels`));

describe("promoting a blocked seat", () => {
  test("a seat closed after the open-list read is not promoted", async () => {
    const issues = {
      10: seatIssue(10, ["in-progress"]),
      20: seatIssue(20, ["blocked", "skill:writing"], [10]),
    };
    issues[10].state = "closed";
    const fake = await runCycle(board({ open: [issues[20]], closes: [20], issues }));

    // Both reads prove the guard path ran: the parent was closed, so promote
    // got past the dependency check and re-read the seat itself.
    assert.ok(fake.calls.includes(`GET ${REPO}/issues/10`), "the dependencies were checked");
    assert.ok(fake.calls.includes(`GET ${REPO}/issues/20`), "the seat was re-read before promoting");
    assert.deepEqual(labelWrites(fake, 20), []);
    assert.deepEqual(fake.comments.filter(c => c.number === 20), []);
  });

  test("an open seat whose dependencies are done is still promoted", async () => {
    const issues = {
      10: seatIssue(10, ["in-progress"]),
      20: seatIssue(20, ["blocked", "skill:writing"], [10]),
    };
    issues[10].state = "closed";
    const fake = await runCycle(board({ open: [issues[20]], issues }));

    assert.deepEqual(fake.labelPosts.find(w => w.number === 20)?.labels, ["ready"]);
    assert.ok(fake.calls.includes(`DELETE ${REPO}/issues/20/labels/blocked`));
    const invite = fake.comments.find(c => c.number === 20);
    assert.match(invite.body, /Dependencies #10 are done/);
    assert.match(invite.body, /`\/claim`/);
  });
});

describe("tidying closed seats", () => {
  test("a closed seat keeps none of ready, blocked or in-progress", async () => {
    const issues = {
      30: seatIssue(30, ["in-progress", "skill:writing"]),
      31: seatIssue(31, ["ready", "skill:writing"]),
      32: seatIssue(32, ["blocked", "skill:writing"]),
    };
    for (const issue of Object.values(issues)) issue.state = "closed";
    const fake = await runCycle(board({
      issues,
      closedByLabel: { "in-progress": [issues[30]], ready: [issues[31]], blocked: [issues[32]] },
    }));

    assert.ok(fake.calls.includes(`DELETE ${REPO}/issues/30/labels/in-progress`));
    assert.ok(fake.calls.includes(`DELETE ${REPO}/issues/31/labels/ready`));
    assert.ok(fake.calls.includes(`DELETE ${REPO}/issues/32/labels/blocked`));
  });
});
