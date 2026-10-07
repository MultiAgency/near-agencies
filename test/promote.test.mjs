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
  const state = { calls: [], comments: [], labelPosts: [], patches: [], reactions: {}, assigns: [], unassigns: [] };
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
    if (assignees) {
      const login = JSON.parse(options.body).assignees[0];
      if (method === "DELETE") {
        state.unassigns.push({ number: Number(assignees[1]), login });
        const removed = issues[Number(assignees[1])];
        if (removed) {
          removed.assignees = removed.assignees.filter(a => a.login !== login);
          removed.updated_at = new Date().toISOString();
        }
        return json({});
      }
      state.assigns.push({ number: Number(assignees[1]), login });
      // The assignment lands on the issue, as on GitHub, so a later cycle sees it.
      const found = issues[Number(assignees[1])];
      if (found && !found.assignees.some(a => a.login === login)) found.assignees.push({ login });
      if (found) found.updated_at = new Date().toISOString();
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
    // No issue ever changes hands here, so its event list is empty: gate
    // labels set at creation and closes the coordinator itself made.
    const issueEvents = u.pathname.match(`${REPO}/issues/(\\d+)/events$`);
    if (issueEvents && method === "GET") return json([]);
    const posted = u.pathname.match(`${REPO}/issues/(\\d+)/labels$`);
    if (posted && method === "POST") {
      const labels = JSON.parse(options.body).labels;
      state.labelPosts.push({ number: Number(posted[1]), labels });
      // Labels land on the issue, as on GitHub, so a later cycle sees the swap.
      const found = issues[Number(posted[1])];
      if (found) {
        found.labels.push(...labels.map(name => ({ name })));
        found.updated_at = new Date().toISOString();
      }
      return json([]);
    }
    const label = u.pathname.match(`${REPO}/issues/(\\d+)/labels/(.+)$`);
    if (label && method === "DELETE") {
      const found = issues[Number(label[1])];
      if (found) found.labels = found.labels.filter(l => l.name !== decodeURIComponent(label[2]));
      return new Response(null, { status: 204 });
    }
    const permission = u.pathname.match(`${REPO}/collaborators/([^/]+)/permission$`);
    if (permission && method === "GET") return json({ role_name: "read" });
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

  test("a claim on an in-progress seat with no assignee waits for its release instead of winning mid-pass", async () => {
    // The seat is past its claim TTL, so this pass also releases it; the claim
    // is answered once the seat is ready again, not accepted while the stale
    // sweep runs.
    const seat = seatIssue(54, ["in-progress", "skill:writing", "agent-eligible"]);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 54: seat },
      threads: { 54: [claim(54, 9107, "jlwaugh")] },
    }));

    assert.deepEqual(fake.assigns, [], "nothing is assigned outside ready");
    assert.equal(fake.reactions[9107], undefined, "the claim waits for the seat to be ready");
    assert.ok(replies(fake, 54).some(b => /open again/.test(b)), "the stale sweep still releases the seat");
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

  test("a /claim from someone off the roster is refused with where to join", async () => {
    const seat = ready(55);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 55: seat },
      threads: { 55: [claim(55, 9108, "stranger")] },
    }));

    assert.deepEqual(fake.assigns, [], "nothing is assigned to a refused claim");
    assert.deepEqual(replies(fake, 55), [
      "@stranger can't claim this task: not on the MultiAgency roster. Join first at https://demo.multiagency.ai/#/join " +
      "(how it works: https://demo.multiagency.ai/skill.md), then claim again.",
    ]);
  });

  test("a refusal for another reason carries no join link", async () => {
    const seat = seatIssue(56, ["ready", "skill:writing", "human-only"]);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 56: seat },
      threads: { 56: [claim(56, 9109, "multi-agency")] },
    }));

    assert.deepEqual(replies(fake, 56), ["@multi-agency can't claim this task: this task is human-only."]);
  });
});

