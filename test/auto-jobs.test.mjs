import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { autoJobsHealth, closeIfHandedOff, coordinatorHealth, settleAutoJobs, settlePayouts } from "../lib/coordinator.mjs";
import { listEngagements, loadEngagement } from "../lib/engagement-state.mjs";
import { fence, fenced } from "../lib/github.mjs";
import { USDC } from "../lib/near.mjs";
import { teamProblem } from "../lib/team.mjs";

// Requests go only to the fetch stubs below; the token just has to resolve.
process.env.GITHUB_TOKEN = "test-token";
// The bot's identity is a deployment fact (BOARD_BOT), not the caller's token:
// the stub answers /user with a stranger's login to prove it.
process.env.BOARD_BOT = "multi-agency";
// A team's 404 says "not a member" only from the token the org granted.
process.env.ORG_TOKEN ??= "org-token";
// The cap the owner decided, pinned so the flood test reads it, whatever the
// environment the suite runs under.
process.env.AUTO_JOBS_MAX = "2";

const BOT = "multi-agency";
const BOARD = "MultiAgency/kanban-sandbox";
const BOARD_URL = `/repos/${BOARD}`;
const REG = "MultiAgency/near-agencies";
const REG_URL = `/repos/${REG}`;
const SOURCE = `${REG}#600`;

let boardIssues, boardEvents, boardThreads, regIssues, regEvents, regThreads, regSingle, lastEdited, pulls, roles, teams, created, createFails, reactions, self, calls;

const reset = () => {
  boardIssues = {};
  boardEvents = {};
  boardThreads = {};
  regIssues = {};
  regEvents = {};
  regThreads = {};
  regSingle = {};
  lastEdited = {};
  pulls = {};
  roles = {};
  teams = {};
  created = [];
  createFails = 0;
  reactions = [];
  self = "jlwaugh";
  calls = [];
};

// A registry issue labelled for the agents, with the events its trigger reads.
const registryIssue = (number, { title = "Build the internal dashboard", body = "Please build the internal dashboard, volunteer work, this week at the latest.", assignees = [], created_at = "2026-10-05T00:00:00Z", state = "open" } = {}) => ({
  number,
  user: { login: "someone" },
  title,
  state,
  labels: [{ name: "ready-for-agent" }],
  assignees: assignees.map(login => ({ login })),
  created_at,
  html_url: `https://github.com/${REG}/issues/${number}`,
  body,
  pull_request: undefined,
});

const labeled = (actor, at, name = "ready-for-agent") => ({ event: "labeled", actor: { login: actor }, label: { name }, created_at: at });
const crossReferenced = (prNumber, at) => ({
  event: "cross-referenced",
  actor: { login: "someone" },
  created_at: at,
  source: { issue: { number: prNumber, html_url: `https://github.com/${REG}/pull/${prNumber}`, pull_request: { number: prNumber } } },
});
const pull = (number, { state = "open", merged = false, user = "jlwaugh", base = "staging", body = `Closes ${SOURCE}` } = {}) => ({
  number,
  state,
  merged,
  user: { login: user },
  base: { ref: base },
  html_url: `https://github.com/${REG}/pull/${number}`,
  body,
});

// An auto job as the sweep leaves it, shaped for the close-on-merge tests:
// the epic records its source, and its one task carries the same on its terms.
const autoEpic = (epicNumber, taskNumber) => ({
  number: epicNumber,
  user: { login: BOT },
  title: "Job: Build the internal dashboard",
  state: "open",
  labels: [{ name: "engagement" }, { name: "blocked" }],
  html_url: `https://github.com/${BOARD}/issues/${epicNumber}`,
  created_at: "2026-10-05T01:00:00Z",
  body: [
    "**Job** opened by @jlwaugh with no deposit, so its tasks can only be volunteer work.",
    "",
    "Please build the internal dashboard, volunteer work, this week at the latest.",
    "",
    "Opened for [#600](https://github.com/MultiAgency/near-agencies/issues/600).",
    "",
    "## Team",
    "",
    `- [ ] #${taskNumber} — volunteer`,
    "",
    fence("engagement", {
      engagement_id: "ma-auto",
      channel: "board",
      source: SOURCE,
      org: "jlwaugh",
      repo: REG,
      deposit: { amount: "0", asset: USDC, treasury: "multiagency.sputnikv2.testnet", network: "testnet" },
    }),
    "",
    fence("team", {
      committed: "0",
      members: [{ issue: taskNumber, engagement: epicNumber, key: "build", amount: "0", asset: USDC, repo: REG, source: SOURCE }],
    }),
  ].join("\n"),
});

