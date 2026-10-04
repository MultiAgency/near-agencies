import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

process.env.GITHUB_TOKEN = "test-token";
// Every cycle guards, so a test's single cycle always runs the sweep.
process.env.GUARD_SWEEP_MS = "0";
delete process.env.PROPOSER_ACCOUNT;
const { cycle, coordinatorHealth, settlePayouts } = await import("../lib/coordinator.mjs");
const { fence } = await import("../lib/github.mjs");
const { closeVerified } = await import("../lib/guard.mjs");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const REPO = "/repos/MultiAgency/kanban-sandbox";
const terms = fence("terms", { engagement: 5, amount: "1000000", asset: "usdc" });
const NOW = () => new Date().toISOString();

const seatIssue = (number, labels, dependsOn = [], assignees = []) => ({
  number,
  title: `Write: comparison #${number}`,
  html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/${number}`,
  state: "open",
  updated_at: NOW(),
  assignees: assignees.map(login => ({ login })),
  labels: labels.map(name => ({ name })),
  body: [
    "Turn the research into a comparison.",
    "",
    ...(dependsOn.length ? ["Depends on:", ...dependsOn.map(n => `- [ ] #${n}`), ""] : []),
    terms,
  ].join("\n"),
});

// A job epic shaped like assemble.mjs leaves it, with an optional ```team block.
const epicIssue = (number, { labels = ["engagement", "blocked"], team = [], updated_at = NOW() } = {}) => ({
  number,
  title: `Job: comparison #${number}`,
  html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/${number}`,
  state: "closed",
  closed_at: NOW(),
  updated_at,
  assignees: [],
  labels: labels.map(name => ({ name })),
  body: [
    "Hire a team to write a comparison.",
    "",
    fence("engagement", { org: "acme", deposit: { amount: "3000000", transaction: "tx1" } }),
    ...(team.length ? [
      "",
      "## Team",
      "",
      ...team.map(m => `- [ ] #${m.issue} — 1 USDC`),
      "",
      fence("team", { committed: "1000000", members: team }),
    ] : []),
  ].join("\n"),
});

const labeled = (actor, name, at = NOW()) => ({ event: "labeled", label: { name }, actor: { login: actor }, created_at: at });
const unlabeled = (actor, name, at = NOW()) => ({ event: "unlabeled", label: { name }, actor: { login: actor }, created_at: at });
const closedEvt = (actor, at = NOW()) => ({ event: "closed", actor: { login: actor }, created_at: at });