describe("settling assignments", () => {
  test("a GitHub assignment by someone off the roster is removed, refused with where to join", async () => {
    const seat = seatIssue(57, ["ready", "skill:writing", "agent-eligible"], [], ["stranger"]);
    const fake = await runCycle(board({ open: [seat], issues: { 57: seat } }));

    assert.deepEqual(fake.unassigns, [{ number: 57, login: "stranger" }]);
    assert.deepEqual(fake.comments.filter(c => c.number === 57).map(c => c.body), [
      "@stranger can't claim this task: not on the MultiAgency roster. Join first at https://demo.multiagency.ai/#/join " +
      "(how it works: https://demo.multiagency.ai/skill.md), then claim again.",
    ]);
    assert.deepEqual(labelWrites(fake, 57), [], "never claimed, so never promoted to in-progress");
  });
});

// #166: `ready` is not a guarded label, so a task whose dependency is still
// open can carry it (a stranger with triage swaps `blocked` for `ready`), and
// the claim settlers never looked at the dependencies.
describe("a claim on a task whose dependencies are not done", () => {
  const claim = (number, id, login) => ({
    id, user: { login }, body: "/claim",
    created_at: "2026-09-30T21:00:00Z", updated_at: "2026-09-30T21:00:00Z",
    html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/${number}#issuecomment-${id}`,
  });
  const replies = (fake, number) => fake.comments.filter(c => c.number === number).map(c => c.body);
  const dependent = (number, dependsOn, assignees = []) => seatIssue(number, ["ready", "skill:writing", "agent-eligible"], dependsOn, assignees);

  test("a /claim is refused naming the open dependencies, and assigns no one", async () => {
    const issues = { 10: seatIssue(10, ["in-progress"]), 11: seatIssue(11, ["in-progress"]), 60: dependent(60, [10, 11]) };
    issues[11].state = "closed";
    const fake = await runCycle(board({ open: [issues[60]], issues, threads: { 60: [claim(60, 9201, "multi-agency")] } }));

    assert.deepEqual(fake.assigns, []);
    assert.deepEqual(fake.reactions[9201], [{ user: { login: "multi-agency" }, content: "-1" }]);
    assert.deepEqual(replies(fake, 60), ["@multi-agency can't claim this task: its dependencies #10 aren't done yet."]);
    assert.deepEqual(labelWrites(fake, 60), [], "the task is never moved to in-progress");
  });

  test("a GitHub assignment is removed and refused the same way", async () => {
    const issues = { 10: seatIssue(10, ["in-progress"]), 61: dependent(61, [10], ["multi-agency"]) };
    const fake = await runCycle(board({ open: [issues[61]], issues }));

    assert.deepEqual(fake.unassigns, [{ number: 61, login: "multi-agency" }]);
    assert.deepEqual(replies(fake, 61), ["@multi-agency can't claim this task: its dependencies #10 aren't done yet."]);
    assert.deepEqual(labelWrites(fake, 61), []);
  });

  test("once every dependency is closed, a claim is accepted as before", async () => {
    const issues = { 10: seatIssue(10, ["in-progress"]), 62: dependent(62, [10]) };
    issues[10].state = "closed";
    const fake = await runCycle(board({ open: [issues[62]], issues, threads: { 62: [claim(62, 9202, "multi-agency")] } }));

    assert.deepEqual(fake.assigns, [{ number: 62, login: "multi-agency" }]);
    assert.ok(replies(fake, 62)[0].startsWith("Claimed by @multi-agency."), replies(fake, 62)[0]);
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

describe("refusing a claim on one's own delivered work", () => {
  // skill.md §2: don't claim the review of a task you delivered. The review
  // seat's dependency #40 was delivered by @jlwaugh, so it is closed: a task
  // is ready only once its dependencies are done, and a claim on one whose
  // dependencies are open is refused before this rule is asked (#166).
  const dependency = (assignees = []) => ({ ...seatIssue(40, [], [], assignees), state: "closed", closed_at: "2026-09-30T20:30:00Z" });
  const record = (id, by, login) => ({
    id, user: { login: by }, body: `Claimed by @${login}. Once the work is signed off, 1 USDC is paid to \`x.testnet\`.`,
    created_at: "2026-09-30T20:00:00Z", updated_at: "2026-09-30T20:00:00Z",
    html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/40#issuecomment-${id}`,
  });
  const claim = (id, login) => ({
    id, user: { login }, body: "/claim",
    created_at: "2026-09-30T21:00:00Z", updated_at: "2026-09-30T21:00:00Z",
    html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/50#issuecomment-${id}`,
  });
  const board50 = (on50, extra = {}, dep = dependency(["jlwaugh"])) => {
    const review = seatIssue(50, ["ready", "skill:review", "agent-eligible"], [40]);
    return board({ open: [review], issues: { 40: dep, 50: review }, threads: { 50: on50, ...extra } });
  };
  const accepted50 = fake => {
    assert.deepEqual(fake.assigns, [{ number: 50, login: "multi-agency" }]);
    assert.deepEqual(fake.labelPosts.find(w => w.number === 50)?.labels, ["in-progress"]);
    assert.match(fake.comments.find(c => c.number === 50).body, /Claimed by @multi-agency\. .*`agent\.agency\.testnet`/);
  };

  test("the dependency's assignee is refused with the reason, and the seat stays ready", async () => {
    const fake = await runCycle(board50([claim(9100, "jlwaugh")]));

    const reply = fake.comments.find(c => c.number === 50);
    assert.match(reply.body, /^@jlwaugh can't claim this task: this task reviews #40, which you delivered — a sign-off means someone else checked the work\.$/);
    assert.deepEqual(fake.reactions[9100], [{ user: { login: "multi-agency" }, content: "-1" }]);
    assert.deepEqual(fake.assigns, [], "nothing is assigned to a refused claim");
    assert.deepEqual(labelWrites(fake, 50), [], "the seat stays ready");
  });

  test("the coordinator's claimed record refuses even after the assignee was cleared", async () => {
    const fake = await runCycle(board50([claim(9100, "jlwaugh")], { 40: [record(9000, "multi-agency", "jlwaugh")] }, dependency()));

    assert.match(fake.comments.find(c => c.number === 50).body, /can't claim this task: this task reviews #40, which you delivered/);
    assert.deepEqual(fake.assigns, []);
  });

  test("a claim the stale sweep released stops gating once someone else redelivered", async () => {
    // @jlwaugh claimed #40, the stale sweep released it, @writer claimed and
    // delivered it: the claimant at close delivered #40, not @jlwaugh.
    const dep = { ...dependency(["writer"]), state: "closed", closed_at: "2026-09-30T20:30:00Z" };
    const handoff = (id, by) => ({
      id, user: { login: by },
      body: "**Handoff:** done\n\n" + fence("handoff", { payout: { account_id: "x.testnet" } }),
      created_at: "2026-09-30T20:20:00Z", updated_at: "2026-09-30T20:20:00Z",
      html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/40#issuecomment-${id}`,
    });
    const fake = await runCycle(board50(
      [claim(9103, "jlwaugh")],
      { 40: [record(9002, "multi-agency", "jlwaugh"), record(9003, "multi-agency", "writer"), handoff(9004, "writer")] },
      dep,
    ));

    assert.deepEqual(fake.assigns, [{ number: 50, login: "jlwaugh" }]);
    assert.deepEqual(fake.comments.filter(c => /can't claim this task/.test(c.body)), []);
  });

  test("a claimed record forged by a stranger gates nobody", async () => {
    const fake = await runCycle(board50([claim(9101, "multi-agency")], { 40: [record(9001, "stranger", "jlwaugh")] }, dependency()));

    accepted50(fake);
  });

  test("a roster member who delivered none of the dependencies still claims it", async () => {
    const fake = await runCycle(board50([claim(9101, "multi-agency")]));

    accepted50(fake);
  });

  test("work that only builds on its dependency is not gated: the writer may claim after researching", async () => {
    const research = dependency(["jlwaugh"]);
    const writing = seatIssue(51, ["ready", "skill:writing", "agent-eligible"], [40]);
    const fake = await runCycle(board({ open: [writing], issues: { 40: research, 51: writing }, threads: { 51: [claim(9102, "jlwaugh")] } }));

    assert.deepEqual(fake.assigns, [{ number: 51, login: "jlwaugh" }]);
    assert.deepEqual(fake.comments.filter(c => /can't claim this task/.test(c.body)), []);
  });
});