const autoTask = (taskNumber, epicNumber, { state = "open", assignees = ["jlwaugh"] } = {}) => ({
  number: taskNumber,
  user: { login: BOT },
  title: "Build the internal dashboard",
  state,
  labels: [{ name: state === "open" ? "in-progress" : "closed" }, { name: "skill:code" }, { name: "agent-eligible" }],
  assignees: assignees.map(login => ({ login })),
  html_url: `https://github.com/${BOARD}/issues/${taskNumber}`,
  created_at: "2026-10-05T01:00:01Z",
  closed_at: state === "closed" ? "2026-10-05T02:00:00Z" : null,
  body: [
    "Part of job #999.",
    "",
    `Build [${SOURCE}](https://github.com/MultiAgency/near-agencies/issues/600) in \`${REG}\`.`,
    "",
    fence("terms", { engagement: epicNumber, key: "build", amount: "0", asset: USDC, repo: REG, source: SOURCE }),
  ].join("\n"),
});

const handoffBy = (login, url) => ({
  id: 77,
  user: { login },
  created_at: "2026-10-05T01:30:00Z",
  updated_at: "2026-10-05T01:30:00Z",
  html_url: `https://github.com/${BOARD}/issues/900#issuecomment-1`,
  body: `**Handoff:** the dashboard is built.\n\n${fence("handoff", { links: [url], payout: { account_id: "reviewer.agency.testnet" } })}`,
});