// A fetch stub serving the requests a cycle makes, with a log of everything it
// saw. `roles` maps logins to GitHub permission roles (everyone else reads, so
// only the bot and the listed owners are trusted). `events` holds each issue's
// event list; the stub's own label writes join it, as on GitHub. `epics` lists
// engagement issues for the `state=all&since=` reads, filtered like GitHub's
// `since`; `openJobs` the open engagement jobs; `closedByLabel` the closed
// issues a label search returns.
const board = ({ open = [], issues = {}, closedByLabel = {}, threads = {}, events = {}, roles = {}, epics = [], openJobs = [] } = {}) => {
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
        if (found) {
          if (patch.state) found.state = patch.state;
          if (patch.labels) found.labels = patch.labels.map(name => ({ name }));
          if (patch.body) found.body = patch.body;
        }
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
        if (removed) removed.assignees = removed.assignees.filter(a => a.login !== login);
        return json({});
      }
      state.assigns.push({ number: Number(assignees[1]), login });
      const found = issues[Number(assignees[1])];
      if (found && !found.assignees.some(a => a.login === login)) found.assignees.push({ login });
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
      const number = Number(posted[1]);
      const labels = JSON.parse(options.body).labels;
      state.labelPosts.push({ number, labels });
      const found = issues[number];
      if (found) {
        for (const name of labels) {
          if (!found.labels.some(l => l.name === name)) {
            found.labels.push({ name });
            (events[number] ??= []).push(labeled("multi-agency", name));
          }
        }
        found.updated_at = new Date().toISOString();
      }
      return json([]);
    }
    const label = u.pathname.match(`${REPO}/issues/(\\d+)/labels/(.+)$`);
    if (label && method === "DELETE") {
      const number = Number(label[1]);
      const name = decodeURIComponent(label[2]);
      const found = issues[number];
      if (found && found.labels.some(l => l.name === name)) {
        found.labels = found.labels.filter(l => l.name !== name);
        (events[number] ??= []).push(unlabeled("multi-agency", name));
      }
      return new Response(null, { status: 204 });
    }
    const issueEvents = u.pathname.match(`${REPO}/issues/(\\d+)/events$`);
    if (issueEvents && method === "GET") return json(events[Number(issueEvents[1])] ?? []);
    const permission = u.pathname.match(`${REPO}/collaborators/([^/]+)/permission$`);
    if (permission && method === "GET") return json({ role_name: roles[decodeURIComponent(permission[1])] ?? "read" });
    if (u.pathname === `${REPO}/issues` && method === "GET") {
      const labels = u.searchParams.get("labels");
      if (u.searchParams.get("since") !== null) {
        const since = u.searchParams.get("since");
        return json(epics.filter(e => e.updated_at >= since));
      }
      if (u.searchParams.get("state") === "closed") return json(closedByLabel[labels] ?? []);
      if (labels === "engagement") return json(openJobs);
      if (labels) return json([]); // other label searches: none here
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
const commentsOn = (fake, number) => fake.comments.filter(c => c.number === number);
const reopened = (fake, number) => fake.patches.filter(p => p.number === number && p.state === "open");

describe("guarding the gate labels", () => {
  test("a stranger's added gate label is removed again, naming them", async () => {
    const seat = seatIssue(60, ["ready", "skill:writing", "agent-eligible"]);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 60: seat },
      events: { 60: [labeled("tamperer", "agent-eligible")] },
    }));

    assert.ok(fake.calls.includes(`DELETE ${REPO}/issues/60/labels/agent-eligible`), "the label came off");
    const note = commentsOn(fake, 60);
    assert.equal(note.length, 1);
    assert.match(note[0].body, /@tamperer added `agent-eligible`/);
    assert.match(note[0].body, /only the bot or an owner/);

    // The restore is the bot's own write, so the next cycle stays quiet.
    await runCycle(fake);
    assert.equal(commentsOn(fake, 60).length, 1, "no second note");
  });

  test("a stranger's removed gate label is put back", async () => {
    const seat = seatIssue(63, ["ready", "skill:writing"]);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 63: seat },
      events: { 63: [labeled("multi-agency", "agent-eligible"), unlabeled("tamperer", "agent-eligible")] },
    }));

    assert.deepEqual(fake.labelPosts.find(w => w.number === 63)?.labels, ["agent-eligible"]);
    assert.match(commentsOn(fake, 63)[0].body, /@tamperer removed `agent-eligible`/);
  });

  test("a stranger's removed human-only label is put back", async () => {
    const seat = seatIssue(66, ["ready", "skill:review"]);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 66: seat },
      events: { 66: [unlabeled("tamperer", "human-only")] },
    }));

    assert.deepEqual(fake.labelPosts.find(w => w.number === 66)?.labels, ["human-only"]);
    assert.match(commentsOn(fake, 66)[0].body, /@tamperer removed `human-only`/);
  });

  test("the bot's and an owner's own label changes are left alone", async () => {
    const seat = seatIssue(61, ["ready", "skill:writing", "agent-eligible"]);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 61: seat },
      events: { 61: [labeled("multi-agency", "agent-eligible"), labeled("board-owner", "human-only")], },
      roles: { "board-owner": "admin" },
    }));

    assert.deepEqual(labelWrites(fake, 61), [], "no restore writes");
    assert.deepEqual(commentsOn(fake, 61), []);
  });

  test("a stranger's flip they flipped back themselves is left as it stands", async () => {
    // `human-only` was never this seat's gate label: added by a stranger,
    // then removed again by the same stranger. The net change is nothing, so
    // restoring "the latest event" would have the bot add it for good.
    const seat = seatIssue(64, ["ready", "skill:writing", "agent-eligible"]);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 64: seat },
      events: { 64: [labeled("tamperer", "human-only"), unlabeled("tamperer", "human-only")] },
    }));

    assert.deepEqual(labelWrites(fake, 64), [], "nothing was restored");
    assert.deepEqual(commentsOn(fake, 64), []);
  });

  test("a stranger's flip of the seat's own gate label back does not remove it", async () => {
    // `agent-eligible` set by the bot, removed by a stranger, put back by the
    // same stranger: the state is the one the bot left it in, so it stands —
    // the latest event being a stranger's must not read as tampering.
    const seat = seatIssue(65, ["ready", "skill:writing", "agent-eligible"]);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 65: seat },
      events: { 65: [labeled("multi-agency", "agent-eligible"), unlabeled("tamperer", "agent-eligible"), labeled("tamperer", "agent-eligible")] },
    }));

    assert.deepEqual(labelWrites(fake, 65), [], "the label the bot set stays");
    assert.deepEqual(commentsOn(fake, 65), []);
  });

  test("a stranger's change an owner already redid is left alone", async () => {
    const seat = seatIssue(62, ["ready", "skill:writing", "agent-eligible"]);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 62: seat },
      events: { 62: [unlabeled("tamperer", "agent-eligible"), labeled("board-owner", "agent-eligible")] },
      roles: { "board-owner": "admin" },
    }));

    assert.deepEqual(labelWrites(fake, 62), [], "the owner's state stands");
    assert.deepEqual(commentsOn(fake, 62), []);
  });

  test("a gate label set at creation with no label event is left alone", async () => {
    const seat = seatIssue(67, ["ready", "skill:writing", "agent-eligible"]);
    const fake = await runCycle(board({ open: [seat], issues: { 67: seat }, events: { 67: [] } }));

    assert.deepEqual(labelWrites(fake, 67), []);
    assert.deepEqual(commentsOn(fake, 67), []);
  });
});

