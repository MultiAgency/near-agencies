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
// `threads` holds each seat's comments; the bot's replies join its thread, so a
// later cycle sees them as it would on GitHub.
const board = ({ open = [], closes = [], issues = {}, closedByLabel = {}, threads = {} }) => {
  const state = { calls: [], comments: [], labelPosts: [], patches: [], reactions: {}, unassigns: [], assigns: [] };
  let nextId = 1;
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
    if (assignees && method === "POST") {
      state.assigns.push({ number: Number(assignees[1]), login: JSON.parse(options.body).assignees[0] });
      return json({});
    }
    const thread = u.pathname.match(`${REPO}/issues/(\\d+)/comments$`);
    if (thread) {
      const number = Number(thread[1]);
      if (method === "GET") return json(threads[number] ?? []);
      const body = JSON.parse(options.body).body;
      state.comments.push({ number, body });
      const at = new Date().toISOString();
      (threads[number] ??= []).push({
        id: nextId, user: { login: "multi-agency" }, body, created_at: at, updated_at: at,
        html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/${number}#issuecomment-${nextId++}`,
      });
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

describe("settling claims", () => {
  // The taken seat reads as claimed just now, so the stale sweep stays out of the way.
  const ready = number => seatIssue(number, ["ready", "skill:writing", "agent-eligible"]);
  const claim = (number, id, login) => ({
    id, user: { login }, body: "/claim",
    created_at: "2026-09-30T21:00:00Z", updated_at: "2026-09-30T21:00:00Z",
    html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/${number}#issuecomment-${id}`,
  });
  const replies = (fake, number) => fake.comments.filter(c => c.number === number).map(c => c.body);

  test("two /claims on one ready seat: the first wins, the loser is refused naming the winner", async () => {
    const seat = ready(50);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 50: seat },
      threads: { 50: [claim(50, 9101, "multi-agency"), claim(50, 9102, "jlwaugh")] },
    }));

    assert.deepEqual(fake.assigns, [{ number: 50, login: "multi-agency" }]);
    assert.deepEqual(fake.reactions[9101], [{ user: { login: "multi-agency" }, content: "+1" }]);
    assert.deepEqual(fake.reactions[9102], [{ user: { login: "multi-agency" }, content: "-1" }]);
    assert.equal(replies(fake, 50).length, 2);
    assert.ok(replies(fake, 50)[0].startsWith("Claimed by @multi-agency."), replies(fake, 50)[0]);
    assert.equal(replies(fake, 50)[1], "@jlwaugh can't claim this task: @multi-agency claimed it first.");
    assert.deepEqual(fake.labelPosts.find(w => w.number === 50)?.labels, ["in-progress"]);
    assert.ok(fake.calls.includes(`DELETE ${REPO}/issues/50/labels/ready`));

    await runCycle(fake);
    assert.equal(replies(fake, 50).length, 2, "both claims are answered: later cycles stay quiet");
  });

  test("the winner's own repeat /claim is marked processed, not refused", async () => {
    const seat = ready(52);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 52: seat },
      threads: { 52: [claim(52, 9104, "multi-agency"), claim(52, 9105, "multi-agency")] },
    }));

    assert.deepEqual(fake.assigns, [{ number: 52, login: "multi-agency" }], "assigned once");
    assert.deepEqual(fake.reactions[9104], [{ user: { login: "multi-agency" }, content: "+1" }]);
    assert.deepEqual(fake.reactions[9105], [{ user: { login: "multi-agency" }, content: "+1" }]);
    assert.equal(replies(fake, 52).length, 1, "the win is announced once");
    assert.ok(replies(fake, 52)[0].startsWith("Claimed by @multi-agency."), replies(fake, 52)[0]);
  });

  test("the claimant's re-claim while the seat is in progress is marked processed, not refused", async () => {
    const seat = { ...seatIssue(53, ["in-progress", "skill:writing", "agent-eligible"], [], ["multi-agency"]), updated_at: new Date().toISOString() };
    const fake = await runCycle(board({
      open: [seat],
      issues: { 53: seat },
      threads: { 53: [claim(53, 9106, "multi-agency")] },
    }));

    assert.deepEqual(fake.assigns, [], "a taken seat assigns no one");
    assert.deepEqual(fake.reactions[9106], [{ user: { login: "multi-agency" }, content: "+1" }]);
    assert.deepEqual(replies(fake, 53), [], "the claimant needs no refusal");
  });

  test("a /claim on a seat already in progress is refused naming its claimant", async () => {
    const seat = { ...seatIssue(51, ["in-progress", "skill:writing", "agent-eligible"], [], ["multi-agency"]), updated_at: new Date().toISOString() };
    const fake = await runCycle(board({
      open: [seat],
      issues: { 51: seat },
      threads: { 51: [claim(51, 9103, "jlwaugh")] },
    }));

    assert.deepEqual(fake.assigns, [], "a taken seat assigns no one");
    assert.deepEqual(fake.reactions[9103], [{ user: { login: "multi-agency" }, content: "-1" }]);
    assert.deepEqual(replies(fake, 51), ["@jlwaugh can't claim this task: this task is already claimed by @multi-agency."]);
    assert.deepEqual(labelWrites(fake, 51), [], "the seat keeps its label");
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
  // Claimed just now, so the stale sweep stays out of the way unless a test opts in.
  const claimed = (number, updated_at = new Date().toISOString()) =>
    ({ ...seatIssue(number, ["in-progress", "skill:review"], [], ["jlwaugh"]), updated_at });
  const posted = "2026-09-30T20:14:21Z";
  const byClaimant = (number, id, body, at = posted) => ({
    id, user: { login: "jlwaugh" }, body, created_at: at, updated_at: at,
    html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/${number}#issuecomment-${id}`,
  });
  const valid = "**Handoff:** done\n\n" + fence("handoff", { payout: { account_id: "reviewer.agency.testnet" } });
  // The shape seen on kanban-sandbox#39: valid JSON, closing fence missing.
  const unclosed = valid.replace(/\n```$/, "");
  const replies = (fake, number) => fake.comments.filter(c => c.number === number);

  test("an unclosed handoff is answered once, linking it, and the seat stays open", async () => {
    const seat = claimed(40);
    const handoff = byClaimant(40, 9001, unclosed);
    const fake = await runCycle(board({ open: [seat], issues: { 40: seat }, threads: { 40: [handoff] } }));

    assert.equal(replies(fake, 40).length, 1);
    assert.match(replies(fake, 40)[0].body, /^@jlwaugh, \[this handoff\]\(.+#issuecomment-9001\) can't close the task: its handoff block is never closed/);
    assert.match(replies(fake, 40)[0].body, /Edit it, or post a corrected one/);
    assert.deepEqual(fake.patches, [], "the seat is not closed on an unreadable handoff");

    await runCycle(fake);
    assert.equal(replies(fake, 40).length, 1, "the reply answers it: later cycles stay quiet");
  });

  test("editing the unreadable handoff into a valid one closes the seat (the #39 path)", async () => {
    const seat = claimed(41);
    const handoff = byClaimant(41, 9002, unclosed);
    const fake = await runCycle(board({ open: [seat], issues: { 41: seat }, threads: { 41: [handoff] } }));
    assert.equal(replies(fake, 41).length, 1);

    // The claimant fixes the same comment after the reply.
    handoff.body = valid;
    handoff.updated_at = new Date(Date.now() + 60_000).toISOString();
    await runCycle(fake);

    assert.deepEqual(fake.patches, [{ number: 41, state: "closed", state_reason: "completed" }]);
    assert.deepEqual(fake.reactions[9002], [{ user: { login: "multi-agency" }, content: "+1" }]);
    assert.equal(replies(fake, 41).length, 1, "no second reply");
  });

  test("an edit that is still unreadable is answered again, with the new reason", async () => {
    const seat = claimed(42);
    const handoff = byClaimant(42, 9003, unclosed);
    const fake = await runCycle(board({ open: [seat], issues: { 42: seat }, threads: { 42: [handoff] } }));

    handoff.body = "**Handoff:** done\n\n```handoff\n{not json}\n```";
    handoff.updated_at = new Date(Date.now() + 60_000).toISOString();
    await runCycle(fake);

    assert.equal(replies(fake, 42).length, 2);
    assert.match(replies(fake, 42)[1].body, /its handoff block is not valid JSON/);
    assert.deepEqual(fake.patches, []);
  });

  test("a corrected handoff posted after an unreadable one closes on the new one", async () => {
    const seat = claimed(43);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 43: seat },
      threads: { 43: [byClaimant(43, 9004, unclosed), byClaimant(43, 9005, valid, "2026-09-30T20:20:00Z")] },
    }));

    assert.deepEqual(fake.patches, [{ number: 43, state: "closed", state_reason: "completed" }]);
    assert.deepEqual(fake.reactions[9005], [{ user: { login: "multi-agency" }, content: "+1" }]);
    assert.deepEqual(replies(fake, 43), []);
  });

  test("a valid handoff closes the seat with no reply", async () => {
    const seat = claimed(44);
    const fake = await runCycle(board({ open: [seat], issues: { 44: seat }, threads: { 44: [byClaimant(44, 9006, valid)] } }));

    assert.deepEqual(fake.patches, [{ number: 44, state: "closed", state_reason: "completed" }]);
    assert.deepEqual(replies(fake, 44), []);
  });

  test("a question about the format is not a handoff, and the stale sweep applies as before", async () => {
    const seat = claimed(45, "2026-09-28T01:00:00Z");
    const fake = await runCycle(board({
      open: [seat],
      issues: { 45: seat },
      threads: { 45: [byClaimant(45, 9007, "What should the ```handoff block contain? The example has a sha256 field.")] },
    }));

    assert.deepEqual(fake.comments.filter(c => /can't close the task/.test(c.body)), []);
    assert.deepEqual(fake.unassigns, [{ number: 45, login: "jlwaugh" }]);
    assert.ok(replies(fake, 45).some(c => /No handoff after 24 hours/.test(c.body)));
  });
});
