import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { readFileSync } from "node:fs";

process.env.GITHUB_TOKEN = "test-token";
const { cycle, coordinatorHealth, releaseDecision } = await import("../lib/coordinator.mjs");
const { fence, fenced } = await import("../lib/github.mjs");
const { seat, handoffProblem } = await import("../lib/seats.mjs");
const { byGithub } = await import("../lib/roster.mjs");

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
const board = ({ open = [], closes = [], issues = {}, closedByLabel = {}, threads = {}, events = {} }) => {
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
    const commentRead = u.pathname.match(`${REPO}/issues/comments/(\\d+)$`);
    if (commentRead && method === "GET" && commentRead[1] === "404404") return json({ message: "Not Found" }, 404);
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
    if (issueEvents && method === "GET") return json(events[Number(issueEvents[1])] ?? []);
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

  test("a dependency a stranger closed is reopened and still blocks the claim, as it blocks promote", async () => {
    const issues = { 10: { ...seatIssue(10, ["in-progress"]), state: "closed", closed_at: "2026-09-30T20:00:00Z", closed_by: { login: "stranger" } }, 63: dependent(63, [10]) };
    const fake = await runCycle(board({ open: [issues[63]], issues, threads: { 63: [claim(63, 9203, "multi-agency")] } }));

    assert.deepEqual(fake.assigns, []);
    assert.ok(fake.patches.some(p => p.number === 10 && p.state === "open"), "the stranger's close is undone");
    assert.deepEqual(replies(fake, 63), ["@multi-agency can't claim this task: its dependencies #10 aren't done yet."]);
  });

  // The real shapes (#130), captured 2026-10-07: kanban-sandbox#52, the closed
  // task, and its events — closed by multi-agency at 15:46:09Z.
  test("a real closed task, closed by the bot, counts as done as a dependency", async () => {
    const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
    const issues = { 52: fixture("board-issue-52-closed.json"), 65: dependent(65, [52]) };
    const fake = await runCycle(board({ open: [issues[65]], issues, events: { 52: fixture("board-issue-52-events.json") }, threads: { 65: [claim(65, 9205, "multi-agency")] } }));
    assert.deepEqual(fake.assigns, [{ number: 65, login: "multi-agency" }]);
    assert.deepEqual(fake.patches, [], "nothing on the real task is rewritten");
  });

  test("a dependency the bot closed counts as done", async () => {
    const issues = { 10: { ...seatIssue(10, ["in-progress"]), state: "closed", closed_at: "2026-09-30T20:00:00Z", closed_by: { login: "multi-agency" } }, 64: dependent(64, [10]) };
    const fake = await runCycle(board({ open: [issues[64]], issues, threads: { 64: [claim(64, 9204, "multi-agency")] } }));
    assert.deepEqual(fake.assigns, [{ number: 64, login: "multi-agency" }]);
  });

  test("once every dependency is closed, a claim is accepted as before", async () => {
    const issues = { 10: seatIssue(10, ["in-progress"]), 62: dependent(62, [10]) };
    issues[10].state = "closed";
    const fake = await runCycle(board({ open: [issues[62]], issues, threads: { 62: [claim(62, 9202, "multi-agency")] } }));

    assert.deepEqual(fake.assigns, [{ number: 62, login: "multi-agency" }]);
    assert.ok(replies(fake, 62)[0].startsWith("Claimed by @multi-agency."), replies(fake, 62)[0]);
  });
});