describe("claims made under a stranger's gate label", () => {
  const claim = (number, id, login) => ({
    id, user: { login }, body: "/claim",
    created_at: "2026-09-30T21:00:00Z", updated_at: "2026-09-30T21:00:00Z",
    html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/${number}#issuecomment-${id}`,
  });

  test("a /claim on a seat whose agent-eligible label a stranger set is refused", async () => {
    const seat = seatIssue(70, ["ready", "skill:writing", "agent-eligible"]);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 70: seat },
      threads: { 70: [claim(70, 9101, "multi-agency")] },
      events: { 70: [labeled("tamperer", "agent-eligible")] },
    }));

    assert.deepEqual(fake.assigns, [], "nothing is assigned on a tainted label");
    assert.deepEqual(fake.reactions[9101], [{ user: { login: "multi-agency" }, content: "-1" }]);
    assert.ok(commentsOn(fake, 70).some(c => /can't claim this task: its `agent-eligible` label was set by @tamperer, not the bot or an owner/.test(c.body)));
    assert.deepEqual(fake.labelPosts.filter(w => w.number === 70), [], "the seat was not claimed");
  });

  test("a /claim on a seat whose human-only label a stranger set is refused", async () => {
    const seat = seatIssue(71, ["ready", "skill:review", "human-only"]);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 71: seat },
      threads: { 71: [claim(71, 9102, "jlwaugh")] },
      events: { 71: [labeled("tamperer", "human-only")] },
    }));

    assert.deepEqual(fake.reactions[9102], [{ user: { login: "multi-agency" }, content: "-1" }]);
    assert.ok(commentsOn(fake, 71).some(c => /can't claim this task: its `human-only` label was set by @tamperer/.test(c.body)));
  });

  test("the bot's own gate label carries the claim", async () => {
    const seat = seatIssue(72, ["ready", "skill:writing", "agent-eligible"]);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 72: seat },
      threads: { 72: [claim(72, 9103, "multi-agency")] },
      events: { 72: [labeled("multi-agency", "agent-eligible")] },
    }));

    assert.deepEqual(fake.assigns, [{ number: 72, login: "multi-agency" }]);
    assert.deepEqual(fake.reactions[9103], [{ user: { login: "multi-agency" }, content: "+1" }]);
    assert.ok(commentsOn(fake, 72)[0].body.startsWith("Claimed by @multi-agency."));
  });

  test("a native assignment under a stranger's gate label is refused", async () => {
    const seat = seatIssue(74, ["ready", "skill:writing", "agent-eligible"], [], ["multi-agency"]);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 74: seat },
      events: { 74: [labeled("tamperer", "agent-eligible")] },
    }));

    assert.deepEqual(fake.unassigns, [{ number: 74, login: "multi-agency" }]);
    assert.ok(commentsOn(fake, 74).some(c => /can't claim this task: its `agent-eligible` label was set by @tamperer/.test(c.body)));
    assert.deepEqual(fake.labelPosts.filter(w => w.number === 74), [], "the seat stays ready");
  });

  test("a native assignment under the bot's own gate label is accepted", async () => {
    const seat = seatIssue(75, ["ready", "skill:writing", "agent-eligible"], [], ["multi-agency"]);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 75: seat },
      events: { 75: [labeled("multi-agency", "agent-eligible")] },
    }));

    assert.deepEqual(fake.unassigns, []);
    assert.deepEqual(fake.labelPosts.find(w => w.number === 75)?.labels, ["in-progress"]);
    assert.ok(commentsOn(fake, 75)[0].body.startsWith("Claimed by @multi-agency."));
  });
});

