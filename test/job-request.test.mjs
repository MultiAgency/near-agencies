import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { briefOf, isJobRequest, jobRequestRefusal, jobRequestSpec, settleJobRequests } from "../lib/coordinator.mjs";
import { listEngagements, loadEngagement } from "../lib/engagement-state.mjs";
import { chosenDeposit } from "../lib/engagements.mjs";
import { fence, fenced } from "../lib/github.mjs";
import { teamProblem } from "../lib/team.mjs";
import { timeline } from "../lib/timeline.mjs";

// Requests go only to the fetch stubs below; the token just has to resolve.
process.env.GITHUB_TOKEN = "test-token";
// The bot's identity is a deployment fact (BOARD_BOT), not the caller's token:
// every stub below answers /user with a stranger's login to prove it.
process.env.BOARD_BOT = "multi-agency";
// A team's 404 says "not a member" only from the token the org granted; the
// stub serves memberships either way, and one test below drops the grant.
process.env.ORG_TOKEN ??= "org-token";

const BOT = "multi-agency";
const BOARD = "/repos/MultiAgency/kanban-sandbox";

// One board at a time: the roster fixture (npm test's ROSTER_FILE) knows
// multi-agency as an agent and jlwaugh as a person; everything else the stub
// serves. Teams maps `team/login` to a membership body ({state: "active"} or
// {state: "pending"}), or to a status (404 not a member, another = the read
// failed); roles maps a login to its collaborator role.
let epics, issues, comments, threads, roles, teams, createFails, commentsFail, self;

const reset = () => {
  epics = [];
  comments = [];
  threads = {};
  issues = {};
  roles = {};
  teams = {};
  createFails = 0;
  commentsFail = 0;
  self = "jlwaugh";
};

// A request issue: its body is the brief plus the ```job-request block.
const jobRequest = (number, login, title, block, brief = "Build the internal dashboard, volunteer work, two weeks of it at least.") => ({
  number,
  user: { login },
  title,
  state: "open",
  labels: [],
  created_at: "2026-10-05T00:00:00Z",
  html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/${number}`,
  body: `${brief}\n\n\`\`\`job-request\n${JSON.stringify(block)}\n\`\`\``,
});

const epicIssue = (number, login, engagement) => ({
  number,
  user: { login },
  title: "Job: whatever",
  state: "open",
  labels: [{ name: "engagement" }],
  html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/${number}`,
  body: `Brief.\n\n${fence("engagement", engagement)}`,
});

function serveBoard() {
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    const method = options.method ?? "GET";
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    let m;
    if (method === "GET" && u.pathname === "/user") return json({ login: self });
    if (method === "GET" && u.pathname === `${BOARD}/issues` && u.searchParams.get("labels") === "engagement") {
      return json(Object.values(issues).filter(i => (i.labels ?? []).some(l => l.name === "engagement")));
    }
    if ((m = /^\/orgs\/MultiAgency\/teams\/([\w-]+)\/memberships\/([\w.-]+)$/.exec(u.pathname)) && method === "GET") {
      const answer = teams[`${m[1]}/${m[2]}`];
      if (answer && typeof answer === "object") return json(answer);
      if (answer && answer !== 404) return json({ message: "boom" }, answer);
      return json({ message: "Not Found" }, 404);
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/.exec(u.pathname)) && method === "GET") {
      return json({ role_name: roles[m[1]] ?? "read" });
    }
    if (method === "POST" && u.pathname === `${BOARD}/issues`) {
      if (createFails) { createFails -= 1; return json({ message: "boom" }, 500); }
      const opened = JSON.parse(options.body);
      const epic = { number: 500 + epics.length, state: "open", user: { login: BOT }, html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/${500 + epics.length}`, ...opened, labels: opened.labels.map(name => ({ name })) };
      epic.html_url = `https://github.com/MultiAgency/kanban-sandbox/issues/${epic.number}`;
      epics.push(epic);
      issues[epic.number] = epic;
      return json(epic);
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(u.pathname))) {
      const thread = (threads[Number(m[1])] ??= []);
      if (method === "POST") {
        if (commentsFail) { commentsFail -= 1; return json({ message: "boom" }, 500); }
        const posted = { number: Number(m[1]), user: { login: BOT }, ...JSON.parse(options.body) };
        comments.push(posted);
        thread.push(posted);
        return json(posted);
      }
      return json(thread);
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(u.pathname))) {
      const found = issues[Number(m[1])];
      if (!found) return json({ message: "Not Found" }, 404);
      if (method === "PATCH") Object.assign(found, JSON.parse(options.body));
      return json(found);
    }
    throw new Error(`unexpected request: ${method} ${u.pathname}${u.search}`);
  };
}