// #166: the release clock ran from the issue's updated_at, which any comment
// moves, and any handoff, even a refused one, stopped it for good.
describe("releasing a stale claim", () => {
  const ago = hours => new Date(Date.now() - hours * 3600_000).toISOString();
  const said = (number, id, login, body, at) => ({
    id, user: { login }, body, created_at: at, updated_at: at,
    html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/${number}#issuecomment-${id}`,
  });
  const claimedRecord = (number, id, at, login = "jlwaugh") => said(number, id, "multi-agency", `Claimed by @${login}. When it is delivered, https://demo.multiagency.ai/#/status/${login} prepares your handoff.`, at);
  const handoff = (number, id, account, at) => said(number, id, "jlwaugh", "**Handoff:** done\n\n" + fence("handoff", { payout: { account_id: account } }), at);
  const round = (number, id, at) => said(number, id, "multi-agency", "**Changes requested** by @reviewer.\n\n" + fence("changes", { review: 99, requested_by: "reviewer", request: "u" }), at);
  // A task claimed by @jlwaugh whose issue was last touched by the latest comment.
  const taken = (number, thread, { auto = false } = {}) => {
    const seat = seatIssue(number, ["in-progress", "skill:writing", "agent-eligible"], [], ["jlwaugh"]);
    seat.updated_at = thread.at(-1)?.created_at ?? ago(72);
    if (auto) seat.body = seat.body.replace(terms, fence("terms", { engagement: 5, amount: "0", asset: "usdc", source: "MultiAgency/near-agencies#600" }));
    return seat;
  };
  const released = (fake, number) => fake.unassigns.some(u => u.number === number);

  test("a comment an hour ago does not restart a claim made three days ago", async () => {
    const thread = [claimedRecord(70, 9301, ago(72)), said(70, 9302, "jlwaugh", "Still working on it.", ago(1))];
    const seat = taken(70, thread);
    const fake = await runCycle(board({ open: [seat], issues: { 70: seat }, threads: { 70: thread } }));
    assert.ok(released(fake, 70), "the claim is released from its own time");
    assert.ok(fake.comments.some(c => c.number === 70 && /No handoff after 24 hours/.test(c.body)));
  });

  test("a claim whose time cannot be read is held, never released at once", async () => {
    const thread = [said(66, 9306, "stranger", "Claimed by @stranger. look-alike", ago(72))];
    const seat = { ...taken(66, thread), updated_at: "not a date" };
    const fake = await runCycle(board({ open: [seat], issues: { 66: seat }, threads: { 66: thread } }));
    assert.equal(released(fake, 66), false);
  });

  test("a claim made an hour ago is not released, whatever the issue's clock says", async () => {
    const thread = [claimedRecord(71, 9303, ago(1))];
    const seat = { ...taken(71, thread), updated_at: ago(72) };
    const fake = await runCycle(board({ open: [seat], issues: { 71: seat }, threads: { 71: thread } }));
    assert.equal(released(fake, 71), false);
  });

  test("a handoff the checks refuse holds nothing: the claim is released after 24 hours", async () => {
    const thread = [claimedRecord(72, 9304, ago(72)), handoff(72, 9305, "wrong.testnet", ago(71))];
    const seat = taken(72, thread);
    const fake = await runCycle(board({ open: [seat], issues: { 72: seat }, threads: { 72: thread } }));
    assert.ok(fake.comments.some(c => c.number === 72 && /can't close the task: its payout account is not/.test(c.body)), "the refusal is still said");
    assert.ok(released(fake, 72));
  });

  test("a handoff that passes holds the claim, however old", async () => {
    const thread = [claimedRecord(73, 9306, ago(72)), handoff(73, 9307, "reviewer.agency.testnet", ago(71))];
    const seat = taken(73, thread, { auto: true });
    const fake = await runCycle(board({ open: [seat], issues: { 73: seat }, threads: { 73: thread } }));
    assert.equal(released(fake, 73), false, "an auto job's task waits on its pull request");
  });

  test("a revision round restarts the clock, and the earlier handoff no longer holds", async () => {
    const early = [claimedRecord(74, 9308, ago(72)), handoff(74, 9309, "reviewer.agency.testnet", ago(71)), round(74, 9310, ago(1))];
    const fresh = taken(74, early, { auto: true });
    const fake = await runCycle(board({ open: [fresh], issues: { 74: fresh }, threads: { 74: early } }));
    assert.equal(released(fake, 74), false, "an hour into the round");

    const later = [claimedRecord(75, 9311, ago(72)), handoff(75, 9312, "reviewer.agency.testnet", ago(71)), round(75, 9313, ago(30))];
    const stale = taken(75, later, { auto: true });
    const second = await runCycle(board({ open: [stale], issues: { 75: stale }, threads: { 75: later } }));
    assert.ok(released(second, 75), "thirty hours into a round nobody answered");
  });

  const pinned = (number, id, url, at) => said(number, id, "jlwaugh", "**Handoff:** done\n\n" + fence("handoff", { payout: { account_id: "reviewer.agency.testnet" }, deliverable: { url, sha256: "0".repeat(64) } }), at);

  test("a handoff whose deliverable can never be read holds nothing: a malformed link, a deleted comment", async () => {
    for (const [number, url] of [[77, "not-a-link"], [78, "https://github.com/MultiAgency/kanban-sandbox/issues/78#issuecomment-404404"]]) {
      const thread = [claimedRecord(number, 9400 + number, ago(72)), pinned(number, 9500 + number, url, ago(71))];
      const seat = taken(number, thread, { auto: true });
      const fake = await runCycle(board({ open: [seat], issues: { [number]: seat }, threads: { [number]: thread } }));
      assert.ok(released(fake, number), url);
      assert.ok(fake.comments.some(c => c.number === number && /can't close the task: the deliverable/.test(c.body)), `${url} is refused, not thrown`);
    }
  });

  test("a deliverable read that fails for now holds the claim for the next sweep", async () => {
    const url = "https://github.com/MultiAgency/kanban-sandbox/issues/79#issuecomment-777";
    const thread = [claimedRecord(79, 9479, ago(72)), pinned(79, 9579, url, ago(71))];
    const seat = taken(79, thread, { auto: true });
    // The decision alone: the stub answers the deliverable read with a 500.
    globalThis.fetch = board({ open: [seat], issues: { 79: seat }, threads: { 79: thread } }).fetch;
    const decision = await releaseDecision({ ...seat, number: 79, updatedAt: seat.updated_at, assignees: ["jlwaugh"], dependsOn: [] });
    assert.equal(decision.release, false);
    assert.match(decision.why, /a handoff that passes the checks holds it/);
  });

  // A review seat: the reviewer claimed it three days ago and is waiting on a
  // revision round of the work seat it reviews.
  const reviewSeat = (number, thread) => {
    const seat = seatIssue(number, ["in-progress", "skill:review", "agent-eligible"], [40], ["jlwaugh"]);
    seat.updated_at = ago(72);
    return seat;
  };
  const workSeat = () => ({ ...seatIssue(40, ["in-progress"], [], ["writer"]), updated_at: ago(1) });

  test("a review seat is not released while its reviewer waits on a revision round", async () => {
    const routed = said(40, 9601, "multi-agency", "**Changes requested** by @jlwaugh, reviewing in #80.\n\n" + fence("changes", { review: 80, requested_by: "jlwaugh", request: "u" }), ago(2));
    const notice = said(80, 9602, "multi-agency", "@jlwaugh, round 2 of #40 is in: https://example.test/x. It passed the handoff checks: sign it off here, or ask for another round.", ago(2));
    const claim = claimedRecord(80, 9600, ago(72));

    const seat = reviewSeat(80);
    const idle = await runCycle(board({ open: [seat], issues: { 80: seat, 40: workSeat() }, threads: { 80: [claim], 40: [] } }));
    assert.ok(released(idle, 80), "no round under way: released after the limit");

    const withRound = reviewSeat(81);
    const underWay = await runCycle(board({ open: [withRound], issues: { 81: withRound, 40: workSeat() }, threads: { 81: [claimedRecord(81, 9610, ago(72))], 40: [{ ...routed, id: 9611, body: routed.body.replace("#80", "#81").replace('"review": 80', '"review": 81') }] } }));
    assert.equal(released(underWay, 81), false, "the routed round on the work seat restarts its reviewer's clock");

    const withNotice = reviewSeat(82);
    const noticed = await runCycle(board({ open: [withNotice], issues: { 82: withNotice, 40: workSeat() }, threads: { 82: [claimedRecord(82, 9620, ago(72)), { ...notice, id: 9621, body: notice.body.replace("#40", "#40") }], 40: [] } }));
    assert.equal(released(noticed, 82), false, "the round's arrival notice restarts it too");
  });

  test("a handoff, a claim record or a round from a stranger counts for nothing", async () => {
    const thread = [
      claimedRecord(76, 9314, ago(72)),
      said(76, 9315, "stranger", "Claimed by @stranger. fake record", ago(1)),
      said(76, 9316, "stranger", "```changes\n{\"review\":1}\n```", ago(1)),
    ];
    const seat = taken(76, thread);
    const fake = await runCycle(board({ open: [seat], issues: { 76: seat }, threads: { 76: thread } }));
    assert.ok(released(fake, 76));
  });
});

// The real shapes, captured 2026-10-05 (#130) and trimmed to what the sweep
// reads: kanban-sandbox#58 and its comments — claimed by @agency-builder at
// 16:21:37Z, its handoff at 16:35:41Z — as the board served them
// (test/fixtures/auto-issue-58*.json).
describe("releasing the captured task #58", () => {
  const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
  const issue58 = fixture("auto-issue-58.json");
  const thread = fixture("auto-issue-58-comments.json");
  const CLAIMED = Date.parse("2026-10-05T16:21:37Z");
  const decide = async (comments, now) => {
    globalThis.fetch = board({ open: [issue58], issues: { 58: issue58 }, threads: { 58: comments } }).fetch;
    return releaseDecision(seat(issue58), { now });
  };
  const hours = h => CLAIMED + h * 3600_000;

  test("with no handoff the claim stands for 24 hours from its record, whatever was said since", async () => {
    const claimOnly = thread.filter(c => /^(\/claim|Claimed by)/.test(c.body.trim()));
    assert.equal(claimOnly.length, 2, "the real /claim and the bot's record");
    assert.equal((await decide(claimOnly, hours(23))).release, false);
    assert.equal((await decide(claimOnly, hours(25))).release, true);
    // The issue's own clock reads the last comment: not the claim's.
    const chatter = [...claimOnly, { ...thread[2], id: 1, body: "Still on it.", created_at: new Date(hours(24)).toISOString() }];
    assert.equal((await decide(chatter, hours(25))).release, true, "a comment an hour ago restarts nothing");
  });

  test("the real handoff, a pull request delivery of an auto task, holds the claim only if it passes", async () => {
    const decision = await decide(thread, hours(48));
    const handoff = thread.find(c => fenced(c.body, "handoff"));
    const problem = await handoffProblem(fenced(handoff.body, "handoff"), byGithub("agency-builder"));
    assert.equal(decision.release, problem !== null, `${problem ?? "the handoff passes"}: ${decision.why}`);
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