describe("job epics closed by hand", () => {
  test("a stranger-closed epic is reopened untouched, with a comment", async () => {
    const epic = epicIssue(80);
    const fake = await runCycle(board({
      issues: { 80: epic },
      closedByLabel: { "engagement,blocked": [epic] },
      events: { 80: [closedEvt("tamperer")] },
    }));

    assert.equal(reopened(fake, 80).length, 1, "the epic is open again");
    assert.match(commentsOn(fake, 80)[0].body, /@tamperer closed this job by hand/);
    assert.deepEqual(fake.patches.filter(p => p.number === 80 && p.labels), [], "nothing was settled on it");
    assert.equal(epic.labels.some(l => l.name === "blocked"), true, "it keeps `blocked`");
  });

  test("an epic the bot closed settles as before", async () => {
    const epic = epicIssue(81, { team: [{ issue: 82, key: "write", amount: "1000000" }] });
    const task = { ...seatIssue(82, ["in-progress", "skill:writing"]), state: "closed", closed_at: NOW() };
    const fake = await runCycle(board({
      issues: { 81: epic, 82: task },
      closedByLabel: { "engagement,blocked": [epic] },
      events: { 81: [closedEvt("multi-agency")] },
    }));

    assert.deepEqual(reopened(fake, 81), [], "the bot's close stands");
    assert.deepEqual(fake.patches.find(p => p.number === 81)?.labels, ["engagement"], "`blocked` comes off");
  });

  test("an epic an owner closed settles too", async () => {
    const epic = epicIssue(83);
    const fake = await runCycle(board({
      issues: { 83: epic },
      closedByLabel: { "engagement,blocked": [epic] },
      events: { 83: [closedEvt("board-owner")] },
      roles: { "board-owner": "admin" },
    }));

    assert.deepEqual(reopened(fake, 83), []);
    assert.deepEqual(fake.patches.find(p => p.number === 83)?.labels, ["engagement"]);
  });

  test("a stranger-closed epic without a team is reopened by the epic audit", async () => {
    const epic = epicIssue(85, { labels: ["engagement"] });
    const fake = await runCycle(board({
      issues: { 85: epic },
      epics: [epic],
      events: { 85: [closedEvt("tamperer")] },
    }));

    assert.equal(reopened(fake, 85).length, 1, "the epic is open again");
    assert.match(commentsOn(fake, 85)[0].body, /@tamperer closed this job by hand/);
  });

  test("the epic audit reads only epics updated since its last pass", async () => {
    const stale = epicIssue(86, { labels: ["engagement"], updated_at: new Date(Date.now() - 25 * 3600_000).toISOString() });
    const fake = await runCycle(board({
      issues: { 86: stale },
      epics: [stale],
      events: { 86: [closedEvt("tamperer")] },
    }));

    assert.deepEqual(reopened(fake, 86), [], "an epic untouched for a day is not re-audited");
    assert.deepEqual(commentsOn(fake, 86), []);
    assert.equal(fake.calls.some(c => c.includes("/issues/86/events")), false, "its events were never read");
  });
});