function serveBoard() {
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    const method = options.method ?? "GET";
    calls.push(`${method} ${u.pathname}${u.search}`);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    let m;
    if (method === "GET" && u.pathname === "/user") return json({ login: self });
    // GraphQL: the issue reads the trigger cannot get from the events API —
    // when its body or title was last edited.
    if (u.pathname === "/graphql" && method === "POST") {
      const { variables } = JSON.parse(options.body);
      return json({ data: { repository: { issue: { lastEditedAt: lastEdited[`${variables.owner}/${variables.repo}#${variables.number}`] ?? null } } } });
    }
    // The board's engagement lists: open ones for the sweeps, every state for
    // the epics a source leads back to, and everything for tasksMade's
    // interrupted-run check.
    if (method === "GET" && u.pathname === `${BOARD_URL}/issues` && u.searchParams.get("state") === "all" && !u.searchParams.get("labels")) {
      return json(Object.values(boardIssues).filter(i => !i.pull_request));
    }
    if (method === "GET" && u.pathname === `${BOARD_URL}/issues` && u.searchParams.get("labels") === "engagement") {
      const all = u.searchParams.get("state") === "all";
      return json(Object.values(boardIssues).filter(i => !i.pull_request && (i.labels ?? []).some(l => l.name === "engagement") && (all || i.state === "open")));
    }
    if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/issues$/.test(u.pathname) && u.searchParams.get("labels") === "ready-for-agent") {
      const name = u.pathname.slice("/repos/".length, -"/issues".length);
      return json(regIssues[name] ?? []);
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/events$/.exec(u.pathname)) && method === "GET") {
      const onBoard = m[1] === "MultiAgency" && m[2] === "kanban-sandbox";
      return json(onBoard
        ? (boardEvents[Number(m[3])] ?? [])
        : (regEvents[`${m[1]}/${m[2]}#${m[3]}`] ?? []));
    }
    if ((m = /^\/orgs\/MultiAgency\/teams\/([\w-]+)\/memberships\/([\w.-]+)$/.exec(u.pathname)) && method === "GET") {
      const answer = teams[`${m[1]}/${m[2]}`];
      if (answer && typeof answer === "object") return json(answer);
      return json({ message: "Not Found" }, 404);
    }
    if ((m = /^\/repos\/MultiAgency\/kanban-sandbox\/collaborators\/([^/]+)\/permission$/.exec(u.pathname)) && method === "GET") {
      return json({ role_name: roles[m[1]] ?? "read" });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(u.pathname)) && method === "GET") {
      const found = pulls[Number(m[3])];
      if (!found) return json({ message: "Not Found" }, 404);
      return json(found);
    }
    if (method === "POST" && u.pathname === `${BOARD_URL}/issues`) {
      if (createFails) { createFails -= 1; return json({ message: "boom" }, 500); }
      const opened = JSON.parse(options.body);
      const issue = {
        number: 800 + created.length,
        user: { login: BOT },
        state: "open",
        html_url: `https://github.com/${BOARD}/issues/${800 + created.length}`,
        ...opened,
        labels: opened.labels.map(name => ({ name })),
      };
      issue.html_url = `https://github.com/${BOARD}/issues/${issue.number}`;
      created.push(issue);
      boardIssues[issue.number] = issue;
      return json(issue);
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/comments\/(\d+)\/reactions$/.exec(u.pathname))) {
      if (method === "POST") reactions.push({ id: Number(m[3]), ...JSON.parse(options.body) });
      return json(reactions.filter(r => r.id === Number(m[3])));
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(u.pathname))) {
      const key = `${m[1]}/${m[2]}#${m[3]}`;
      const thread = (m[1] === "MultiAgency" && m[2] === "kanban-sandbox" ? boardThreads : regThreads)[key] ??= [];
      if (method === "POST") {
        const posted = { id: thread.length + 1, user: { login: BOT }, ...JSON.parse(options.body) };
        thread.push(posted);
        return json(posted);
      }
      return json(thread);
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(u.pathname))) {
      const key = `${m[1]}/${m[2]}`;
      const found = key === BOARD
        ? boardIssues[Number(m[3])]
        : (regSingle[`${key}#${m[3]}`] ?? (regIssues[key] ?? []).find(i => i.number === Number(m[3])));
      if (!found) return json({ message: "Not Found" }, 404);
      if (method === "PATCH") {
        const patch = JSON.parse(options.body);
        if (Array.isArray(patch.labels)) patch.labels = patch.labels.map(l => typeof l === "string" ? { name: l } : l);
        Object.assign(found, patch);
        if (patch.state === "closed") {
          found.closed_at = new Date().toISOString();
          (boardEvents[found.number] ??= []).push({ event: "closed", actor: { login: BOT }, created_at: found.closed_at });
        }
        if (patch.state === "open") found.closed_at = null;
      }
      return json(found);
    }
    throw new Error(`unexpected request: ${method} ${u.pathname}${u.search}`);
  };
}

afterEach(() => { globalThis.fetch = realFetch; });

const realFetch = globalThis.fetch;

// The sweep rate-limits itself; each call lands past the previous one's gap.
let now = 0;
const settle = () => settleAutoJobs({ now: now += 200_000 });