const openIssues = () => Object.values(issues).filter(i => i.state === "open" && !i.pull_request);
const settle = () => settleJobRequests(BOT, openIssues());
afterEach(() => { globalThis.fetch = realFetch; });

const realFetch = globalThis.fetch;

describe("job requests", () => {
  test("an owner's request opens a job with no deposit and the named repo", async () => {
    reset();
    roles.jlwaugh = "admin";
    issues[800] = jobRequest(800, "jlwaugh", "Build the dashboard", { repo: "MultiAgency/legion-social" });
    serveBoard();
    await settle();
    assert.equal(epics.length, 1);
    const epic = epics[0];
    assert.equal(epic.title, "Job: Build the dashboard");
    const engagement = fenced(epic.body, "engagement");
    assert.equal(engagement.channel, "board");
    assert.equal(engagement.org, "jlwaugh");
    assert.equal(engagement.repo, "MultiAgency/legion-social");
    assert.equal(engagement.deposit.amount, "0");
    assert.equal(engagement.deposit.transaction, undefined);
    assert.equal(engagement.request, 800, "the block records the request that opened the job");
    assert.match(epic.body, /opened by @jlwaugh with no deposit/);
    assert.match(epic.body, /Build the internal dashboard/);
    assert.ok(comments[0].body.includes(`your job is open with no deposit: ${epic.html_url}.`),
      "the answer links the job it opened");
    assert.equal(issues[800].state, "closed");
    assert.equal(issues[800].state_reason, "completed");
  });

  test("an internal member's request opens a job too", async () => {
    reset();
    teams["internal/intern"] = { state: "active" };
    issues[801] = jobRequest(801, "intern", "Build the other thing", {});
    serveBoard();
    await settle();
    assert.equal(epics.length, 1);
    assert.equal(fenced(epics[0].body, "engagement").org, "intern");
    assert.equal("repo" in fenced(epics[0].body, "engagement"), false);
  });

  test("a pending invite to team internal is not a member yet", async () => {
    reset();
    teams["internal/intern"] = { state: "pending" };
    issues[817] = jobRequest(817, "intern", "Invited, not active", {});
    serveBoard();
    await settle();
    assert.equal(epics.length, 0);
    assert.match(comments[0].body, /only a MultiAgency owner or an active member of team internal/);
    assert.equal(issues[817].state_reason, "not_planned");
  });

  test("an outsider is refused with the reason, and the request closes as not planned", async () => {
    reset();
    issues[802] = jobRequest(802, "outsider", "Build it", {});
    serveBoard();
    await settle();
    assert.equal(epics.length, 0);
    assert.match(comments[0].body, /no job was opened from this request: only a MultiAgency owner or an active member of team internal/);
    assert.equal(issues[802].state, "closed");
    assert.equal(issues[802].state_reason, "not_planned");
    // Reopened, it is closed again without a second refusal comment.
    issues[802].state = "open";
    await settle();
    assert.equal(comments.length, 1);
    assert.equal(issues[802].state_reason, "not_planned");
  });

  test("a roster agent is refused even when an owner and on team internal", async () => {
    reset();
    roles[BOT] = "admin";
    teams[`internal/${BOT}`] = { state: "active" };
    issues[803] = jobRequest(803, BOT, "The agent's own job", {});
    serveBoard();
    await settle();
    assert.equal(epics.length, 0);
    assert.match(comments[0].body, /is on the roster as an agent, and only people open jobs/);
    assert.equal(issues[803].state_reason, "not_planned");
  });

  test("the board's own bot is refused by name, even off the roster and an owner", async () => {
    reset();
    roles["on-board"] = "admin";
    // The bot's login is a deployment fact (BOARD_BOT); name one the roster
    // does not know, so the by-name refusal is what fires.
    process.env.BOARD_BOT = "on-board";
    try {
      assert.equal(await jobRequestRefusal("on-board"), "@on-board is MultiAgency's own agent, and only people open jobs");
    } finally {
      process.env.BOARD_BOT = BOT;
    }
  });

  test("an unreadable internal team fails closed to owners only", async () => {
    reset();
    roles.jlwaugh = "admin";
    issues[806] = jobRequest(806, "jlwaugh", "Owner, unreadable internal team", {});
    issues[807] = jobRequest(807, "intern", "Intern, unreadable internal team", {});
    teams["internal/intern"] = 500;
    serveBoard();
    await settle();
    assert.deepEqual(epics.map(e => e.title), ["Job: Owner, unreadable internal team"]);
    assert.match(comments[1].body, /team internal could not be read, so only owners can open a job/);
  });

  test("a refusal lifted, the fixed and reopened request opens its job", async () => {
    reset();
    issues[819] = jobRequest(819, "intern", "Fixed later", {});
    serveBoard();
    await settle();
    assert.equal(epics.length, 0);
    assert.match(comments[0].body, /no job was opened from this request/);
    // The invite was accepted, and the author reopened their refused request:
    // the refusal no longer holds, so it is checked again.
    issues[819].state = "open";
    teams["internal/intern"] = { state: "active" };
    await settle();
    assert.equal(epics.length, 1);
    assert.equal(fenced(epics[0].body, "engagement").org, "intern");
    assert.equal(issues[819].state, "closed");
    assert.equal(issues[819].state_reason, "completed");
  });

  test("refused again for a new reason, the reopened request is answered with it", async () => {
    reset();
    teams["internal/intern"] = { state: "active" };
    issues[826] = jobRequest(826, "intern", "Reasons change", { repo: "MultiAgency/somewhere-else" });
    serveBoard();
    await settle();
    assert.match(comments[0].body, /repo must be a repository code tasks deliver against/);
    assert.equal(issues[826].state, "closed");
    // The author fixes the repo but loses their team membership: the new
    // refusal is answered too, not closed silently over the old one.
    issues[826].state = "open";
    delete teams["internal/intern"];
    issues[826].body = jobRequest(826, "intern", "Reasons change", {}).body;
    await settle();
    assert.equal(epics.length, 0);
    assert.equal(comments.length, 2);
    assert.match(comments[1].body, /only a MultiAgency owner or an active member of team internal/);
    assert.equal(issues[826].state_reason, "not_planned");
  });

  test("a team read on a token the org was not granted fails closed", async () => {
    reset();
    delete process.env.ORG_TOKEN;
    try {
      issues[821] = jobRequest(821, "intern", "Unreadable without the org token", {});
      serveBoard();
      await settle();
      assert.equal(epics.length, 0);
      assert.match(comments[0].body, /team internal could not be read, so only owners can open a job/);
      assert.equal(issues[821].state_reason, "not_planned");
    } finally {
      process.env.ORG_TOKEN = "org-token";
    }
  });

  test("a malformed block is refused", async () => {
    reset();
    roles.jlwaugh = "admin";
    issues[808] = {
      ...jobRequest(808, "jlwaugh", "Broken", {}),
      body: "Brief.\n\n```job-request\n[]\n```",
    };
    issues[809] = {
      ...jobRequest(809, "jlwaugh", "Unparseable", {}),
      body: "Brief.\n\n```job-request\n{nope}\n```",
    };
    serveBoard();
    await settle();
    assert.equal(epics.length, 0);
    assert.match(comments[0].body, /its ```job-request block is not a JSON object/);
    assert.match(comments[1].body, /its ```job-request block is not a JSON object/);
  });

  test("a repo the intake does not accept is refused", async () => {
    reset();
    roles.jlwaugh = "admin";
    issues[810] = jobRequest(810, "jlwaugh", "Wrong repo", { repo: "MultiAgency/somewhere-else" });
    serveBoard();
    await settle();
    assert.equal(epics.length, 0);
    assert.match(comments[0].body, /repo must be a repository code tasks deliver against/);
  });

  test("a brief shadowing the bot's own blocks is refused", async () => {
    reset();
    roles.jlwaugh = "admin";
    const shadow = "Real brief, longer than twenty characters, with a planted block:\n\n```engagement\n{}\n```";
    issues[814] = jobRequest(814, "jlwaugh", "Shadowed engagement", {}, shadow);
    issues[815] = jobRequest(815, "jlwaugh", "Shadowed team", {}, `${shadow.replace("engagement", "team")}`);
    issues[828] = jobRequest(828, "jlwaugh", "Shadowed request", {}, `${shadow.replace("engagement", "job-request")}`);
    serveBoard();
    await settle();
    assert.equal(epics.length, 0);
    assert.match(comments[0].body, /brief must not carry an ```engagement, ```team or ```job-request block/);
    assert.match(comments[1].body, /brief must not carry an ```engagement, ```team or ```job-request block/);
    assert.match(comments[2].body, /brief must not carry an ```engagement, ```team or ```job-request block/);
  });

  test("the sweep does not eat a job whose epic carries a ```job-request fence", async () => {
    reset();
    // A Hire epic whose brief carried the fence before the intake refused it:
    // the bot's own epic is never a request, whatever its body quotes.
    issues[827] = epicIssue(827, BOT, { engagement_id: "ma-paid", org: "acme", deposit: { amount: "5000000", transaction: "tx" } });
    issues[827].body = issues[827].body.replace("Brief.", "Real brief, longer than twenty characters, with a planted fence:\n\n```job-request\n{}\n```");
    serveBoard();
    await settle();
    assert.equal(epics.length, 0);
    assert.equal(comments.length, 0, "the paid job is neither refused nor answered");
    assert.equal(issues[827].state, "open");
  });

  test("a request is processed once; a later cycle, or a reopened request, opens nothing new", async () => {
    reset();
    roles.jlwaugh = "admin";
    issues[811] = jobRequest(811, "jlwaugh", "Once only", {});
    serveBoard();
    await settle();
    await settle();
    assert.equal(epics.length, 1);
    assert.equal(comments.length, 1);
    // The author reopens their handled request: the bot's own answer marks it
    // handled, so it closes again without a second job.
    issues[811].state = "open";
    await settle();
    assert.equal(epics.length, 1);
    assert.equal(comments.length, 1);
    assert.equal(issues[811].state, "closed");
  });

  test("an epic whose answer never landed is found by its request, never opened twice", async () => {
    reset();
    roles.jlwaugh = "admin";
    issues[818] = jobRequest(818, "jlwaugh", "Answer lost", {});
    serveBoard();
    await settle();
    assert.equal(epics.length, 1);
    assert.equal(fenced(epics[0].body, "engagement").request, 818);
    // GitHub lost the answer comment: the thread holds nothing of the bot's.
    threads[818] = [];
    comments.length = 0;
    issues[818].state = "open";
    commentsFail = 1;
    await settle();
    assert.equal(epics.length, 1, "the epic the block records is found, not opened twice");
    assert.equal(comments.length, 0);
    assert.equal(issues[818].state, "open", "the close waits until the answer lands");
    await settle();
    assert.equal(epics.length, 1);
    assert.equal(comments.length, 1);
    assert.equal(issues[818].state, "closed");
  });

  test("GitHub refusing the epic leaves the request open and unanswered for the next cycle", async () => {
    reset();
    roles.jlwaugh = "admin";
    issues[812] = jobRequest(812, "jlwaugh", "Retry me", {});
    serveBoard();
    createFails = 1;
    await settle();
    assert.equal(epics.length, 0);
    assert.equal(comments.length, 0);
    assert.equal(issues[812].state, "open");
    await settle();
    assert.equal(epics.length, 1);
    assert.equal(issues[812].state, "closed");
  });

  test("a request's spec answers to the intake's rules, and its brief drops the fence", async () => {
    reset();
    roles.jlwaugh = "admin";
    const request = jobRequest(813, "jlwaugh", "Spec'd", { repo: "MultiAgency/near-agencies" }, "A real brief of more than twenty characters, as the intake demands.");
    serveBoard();
    assert.equal(isJobRequest(request.body), true);
    assert.equal(isJobRequest("no block"), false);
    assert.match(briefOf(request.body), /A real brief/);
    assert.equal(briefOf(request.body).includes("job-request"), false);
    assert.deepEqual(jobRequestSpec(request), {
      title: "Spec'd",
      brief: "A real brief of more than twenty characters, as the intake demands.",
      repo: "MultiAgency/near-agencies",
    });
    assert.match(jobRequestSpec({ title: "T", body: "x" }).problem, /not a JSON object/);
  });
});

describe("a forged engagement block", () => {
  test("is never a job: the list and the job API count bot- or owner-authored issues only", async () => {
    reset();
    roles.jlwaugh = "admin";
    issues[820] = epicIssue(820, "stranger", { engagement_id: "ma-forge", org: "stranger", deposit: { amount: "5000000", transaction: "tx" } });
    issues[821] = epicIssue(821, BOT, { engagement_id: "ma-real", channel: "board", org: "jlwaugh", deposit: { amount: "0", asset: "usdc", treasury: "multiagency.sputnikv2.testnet", network: "testnet" } });
    // An owner's hand-opened epic is a job too: lib/recover.mjs reuses it
    // when a stuck Hire's first attempt died before its epic was found.
    issues[824] = epicIssue(824, "jlwaugh", { engagement_id: "ma-hand", org: "acme", deposit: { amount: "5000000", transaction: "tx" } });
    serveBoard();
    const listed = await listEngagements();
    assert.deepEqual(listed.map(e => e.number), [821, 824]);
    assert.equal(listed[0].deposit, "0");
    await assert.rejects(loadEngagement(820), /820 is not an engagement/);
    const job = await loadEngagement(821);
    assert.equal(job.engagement.deposit.amount, "0");
    assert.equal("link" in job.engagement.deposit, false, "a zero-deposit job has no transaction link");
    const hand = await loadEngagement(824);
    assert.equal(hand.engagement.deposit.amount, "5000000");
  });

  test("is never a job on the timeline either", async () => {
    reset();
    roles.jlwaugh = "admin";
    issues[822] = epicIssue(822, "stranger", { engagement_id: "ma-forge", org: "stranger", deposit: { amount: "1000000", transaction: "tx" } });
    issues[823] = epicIssue(823, BOT, { engagement_id: "ma-board", channel: "board", org: "jlwaugh", deposit: { amount: "0" } });
    issues[825] = epicIssue(825, "jlwaugh", { engagement_id: "ma-hand", org: "acme", deposit: { amount: "1000000", transaction: "tx" } });
    serveBoard();
    await assert.rejects(timeline(822), /822 is not an engagement/);
    const relay = await timeline(823);
    assert.equal(relay.events[0].kind, "job-requested");
    assert.equal(relay.lanes[0].kind, "client");
    assert.equal(relay.lanes[0].role, "Opened the job from the board");
    const hand = await timeline(825);
    assert.equal(hand.events[0].kind, "deposit");
  });
});

describe("volunteer-only zero-deposit jobs", () => {
  const job = () => ({
    number: 830,
    state: "open",
    labels: [{ name: "engagement" }],
    body: `Brief.\n\n${fence("engagement", { engagement_id: "ma-v", channel: "board", org: "jlwaugh", deposit: { amount: "0" } })}`,
  });

  test("a paid task is refused; a volunteer task is not", () => {
    const spec = amount => ({ key: "one", title: "Write it", body: "Write the comparison.", amount, labels: ["skill:writing", "human-only"] });
    assert.match(teamProblem(job(), [spec("1000000")]), /more than the 0 USDC deposit/);
    assert.equal(teamProblem(job(), [spec("0")]), null);
  });

  test("public Hire keeps its deposit minimum", () => {
    assert.match(chosenDeposit({ amount: "1" }, { deposit: "5000000", depositMin: "5000000", depositMax: "10000000" }).problem,
      /deposit must be at least 5 USDC/);
    assert.equal(chosenDeposit({}, { deposit: "5000000", depositMin: "5000000", depositMax: "10000000" }).amount, "5000000");
  });
});