describe("tasks closed by hand", () => {
  test("a dependent is not promoted onto a stranger-closed task; the task reopens", async () => {
    const parent = { ...seatIssue(90, ["skill:writing"]), state: "closed", closed_at: NOW() };
    const seat = seatIssue(91, ["blocked", "skill:writing"], [90]);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 90: parent, 91: seat },
      events: { 90: [closedEvt("tamperer")] },
    }));

    assert.equal(reopened(fake, 90).length, 1, "the task is open again");
    assert.match(commentsOn(fake, 90)[0].body, /@tamperer closed this task by hand/);
    assert.deepEqual(fake.labelPosts.filter(w => w.number === 91), [], "the dependent was not promoted");
    assert.deepEqual(commentsOn(fake, 91), [], "no claim invitation");
  });

  test("a task an owner closed by hand still unblocks its dependents", async () => {
    const parent = { ...seatIssue(92, ["skill:writing"]), state: "closed", closed_at: NOW() };
    const seat = seatIssue(93, ["blocked", "skill:writing"], [92]);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 92: parent, 93: seat },
      events: { 92: [closedEvt("board-owner")] },
      roles: { "board-owner": "admin" },
    }));

    assert.deepEqual(reopened(fake, 92), [], "the owner's close stands");
    assert.deepEqual(fake.labelPosts.find(w => w.number === 93)?.labels, ["ready"], "the dependent is promoted");
  });

  test("a job does not pay out over a stranger-closed task; the task reopens", async () => {
    const strangerClosed = { ...seatIssue(95, ["skill:writing"]), state: "closed", closed_at: NOW() };
    const botClosed = { ...seatIssue(96, ["skill:writing"]), state: "closed", closed_at: NOW() };
    const job = epicIssue(94, {
      labels: ["engagement"],
      team: [{ issue: 95, key: "one", amount: "1000000" }, { issue: 96, key: "two", amount: "1000000" }],
    });
    const fake = board({
      issues: { 94: job, 95: strangerClosed, 96: botClosed },
      openJobs: [job],
      threads: {
        95: [{
          id: 1, user: { login: "multi-agency" },
          body: `**Handoff:** done\n\n${fence("handoff", { payout: { account_id: "agent.agency.testnet" } })}`,
          created_at: NOW(), updated_at: NOW(),
          html_url: "https://github.com/MultiAgency/kanban-sandbox/issues/95#issuecomment-1",
        }],
        96: [],
      },
      events: { 95: [closedEvt("tamperer")], 96: [closedEvt("multi-agency")] },
    });
    globalThis.fetch = fake.fetch;
    // Direct sweep with its clock past the tests above, which primed the timer.
    await settlePayouts("multi-agency", { now: Date.now() + 121_000 });

    assert.equal(reopened(fake, 95).length, 1, "the hand-closed task is open again");
    assert.match(commentsOn(fake, 95)[0].body, /@tamperer closed this task by hand/);
    assert.deepEqual(fake.patches.filter(p => p.number === 94 && p.state === "closed"), [], "the job did not close as paid");
  });

  test("a job pays over tasks the bot closed, as before", async () => {
    const one = { ...seatIssue(98, ["skill:writing"]), state: "closed", closed_at: NOW() };
    const two = { ...seatIssue(99, ["skill:writing"]), state: "closed", closed_at: NOW() };
    const job = epicIssue(97, {
      labels: ["engagement"],
      team: [{ issue: 98, key: "one", amount: "1000000" }, { issue: 99, key: "two", amount: "1000000" }],
    });
    const fake = board({
      issues: { 97: job, 98: one, 99: two },
      openJobs: [job],
      threads: {
        98: [{
          id: 2, user: { login: "multi-agency" },
          body: `**Handoff:** done\n\n${fence("handoff", { payout: { account_id: "agent.agency.testnet" } })}`,
          created_at: NOW(), updated_at: NOW(),
          html_url: "https://github.com/MultiAgency/kanban-sandbox/issues/98#issuecomment-2",
        }],
        99: [],
      },
      events: { 98: [closedEvt("multi-agency")], 99: [closedEvt("multi-agency")] },
    });
    globalThis.fetch = fake.fetch;
    await settlePayouts("multi-agency", { now: Date.now() + 242_000 });

    assert.deepEqual(reopened(fake, 98), []);
    assert.deepEqual(reopened(fake, 99), []);
    assert.deepEqual(commentsOn(fake, 98), [], "no hold is posted without a proposer");
  });

  // Tidy strips a closed seat's status label, so the reopened task must take
  // up the one its state calls for, or the coordinator never acts on it again.
  test("a reopened claimed task resumes in progress", async () => {
    const claimed = { ...seatIssue(140, [], [], ["multi-agency"]), state: "closed", closed_at: NOW() };
    const seat = seatIssue(141, ["blocked", "skill:writing"], [140]);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 140: claimed, 141: seat },
      events: { 140: [closedEvt("tamperer")] },
    }));

    assert.equal(reopened(fake, 140).length, 1);
    assert.deepEqual(fake.labelPosts.find(w => w.number === 140)?.labels, ["in-progress"], "the claimant keeps working");
  });

  test("a reopened unclaimed task with its dependencies done is ready to claim", async () => {
    const done = { ...seatIssue(142, []), state: "closed", closed_at: NOW() };
    const seat = seatIssue(143, ["blocked", "skill:writing"], [142]);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 142: done, 143: seat },
      events: { 142: [closedEvt("tamperer")] },
    }));

    assert.deepEqual(fake.labelPosts.find(w => w.number === 142)?.labels, ["ready"]);
  });

  test("a reopened unclaimed task with an open dependency is blocked again", async () => {
    const handClosed = { ...seatIssue(144, [], [146]), state: "closed", closed_at: NOW() };
    const seat = seatIssue(145, ["blocked", "skill:writing"], [144]);
    const fake = await runCycle(board({
      open: [seat],
      issues: { 144: handClosed, 145: seat, 146: seatIssue(146, ["in-progress"]) },
      events: { 144: [closedEvt("tamperer")] },
    }));

    assert.deepEqual(fake.labelPosts.find(w => w.number === 144)?.labels, ["blocked"]);
  });
});

