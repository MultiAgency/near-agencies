import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { draftFor, isApproval, namedDraft } from "../lib/coordinator.mjs";
import { fence, repoUrl } from "../lib/github.mjs";
import { tasksMade, teamProblem } from "../lib/team.mjs";

const job = (overrides = {}) => ({
  number: 28,
  state: "open",
  body: `**Job** opened by \`org.testnet\`.\n\nA brief.\n\n${fence("engagement", { deposit: { amount: "3000000" } })}`,
  ...overrides,
});
const task = (key, overrides = {}) => ({
  key,
  title: `Task ${key}`,
  body: "Deliver the thing. Acceptance criteria: it is done.",
  amount: "1000000",
  labels: ["skill:research", "agent-eligible"],
  ...overrides,
});

describe("team drafts", () => {
  test("accepts a team that fits the deposit, with dependencies on earlier tasks", () => {
    assert.equal(teamProblem(job(), [
      task("research"),
      task("writing", { labels: ["skill:writing", "agent-eligible"], depends_on: ["research"] }),
      task("review", { amount: "500000", labels: ["skill:review", "human-only"], depends_on: ["writing"] }),
    ]), null);
  });

  test("refuses a job that is not open, not a job, or already has a team", () => {
    assert.match(teamProblem(job({ state: "closed" }), [task("a")]), /is closed/);
    assert.match(teamProblem(job({ body: "no block" }), [task("a")]), /not a job/);
    assert.match(teamProblem(job({ body: `${job().body}\n\n${fence("team", { members: [] })}` }), [task("a")]), /already has a team/);
  });

  test("refuses tasks the board could not run", () => {
    assert.match(teamProblem(job(), []), /no tasks/);
    assert.match(teamProblem(job(), [task("Bad Key")]), /key of lowercase/);
    assert.match(teamProblem(job(), [task("a"), task("a")]), /share the key a/);
    assert.match(teamProblem(job(), [task("a", { body: " " })]), /no body/);
    assert.match(teamProblem(job(), [task("a", { amount: "1.5" })]), /whole number/);
    assert.match(teamProblem(job(), [task("a", { labels: ["agent-eligible"] })]), /exactly one of skill:/);
    assert.match(teamProblem(job(), [task("a", { labels: ["skill:design", "agent-eligible"] })]), /exactly one of skill:/);
    assert.match(teamProblem(job(), [task("a", { labels: ["skill:research"] })]), /agent-eligible and human-only/);
    assert.match(teamProblem(job(), [task("a", { labels: ["skill:research", "agent-eligible", "human-only"] })]), /agent-eligible and human-only/);
    assert.match(teamProblem(job(), [task("a", { labels: ["skill:research", "agent-eligible", "ready"] })]), /labels a team does not set: ready/);
    assert.match(teamProblem(job(), [task("a", { depends_on: ["b"] }), task("b")]), /depends on b, which is not an earlier task/);
  });

  test("a code task may name a repository from the registry, and only a code task", () => {
    const code = ["skill:code", "agent-eligible"];
    assert.equal(teamProblem(job(), [task("a", { labels: code, repo: "MultiAgency/legion-social" })]), null);
    assert.equal(teamProblem(job(), [task("a", { labels: code })]), null);
    assert.match(teamProblem(job(), [task("a", { labels: code, repo: "someone/else" })]), /a's repo must be one of MultiAgency\/near-agencies, MultiAgency\/legion-social/);
    assert.match(teamProblem(job(), [task("a", { repo: "MultiAgency/legion-social" })]), /only a skill:code task/);
  });

  test("refuses a team that pays out more than the deposit", () => {
    assert.match(teamProblem(job(), [task("a", { amount: "2000000" }), task("b", { amount: "1000001" })]),
      /pay 3.000001 USDC, more than the 3 USDC deposit/);
  });

  test("finds the tasks an interrupted run already made, by key and job", () => {
    const made = tasksMade([
      { number: 29, body: fence("terms", { engagement: 28, key: "research" }) },
      { number: 12, body: fence("terms", { engagement: 5, key: "research" }) },
      { number: 30, body: fence("terms", { engagement: 28 }) },
      { number: 31, pull_request: {}, body: fence("terms", { engagement: 28, key: "writing" }) },
      { number: 28, body: null },
    ], 28);
    assert.deepEqual([...made], [["research", 29]]);
  });
});

describe("/approve", () => {
  const t0 = Date.parse("2026-10-02T12:00:00Z");
  const comment = (id, body, { login = "jlwaugh", at = 0, edited = at } = {}) => ({
    id,
    body,
    html_url: `${repoUrl}/issues/28#issuecomment-${id}`,
    user: { login },
    created_at: new Date(t0 + at * 60_000).toISOString(),
    updated_at: new Date(t0 + edited * 60_000).toISOString(),
  });
  const draft = (n, opts = {}) =>
    comment(n, `**Maintainer:** draft ${n}\n\n\`\`\`team-draft\n${JSON.stringify({ issues: [task(`t${n}`)] })}\n\`\`\``, opts);
  const trusted = new Set(["multi-agency", "jlwaugh"]);  // the bot and an owner

  test("recognises the command", () => {
    assert.equal(isApproval(comment(1, "/approve")), true);
    assert.equal(isApproval(comment(1, " /approve looks good")), true);
    assert.equal(isApproval(comment(1, "I approve")), false);
  });

  test("takes the latest draft posted before the command, never a later one", () => {
    const command = comment(4, "/approve");
    const thread = [draft(1), comment(2, "chatter"), draft(3), command, draft(5)];
    const found = draftFor(thread, command, trusted);
    assert.equal(found.comment.id, 3);
    assert.deepEqual(found.issues.map(i => i.key), ["t3"]);
    assert.equal(draftFor([command, draft(5)], command, trusted), undefined);
  });

  test("a bare command takes the latest draft by the bot or an owner, skipping a stranger's", () => {
    const command = comment(4, "/approve", { at: 10 });
    // Posted after the bot's draft and before the command: not what the owner saw.
    const thread = [draft(1, { login: "multi-agency", at: 1 }), draft(2, { login: "stranger", at: 2 }), command];
    assert.equal(draftFor(thread, command, trusted).comment.id, 1);
    assert.equal(
      draftFor([draft(1, { login: "stranger", at: 1 }), draft(2, { login: "multi-agency", at: 2 }), command], command, trusted).comment.id, 2);
    // A stranger's draft is skipped, not refused: with only one, there is no draft.
    assert.equal(draftFor([draft(1, { login: "stranger", at: 1 }), command], command, trusted), undefined);
  });

  test("a link names exactly that draft, whoever posted it", () => {
    const strangers = draft(2, { login: "stranger", at: 2 });
    const command = comment(3, `/approve ${strangers.html_url} — this one`, { at: 10 });
    const thread = [draft(1, { login: "multi-agency", at: 1 }), strangers, command];
    const named = namedDraft(thread, command, 28, trusted);
    assert.equal(named.draft.comment.id, 2);
    assert.deepEqual(named.draft.issues.map(i => i.key), ["t2"]);
    // Named, not latest: an earlier draft linked by the owner is the one approved.
    const earlier = draft(1, { login: "multi-agency", at: 1 });
    const naming = comment(3, `/approve ${earlier.html_url}`, { at: 10 });
    assert.equal(namedDraft([earlier, draft(2, { at: 2 }), naming], naming, 28, trusted).draft.comment.id, 1);
  });

  test("a link names its draft however it is written, and refuses one it cannot resolve", () => {
    const strangers = draft(2, { login: "stranger", at: 2 });
    const thread = [strangers];
    const sloppy = comment(3, "/approve http://www.github.com/MultiAgency/kanban-sandbox/issues/28#issuecomment-2", { at: 10 });
    assert.equal(namedDraft(thread, sloppy, 28, trusted).draft.comment.id, 2);
    const bare = comment(3, "/approve — the second one: #issuecomment-2", { at: 10 });
    assert.equal(namedDraft(thread, bare, 28, trusted).draft.comment.id, 2);
    const nowhere = comment(3, "/approve #issuecomment-99", { at: 10 });
    assert.match(namedDraft(thread, nowhere, 28, trusted).refusal, /not on this job/);
  });

  test("other trailing text keeps the bare behaviour", () => {
    const command = comment(3, "/approve looks good", { at: 10 });
    assert.equal(namedDraft([draft(1), command], command, 28, trusted), null);
  });

  test("a link to a comment that is not a draft on this job is refused", () => {
    const command = comment(2, `/approve ${repoUrl}/issues/29#issuecomment-1`, { at: 10 });
    assert.match(namedDraft([draft(1), command], command, 28, trusted).refusal, /not on this job/);
    const missing = comment(2, `/approve ${repoUrl}/issues/28#issuecomment-99`, { at: 10 });
    assert.match(namedDraft([draft(1), missing], missing, 28, trusted).refusal, /not on this job/);
    const chatter = comment(1, "sounds fine to me", { at: 1 });
    const linked = comment(2, `/approve ${chatter.html_url}`, { at: 10 });
    assert.match(namedDraft([chatter, linked], linked, 28, trusted).refusal, /holds no team draft/);
  });

  test("a link to a draft posted or edited after the command is refused", () => {
    const later = draft(1, { login: "stranger", at: 11 });
    const command = comment(2, `/approve ${later.html_url}`, { at: 10 });
    assert.match(namedDraft([command, later], command, 28, trusted).refusal, /posted after the command/);
    const edited = draft(1, { at: 1, edited: 11 });
    const before = comment(2, `/approve ${edited.html_url}`, { at: 10 });
    assert.match(namedDraft([edited, before], before, 28, trusted).refusal, /edited after the command/);
  });

  test("a link to a stranger's draft edited since it was posted is refused", () => {
    const revised = draft(1, { login: "stranger", at: 1, edited: 5 });
    const command = comment(2, `/approve ${revised.html_url}`, { at: 10 });
    assert.match(namedDraft([revised, command], command, 28, trusted).refusal, /edited after it was posted/);
    // The bot's own revision stands: a trusted author may edit its draft.
    const bots = draft(1, { login: "multi-agency", at: 1, edited: 5 });
    const approving = comment(2, `/approve ${bots.html_url}`, { at: 10 });
    assert.equal(namedDraft([bots, approving], approving, 28, trusted).draft.comment.id, 1);
  });

  test("reports a draft whose block is not valid JSON, rather than skipping it", () => {
    const broken = comment(1, "```team-draft\n{ not json\n```");
    const command = comment(2, "/approve");
    assert.deepEqual(draftFor([broken, command], command, trusted), { comment: broken, issues: null });
  });
});