describe("opening auto jobs", () => {
  test("an owner's label opens one job, its fixed team assembled at once", async () => {
    reset();
    roles.jlwaugh = "admin";
    regIssues[REG] = [registryIssue(600)];
    regEvents[`${REG}#600`] = [labeled("jlwaugh", "2026-10-05T00:01:00Z")];
    serveBoard();
    await settle();
    assert.equal(created.length, 2, "the epic and its one task");
    const epic = created[0];
    assert.equal(epic.title, "Job: Build the internal dashboard");
    const engagement = fenced(epic.body, "engagement");
    assert.equal(engagement.channel, "board");
    assert.equal(engagement.source, SOURCE, "the block records the issue the job builds");
    assert.equal(engagement.org, "jlwaugh", "the labeler stands as the one who opened it");
    assert.equal(engagement.repo, REG);
    assert.equal(engagement.deposit.amount, "0");
    assert.equal(engagement.deposit.transaction, undefined);
    assert.match(epic.body, /opened by @jlwaugh with no deposit/);
    assert.match(epic.body, /Please build the internal dashboard/);
    assert.match(epic.body, /\[#600\]\(https:\/\/github\.com\/MultiAgency\/near-agencies\/issues\/600\)/, "the brief links the issue");
    assert.match(epic.body, /## Team/);
    assert.match(epic.body, /```team/, "the fixed team assembled at once, with no /approve");
    assert.match(epic.body, /- \[ \] #\d+ — volunteer/);
    const task = created[1];
    assert.equal(fenced(task.body, "terms").engagement, epic.number);
    assert.equal(fenced(task.body, "terms").repo, REG, "the terms name the issue's repository");
    assert.equal(fenced(task.body, "terms").source, SOURCE, "the terms carry the source, so the cycle knows the seat");
    assert.equal(fenced(task.body, "terms").amount, "0");
    assert.deepEqual(task.labels.map(l => l.name).sort(), ["agent-eligible", "ready", "skill:code"]);
    assert.match(task.body, /Part of job #\d+\./);
    assert.match(task.body, /`Closes MultiAgency\/near-agencies#600`/, "the brief tells the claimant to close the issue");
    assert.match(task.body, /against `staging`/);
    const answer = regThreads[`${REG}#600`][0];
    assert.match(answer.body, new RegExp(`A job opened for this issue with no deposit: ${epic.html_url}`));
    assert.equal(regThreads[`${REG}#600`].length, 1, "the answer is said once");
    assert.equal(regIssues[REG][0].state, "open", "the registry issue stays open: its own life closes it");
    assert.equal(autoJobsHealth().opened, 1);
    assert.equal((await listEngagements()).length, 1, "the bot-authored epic is a job like any other");
  });

  test("an internal member's label opens a job too", async () => {
    reset();
    teams["internal/intern"] = { state: "active" };
    regIssues[REG] = [registryIssue(601)];
    regEvents[`${REG}#601`] = [labeled("intern", "2026-10-05T00:01:00Z")];
    serveBoard();
    await settle();
    assert.equal(created.length, 2);
    assert.equal(fenced(created[0].body, "engagement").org, "intern");
  });

  test("an outsider's or an agent's label opens nothing", async () => {
    reset();
    regIssues[REG] = [registryIssue(602), registryIssue(603)];
    regEvents[`${REG}#602`] = [labeled("outsider", "2026-10-05T00:01:00Z")];
    regEvents[`${REG}#603`] = [labeled(BOT, "2026-10-05T00:01:00Z")];
    serveBoard();
    await settle();
    assert.equal(created.length, 0);
    assert.equal(regThreads[`${REG}#602`], undefined, "nothing is answered where nothing opens");
    assert.deepEqual(autoJobsHealth().opened, 0);
    assert.match(autoJobsHealth().skipped.find(s => s.issue === `${REG}#602`).why, /only a MultiAgency owner or an active member of team internal/);
    assert.match(autoJobsHealth().skipped.find(s => s.issue === `${REG}#603`).why, /is on the roster as an agent, and only people open jobs/);
  });

  test("an assigned issue, one with an open closing pull request, and one already labelled by nobody indexed are skipped", async () => {
    reset();
    roles.jlwaugh = "admin";
    regIssues[REG] = [
      registryIssue(610, { assignees: ["jlwaugh"] }),
      registryIssue(611),
      registryIssue(612),
    ];
    regEvents[`${REG}#610`] = [labeled("jlwaugh", "2026-10-05T00:01:00Z")];
    regEvents[`${REG}#611`] = [labeled("jlwaugh", "2026-10-05T00:01:00Z"), crossReferenced(9, "2026-10-05T00:02:00Z")];
    regEvents[`${REG}#612`] = [];
    pulls[9] = pull(9, { state: "open" });
    serveBoard();
    await settle();
    assert.equal(created.length, 0);
    const why = Object.fromEntries(autoJobsHealth().skipped.map(s => [s.issue, s.why]));
    assert.match(why[`${REG}#610`], /someone is already assigned to it/);
    assert.match(why[`${REG}#611`], /an open pull request \(.*pull\/9\) already closes it/);
    assert.match(why[`${REG}#612`], /the label's application is not indexed yet/);
  });

  test("a merged closing pull request no longer holds the issue", async () => {
    reset();
    roles.jlwaugh = "admin";
    regIssues[REG] = [registryIssue(613)];
    regEvents[`${REG}#613`] = [labeled("jlwaugh", "2026-10-05T00:01:00Z"), crossReferenced(10, "2026-10-05T00:02:00Z")];
    pulls[10] = pull(10, { state: "closed", merged: true });
    serveBoard();
    await settle();
    assert.equal(created.length, 2, "the work merged; the job opens for whatever the issue still asks");
  });

  test("restarting the coordinator never opens a second job for the same issue", async () => {
    reset();
    roles.jlwaugh = "admin";
    regIssues[REG] = [registryIssue(600)];
    regEvents[`${REG}#600`] = [labeled("jlwaugh", "2026-10-05T00:01:00Z")];
    serveBoard();
    await settle();
    await settle();
    await settle();
    assert.equal(created.length, 2, "the epic and its task, once");
    assert.equal(regThreads[`${REG}#600`].length, 1, "the answer was not said again");
    assert.match(autoJobsHealth().skipped.find(s => s.issue === SOURCE).why, /a job already stands for it/);
  });

  test("a lost answer comment is said again from the epic, and a lost team assembles again, never opening a second job", async () => {
    reset();
    roles.jlwaugh = "admin";
    regIssues[REG] = [registryIssue(600)];
    regEvents[`${REG}#600`] = [labeled("jlwaugh", "2026-10-05T00:01:00Z")];
    serveBoard();
    await settle();
    assert.equal(created.length, 2);
    // GitHub lost both writes: the thread is empty again and the epic's team
    // fence is gone. The next sweep finds the job by its source and finishes
    // it, reusing the task it already made.
    regThreads[`${REG}#600`] = [];
    const epic = created[0];
    epic.body = epic.body.slice(0, epic.body.indexOf("## Team")).trim();
    await settle();
    assert.equal(created.length, 2, "no second epic, no second task");
    assert.match(epic.body, /```team/, "the fixed team assembled again");
    assert.equal(created[1].body, boardIssues[created[1].number].body, "the task stood as it was");
    assert.equal(regThreads[`${REG}#600`].length, 1, "the answer is said once");
  });

  test("GitHub refusing the epic leaves the issue open and unanswered for the next sweep", async () => {
    reset();
    roles.jlwaugh = "admin";
    regIssues[REG] = [registryIssue(600)];
    regEvents[`${REG}#600`] = [labeled("jlwaugh", "2026-10-05T00:01:00Z")];
    serveBoard();
    createFails = 1;
    await settle();
    assert.equal(created.length, 0);
    assert.equal(regThreads[`${REG}#600`], undefined);
    await settle();
    assert.equal(created.length, 2);
    assert.equal(regThreads[`${REG}#600`].length, 1);
  });

  test("a brief the intake refuses is skipped with its reason", async () => {
    reset();
    roles.jlwaugh = "admin";
    regIssues[REG] = [
      registryIssue(620, { title: "This issue's title runs far past the one hundred and twenty characters the intake allows a job's title to carry, so it cannot become a brief as it stands" }),
      registryIssue(621, { body: "Real brief, longer than twenty characters, with a planted block:\n\n```engagement\n{}\n```" }),
    ];
    regEvents[`${REG}#620`] = [labeled("jlwaugh", "2026-10-05T00:01:00Z")];
    regEvents[`${REG}#621`] = [labeled("jlwaugh", "2026-10-05T00:01:00Z")];
    serveBoard();
    await settle();
    assert.equal(created.length, 0, "a stranger's block must never ride into a job's brief");
    const why = Object.fromEntries(autoJobsHealth().skipped.map(s => [s.issue, s.why]));
    assert.match(why[`${REG}#620`], /title must be 4-120 characters/);
    assert.match(why[`${REG}#621`], /brief must not carry an ```engagement, ```team or ```job-request block/);
  });

  test("an issue assigned, or unlabelled, between the list and the re-read opens nothing", async () => {
    reset();
    roles.jlwaugh = "admin";
    regIssues[REG] = [registryIssue(640), registryIssue(641)];
    regEvents[`${REG}#640`] = [labeled("jlwaugh", "2026-10-05T00:01:00Z")];
    regEvents[`${REG}#641`] = [labeled("jlwaugh", "2026-10-05T00:01:00Z")];
    // The list read neither; by the time the sweep re-reads each issue before
    // opening its job, one is assigned and the other's label is gone.
    regSingle[`${REG}#640`] = registryIssue(640, { assignees: ["jlwaugh"] });
    regSingle[`${REG}#641`] = { ...registryIssue(641), labels: [] };
    serveBoard();
    await settle();
    assert.equal(created.length, 0);
    const why = Object.fromEntries(autoJobsHealth().skipped.map(s => [s.issue, s.why]));
    assert.match(why[`${REG}#640`], /someone is already assigned to it/);
    assert.match(why[`${REG}#641`], /its ready-for-agent label is gone/);
  });

  test("at most AUTO_JOBS_MAX stand open, the oldest labelled issue first", async () => {
    reset();
    roles.jlwaugh = "admin";
    regIssues[REG] = [registryIssue(630), registryIssue(631), registryIssue(632)];
    regEvents[`${REG}#630`] = [labeled("jlwaugh", "2026-10-05T00:03:00Z")];
    regEvents[`${REG}#631`] = [labeled("jlwaugh", "2026-10-05T00:01:00Z")];
    regEvents[`${REG}#632`] = [labeled("jlwaugh", "2026-10-05T00:02:00Z")];
    serveBoard();
    await settle();
    assert.equal(created.length, 4, "two jobs, each with its task");
    assert.deepEqual(created.filter(i => i.labels.some(l => l.name === "engagement")).map(i => i.title),
      ["Job: Build the internal dashboard", "Job: Build the internal dashboard"]);
    const first = fenced(created[0].body, "engagement").source;
    const second = fenced(created[2].body, "engagement").source;
    assert.deepEqual([first, second], [`${REG}#631`, `${REG}#632`], "the oldest labelled issue goes first");
    assert.match(autoJobsHealth().skipped.find(s => s.issue === `${REG}#630`).why, /at most 2 auto jobs stand open at once/);
    assert.equal(autoJobsHealth().opened, 2);
    // One job closes: the slot it frees opens the third issue's job.
    const done = created[0];
    done.state = "closed";
    await settle();
    assert.equal(created.length, 6);
    assert.equal(fenced(created[4].body, "engagement").source, `${REG}#630`);
  });
});

describe("closing an auto task on the merge", () => {
  const build = ({ pr = pull(9), thread = [handoffBy("jlwaugh", `https://github.com/${REG}/pull/9`)], task = {}, sourceState = "closed" } = {}) => {
    reset();
    boardIssues[890] = autoEpic(890, 900);
    boardIssues[900] = autoTask(900, 890, task);
    boardThreads[`${BOARD}#900`] = thread;
    pulls[9] = pr;
    regIssues[REG] = [];
    // GitHub closed the source issue when the pull request merged into the
    // default branch; its state as the sweep re-reads it is this one.
    regSingle[SOURCE] = registryIssue(600, { state: sourceState });
    serveBoard();
  };

  test("a merged pull request by the claimant closes the task, and closeIfPaid completes the job", async () => {
    build({ pr: pull(9, { state: "closed", merged: true }) });
    await settle();
    assert.equal(boardIssues[900].state, "closed");
    assert.equal(boardIssues[900].state_reason, "completed");
    const said = boardThreads[`${BOARD}#900`].at(-1);
    assert.match(said.body, /@jlwaugh, the pull request your handoff links is merged, so this task is done\./);
    // The job then completes through the volunteer path: nothing was paid, and
    // its completion comment says so without naming payouts or margins.
    await settlePayouts(BOT, { now: now + 200_000 });
    assert.equal(boardIssues[890].state, "closed");
    assert.equal(boardIssues[890].state_reason, "completed");
    assert.match(boardThreads[`${BOARD}#890`].at(-1).body, /\*\*Job complete\.\*\* Its tasks were volunteer work; no payouts were made\./);
    assert.equal((await loadEngagement(890)).stage, "complete");
  });

  test("an unmerged pull request, or one by someone else, closes nothing", async () => {
    build({ pr: pull(9, { state: "open" }) });
    await settle();
    assert.equal(boardIssues[900].state, "open", "the work is not done until it merges");

    build({ pr: pull(9, { state: "closed", merged: true, user: "someone" }) });
    await settle();
    assert.equal(boardIssues[900].state, "open", "another's pull request is not the claimant's delivery");
    assert.equal(boardThreads[`${BOARD}#900`].length, 1, "nothing is said where nothing closes");
  });

  test("a merged pull request that closes nothing, or merges into another branch, closes nothing", async () => {
    build({ pr: pull(9, { state: "closed", merged: true, body: "Drive-by refactor, linked to no issue." }) });
    await settle();
    assert.equal(boardIssues[900].state, "open", "an unrelated merged pull request is not this task's delivery");

    build({ pr: pull(9, { state: "closed", merged: true, base: "main" }) });
    await settle();
    assert.equal(boardIssues[900].state, "open", "the pull request merges into the repository's base branch, or it is not done");

    // A different closing keyword, or a bare issue number, still names the
    // issue the way GitHub closes it.
    build({ pr: pull(9, { state: "closed", merged: true, body: "fixes #600" }) });
    await settle();
    assert.equal(boardIssues[900].state, "closed");
  });

  test("a pull request whose closing reference was written after the merge closes nothing", async () => {
    // The body reads as it stands now, so a reference added after the merge
    // passes that check; the issue the merge never closed is what holds.
    build({ pr: pull(9, { state: "closed", merged: true }), sourceState: "open" });
    await settle();
    assert.equal(boardIssues[900].state, "open", "the merge closed no issue, so the task is not done");
    assert.equal(boardThreads[`${BOARD}#900`].length, 1);
  });

  test("a body edited after the label opens nothing until the label is applied again", async () => {
    reset();
    roles.jlwaugh = "admin";
    regIssues[REG] = [registryIssue(615)];
    regEvents[`${REG}#615`] = [labeled("jlwaugh", "2026-10-05T00:01:00Z")];
    // GitHub's events record no body edit; the issue's own lastEditedAt is
    // what an edit after the label is judged from.
    lastEdited[`${REG}#615`] = "2026-10-05T00:05:00Z";
    serveBoard();
    await settle();
    assert.equal(created.length, 0);
    assert.match(autoJobsHealth().skipped.find(s => s.issue === `${REG}#615`).why, /its body changed after the label was applied/);
    // The owner reviews the edit and applies the label again: that vouches
    // for the issue as it now stands, and the job opens.
    regEvents[`${REG}#615`].push(labeled("jlwaugh", "2026-10-05T00:06:00Z"));
    await settle();
    assert.equal(created.length, 2);
  });

  test("an issue whose edits cannot be read opens nothing", async () => {
    reset();
    roles.jlwaugh = "admin";
    regIssues[REG] = [registryIssue(616)];
    regEvents[`${REG}#616`] = [labeled("jlwaugh", "2026-10-05T00:01:00Z")];
    serveBoard();
    const served = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      if (new URL(url).pathname === "/graphql") return new Response(JSON.stringify({ message: "boom" }), { status: 500, headers: { "content-type": "application/json" } });
      return served(url, options);
    };
    await settle();
    assert.equal(created.length, 0, "an unreadable edit fails closed, as an unreadable team does");
    assert.match(autoJobsHealth().skipped.find(s => s.issue === `${REG}#616`).why, /its edits could not be read/);
  });

  test("a task without a handoff yet waits, and one with an unreadable handoff is answered", async () => {
    build({ thread: [] });
    await settle();
    assert.equal(boardIssues[900].state, "open");

    const unreadable = handoffBy("jlwaugh", `https://github.com/${REG}/pull/9`);
    unreadable.body = "**Handoff:** it is done, trust me.";
    build({ thread: [unreadable] });
    await settle();
    assert.equal(boardIssues[900].state, "open");
  });

  test("an auto task's handoff alone closes nothing, where any other seat's closes it", async () => {
    build({ pr: pull(9, { state: "open" }) });
    const seat = {
      number: 900,
      labels: ["in-progress", "skill:code", "agent-eligible"],
      assignees: ["jlwaugh"],
      terms: fenced(boardIssues[900].body, "terms"),
    };
    assert.equal(await closeIfHandedOff(seat, BOT), false);
    assert.equal(boardIssues[900].state, "open", "the merge closes it, not the handoff");
    assert.equal(reactions.length, 0, "the handoff is not marked processed before the merge");

    seat.terms = { engagement: 890, key: "build", amount: "0", asset: USDC };
    boardIssues[900].state = "open";
    assert.equal(await closeIfHandedOff(seat, BOT), true);
    assert.equal(boardIssues[900].state, "closed", "a seat no auto job opened closes on its handoff, as always");
  });

  test("nothing here reaches a job Hire opened: no source, no close", async () => {
    build({ pr: pull(9, { state: "closed", merged: true }) });
    // The same shape without the source field: a job some other channel
    // opened, whose tasks a handoff closes (or payouts settle), never this
    // sweep.
    boardIssues[880] = {
      ...autoEpic(880, 870),
      body: autoEpic(880, 870).body
        .replace(`      "source": "${SOURCE}",\n`, "")
        .replace(`    "source": "${SOURCE}",\n`, "")
        .replace(/"source": "[^"]+",\n\s*/g, ""),
    };
    boardIssues[870] = autoTask(870, 880);
    boardThreads[`${BOARD}#870`] = [handoffBy("jlwaugh", `https://github.com/${REG}/pull/9`)];
    await settle();
    assert.equal(boardIssues[870].state, "open", "only an auto job's task closes on the merge here");
    assert.equal(boardIssues[900].state, "closed");
  });

  test("a paid task cannot ride an auto job: the fixed team is volunteer work", () => {
    reset();
    serveBoard();
    const bare = {
      number: 890,
      state: "open",
      labels: [{ name: "engagement" }],
      body: `Brief.\n\n${fence("engagement", { engagement_id: "ma-auto", channel: "board", source: SOURCE, org: "jlwaugh", repo: REG, deposit: { amount: "0" } })}`,
    };
    const spec = { key: "build", title: "Build it", body: "Build the dashboard.", amount: "1000000", labels: ["skill:code", "agent-eligible"] };
    assert.match(teamProblem(bare, [spec]), /more than the 0 USDC deposit/);
    assert.equal(teamProblem(bare, [{ ...spec, amount: "0" }]), null);
  });
});