describe("verifying a close", () => {
  // state/closedAt/closedBy describe the issue a re-read before reopening
  // would see (closed_by is GitHub's own "who closed this" on the issue).
  const serve = (events, { state = "closed", closedAt = null, closedBy = null } = {}, log = { eventReads: 0, issueReads: 0, comments: 0, patches: 0, labels: 0 }) => {
    globalThis.fetch = async (url, options = {}) => {
      const u = new URL(url);
      const method = options.method ?? "GET";
      const json = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (u.pathname === "/user") return json({ login: "multi-agency" });
      if (u.pathname.endsWith("/events")) { log.eventReads += 1; return json(events); }
      if (u.pathname.match(/\/issues\/\d+$/) && method === "GET") {
        log.issueReads += 1;
        return json({ state, ...(closedAt ? { closed_at: closedAt } : {}), ...(closedBy ? { closed_by: { login: closedBy } } : {}) });
      }
      if (u.pathname.match(/\/collaborators\/[^/]+\/permission$/)) return json({ role_name: "read" });
      if (u.pathname.endsWith("/comments") && method === "POST") { log.comments += 1; return json({}); }
      if (u.pathname.endsWith("/labels") && method === "POST") { log.labels += 1; return json({}); }
      if (method === "PATCH") { log.patches += 1; return json({}); }
      throw new Error(`unexpected request: ${method} ${u.pathname}`);
    };
    return log;
  };

  test("counts a close whose event is not indexed yet, rather than reopening it", async () => {
    const at = NOW();
    const log = serve([], { closedAt: at });
    assert.equal(await closeVerified(30, at), true, "no event yet reads as the coordinator's own close");
    assert.equal(await closeVerified(30, at), true, "and it is checked again rather than trusted");
    assert.equal(log.eventReads, 2, "an unproven close is not memoized");
    assert.equal(log.patches, 0, "nothing was reopened");
  });

  test("reopens a stranger's close once, and reads a trusted close's events once", async () => {
    const at = NOW();
    const log = serve([closedEvt("tamperer")], { state: "closed", closedAt: at });
    assert.equal(await closeVerified(31, at), false, "a stranger's close does not stand");
    assert.equal(log.patches, 1, "reopened once");
    assert.equal(log.comments, 1, "said so once");
    assert.equal(log.labels, 1, "the reopened task takes up a status label again");

    const trusted = serve([closedEvt("multi-agency")]);
    assert.equal(await closeVerified(32, at), true);
    assert.equal(await closeVerified(32, at), true, "the same close is not verified twice");
    assert.equal(trusted.eventReads, 1, "its events were read once");
    assert.equal(await closeVerified(32, new Date(Date.parse(at) + 1000).toISOString()), true, "a new close is verified again");
    assert.equal(trusted.eventReads, 2);
  });

  test("a stranger's close whose event is not indexed yet is reopened all the same", async () => {
    const at = NOW();
    const log = serve([], { closedAt: at, closedBy: "tamperer" });
    assert.equal(await closeVerified(35, at), false, "closed_by says who while the event lags");
    assert.equal(log.patches, 1, "reopened once");
    assert.equal(log.comments, 1, "said so once");
    assert.equal(log.labels, 1, "and the task takes up a status label again");
  });

  test("the coordinator's own close counts before its event is indexed, and is not memoized", async () => {
    const at = NOW();
    const log = serve([], { closedAt: at, closedBy: "multi-agency" });
    assert.equal(await closeVerified(36, at), true, "no flap on the coordinator's fresh close");
    assert.equal(await closeVerified(36, at), true, "and it is checked again rather than trusted");
    assert.equal(log.eventReads, 2, "an unproven close is not memoized");
    assert.equal(log.patches, 0, "nothing was reopened");
  });

  test("a proper close made since the events were read is not undone", async () => {
    const at = NOW();
    const log = serve([closedEvt("tamperer")], { state: "closed", closedAt: new Date(Date.parse(at) + 5000).toISOString() });
    assert.equal(await closeVerified(33, at), false, "the stranger's close still does not count");
    assert.equal(log.patches, 0, "the close that followed stands");
    assert.equal(log.comments, 0);
  });

  test("an issue reopened since the events were read is left as it stands", async () => {
    const at = NOW();
    const log = serve([closedEvt("tamperer")], { state: "open" });
    assert.equal(await closeVerified(34, at), false);
    assert.equal(log.patches, 0, "not reopened again");
  });

  test("a failed epic audit does not lose its window", async () => {
    const epic = epicIssue(87, { labels: ["engagement"] });
    let eventsFail = true;
    const patches = [];
    globalThis.fetch = async (url, options = {}) => {
      const u = new URL(url);
      const method = options.method ?? "GET";
      const json = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (u.pathname === "/user") return json({ login: "multi-agency" });
      if (u.pathname === `${REPO}/issues` && method === "GET") {
        return u.searchParams.get("since") !== null ? json([epic]) : json([]);
      }
      if (u.pathname === `${REPO}/issues/87/events`) {
        if (eventsFail) {
          eventsFail = false;
          return new Response("boom", { status: 500 });
        }
        return json([closedEvt("tamperer")]);
      }
      if (u.pathname === `${REPO}/issues/87` && method === "GET") return json(epic);
      if (u.pathname.match(/\/collaborators\/[^/]+\/permission$/)) return json({ role_name: "read" });
      if (method === "PATCH") { patches.push(u.pathname); return json({}); }
      if (u.pathname.endsWith("/comments") && method === "POST") return json({});
      throw new Error(`unexpected request: ${method} ${u.pathname}`);
    };

    // First pass: the epic's events read fails, the audit throws, and the
    // watermark must stay so the window is audited again.
    await cycle();
    assert.notEqual(coordinatorHealth().last_error, null, "the failing audit surfaced");
    await cycle();
    assert.equal(patches.length, 1, "the window was audited again once the read worked");
  });
});
