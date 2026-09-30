import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

process.env.GITHUB_TOKEN = "test-token";
const { cycle, coordinatorHealth } = await import("../lib/coordinator.mjs");
const { fence } = await import("../lib/github.mjs");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const REPO = "/repos/MultiAgency/kanban-sandbox";
const terms = fence("terms", { engagement: 5, amount: "1000000", asset: "usdc" });

const seatIssue = (number, labels, dependsOn = [], assignees = []) => ({
  number,
  title: `Write: comparison #${number}`,
  html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/${number}`,
  state: "open",
  updated_at: "2026-09-28T01:00:00Z",
  assignees: assignees.map(login => ({ login })),
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
const board = ({ open = [], closes = [], issues = {}, closedByLabel = {}, threads = {} }) => {
  const state = { calls: [], comments: [], labelPosts: [], patches: [], reactions: {}, unassigns: [] };
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
      if (method === "PATCH") {
        const patch = JSON.parse(options.body);
        state.patches.push({ number: Number(seat[1]), ...patch });
        if (found) found.state = patch.state ?? found.state;
        return json(found ?? {});
      }
      return found ? json(found) : refuse();
    }
    const reactions = u.pathname.match(`${REPO}/issues/comments/(\\d+)/reactions$`);
    if (reactions) {
      const id = Number(reactions[1]);
      if (method === "GET") return json(state.reactions[id] ?? []);
      state.reactions[id] = [...(state.reactions[id] ?? []), { user: { login: "multi-agency" }, content: JSON.parse(options.body).content }];
      return json({});
    }
    const assignees = u.pathname.match(`${REPO}/issues/(\\d+)/assignees$`);
    if (assignees && method === "DELETE") {
      state.unassigns.push({ number: Number(assignees[1]), login: JSON.parse(options.body).assignees[0] });
      return json({});
    }
    const thread = u.pathname.match(`${REPO}/issues/(\\d+)/comments$`);
    if (thread) {
      if (method === "GET") return json(threads[Number(thread[1])] ?? []);
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

describe("closing a seat on its handoff", () => {
  // The seat fixture is stale (updated 2026-09-28), so releaseIfStale would
  // fire every cycle unless the thread holds it back.
  const claimed = number => seatIssue(number, ["in-progress", "skill:review"], [], ["jlwaugh"]);
  const byAuthor = (id, body) => ({ id, user: { login: "jlwaugh" }, html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/40#issuecomment-${id}`, body });
  // The shape seen on the board: valid JSON, closing fence missing.
  const unclosed = "**Handoff:** done\n\n```handoff\n" + JSON.stringify({ payout: { account_id: "reviewer.agency.testnet" } }, null, 2) + "\n}";
  const invalidJson = "**Handoff:** done\n\n```handoff\n{not json}\n```";
  const wellFormed = "**Handoff:** done\n\n" + fence("handoff", { payout: { account_id: "reviewer.agency.testnet" } });

  test("a handoff whose fence is never closed is answered once, and holds the seat", async () => {
    const seat = claimed(40);
    const fake = await runCycle(board({ open: [seat], issues: { 40: seat }, threads: { 40: [byAuthor(9001, unclosed)] } }));

    assert.deepEqual(fake.reactions[9001], [{ user: { login: "multi-agency" }, content: "confused" }]);
    const replies = fake.comments.filter(c => c.number === 40);
    assert.equal(replies.length, 1);
    assert.match(replies[0].body, /@jlwaugh, this handoff can't be read: its ```handoff fence is never closed\. Post a corrected handoff\./);
    assert.deepEqual(fake.patches, [], "the seat is not closed on an unreadable handoff");
    assert.deepEqual(fake.unassigns, [], "the seat is not released over an unreadable handoff");
    assert.deepEqual(fake.comments.filter(c => /No handoff after/.test(c.body)), []);

    // The bot's confused reaction answers it: further cycles stay quiet.
    await runCycle(fake);
    assert.equal(fake.reactions[9001].length, 1);
    assert.equal(fake.comments.filter(c => c.number === 40).length, 1);
    assert.deepEqual(fake.patches, []);
  });

  test("a closed handoff block that is not JSON is answered with that reason", async () => {
    const seat = claimed(41);
    const fake = await runCycle(board({ open: [seat], issues: { 41: seat }, threads: { 41: [byAuthor(9002, invalidJson)] } }));

    assert.deepEqual(fake.reactions[9002], [{ user: { login: "multi-agency" }, content: "confused" }]);
    assert.match(fake.comments.find(c => c.number === 41).body, /its ```handoff block is not valid JSON/);
    assert.deepEqual(fake.patches, []);
  });

  test("prose that mentions ```handoff without opening a block is no handoff at all", async () => {
    const seat = claimed(42);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 42: seat },
      threads: { 42: [byAuthor(9003, "A ```handoff block needs its closing fence on a line of its own.")] },
    }));

    assert.equal(fake.reactions[9003], undefined);
    assert.deepEqual(fake.comments.filter(c => /handoff can't be read/.test(c.body)), []);
    // Nothing was handed off, so the stale sweep applies as it always did.
    assert.deepEqual(fake.unassigns, [{ number: 42, login: "jlwaugh" }]);
    assert.deepEqual(fake.labelPosts.find(w => w.number === 42)?.labels, ["ready"]);
    assert.ok(fake.comments.filter(c => c.number === 42).some(c => /No handoff after 24 hours/.test(c.body)));
  });

  test("a well-formed handoff closes the seat exactly as before", async () => {
    const seat = claimed(43);
    const fake = await runCycle(board({ open: [seat], issues: { 43: seat }, threads: { 43: [byAuthor(9004, wellFormed)] } }));

    assert.deepEqual(fake.reactions[9004], [{ user: { login: "multi-agency" }, content: "+1" }]);
    assert.deepEqual(fake.patches, [{ number: 43, state: "closed", state_reason: "completed" }]);
    assert.deepEqual(fake.comments.filter(c => c.number === 43), []);
  });

  test("a corrected handoff after an unreadable one closes on the readable one", async () => {
    const seat = claimed(44);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 44: seat },
      threads: { 44: [byAuthor(9005, unclosed), byAuthor(9006, wellFormed)] },
    }));

    assert.equal(fake.reactions[9005], undefined);
    assert.deepEqual(fake.reactions[9006], [{ user: { login: "multi-agency" }, content: "+1" }]);
    assert.deepEqual(fake.patches, [{ number: 44, state: "closed", state_reason: "completed" }]);
  });
});
