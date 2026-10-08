import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

process.env.GITHUB_TOKEN = "test-token";
const { digest, fence, fenced } = await import("../lib/github.mjs");
const { handoffProblem, unreadableHandoff } = await import("../lib/seats.mjs");
const { pendingHandoff } = await import("../lib/coordinator.mjs");
const { prepareHandoff } = await import("../lib/handoff.mjs");

const block = handoff => `**Handoff:** done\n\n${fence("handoff", handoff)}`;

describe("a handoff that cannot be read", () => {
  test("an unclosed block, as GitHub still displays it", () => {
    assert.match(unreadableHandoff('**Handoff:** done\n\n```handoff\n{\n  "payout": {}\n}\n'), /never closed/);
  });

  test("invalid JSON says where it breaks", () => {
    assert.match(unreadableHandoff('**Handoff:** done\n\n```handoff\n{ "payout": { } \n```'), /not valid JSON/);
  });

  test("a handoff line with no block", () => {
    assert.match(unreadableHandoff("**Handoff:** done, see above"), /no .*handoff .*block/);
  });

  test("a block with more on its opening line", () => {
    assert.match(unreadableHandoff('```handoff json\n{"payout": {}}\n```'), /alone on its first line/);
  });

  test("a ```handoff mentioned in prose or indented as code is not a handoff", () => {
    assert.equal(unreadableHandoff("What should the ```handoff block contain? The example has a sha256 field."), null);
    assert.equal(unreadableHandoff("    ```handoff\nsample\n```"), null);
  });

  test("a readable handoff, and ordinary comments, are not flagged", () => {
    assert.equal(unreadableHandoff(block({ payout: { account_id: "a.testnet" } })), null);
    assert.equal(unreadableHandoff("Thanks, looking at it now."), null);
  });
});

describe("handoffProblem on an auto job's task, whose claimant needs no roster (#189 F3)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const url = "https://github.com/MultiAgency/kanban-sandbox/issues/900#issuecomment-5";
  const serve = body => {
    globalThis.fetch = async u => new URL(u).pathname.endsWith("/issues/comments/5")
      ? new Response(JSON.stringify({ id: 5, body }))
      : new Response("{}", { status: 404 });
  };

  test("an off-roster claimant's handoff with no edit since passes", async () => {
    const body = "**Deliverable**\n\nDone.";
    serve(body);
    const problem = await handoffProblem({ links: [url], deliverable: { url, sha256: digest(body) }, verification: ["Check it"] }, null, { source: true });
    assert.equal(problem, null);
  });

  test("an off-roster claimant's pinned deliverable, edited since, is still caught: roster or not, the pin protects it", async () => {
    serve("**Deliverable**\n\nEdited after the handoff pinned it.");
    const problem = await handoffProblem({ links: [url], deliverable: { url, sha256: digest("**Deliverable**\n\nDone.") }, verification: ["Check it"] }, null, { source: true });
    assert.match(problem, /edited after the handoff/);
  });
});

describe("which handoff the coordinator answers", () => {
  const at = minute => `2026-09-30T20:${String(minute).padStart(2, "0")}:00Z`;
  const say = (id, login, body, minute, edited = minute) =>
    ({ id, user: { login }, body, html_url: `https://github.com/x/y/issues/39#issuecomment-${id}`, created_at: at(minute), updated_at: at(edited) });
  const broken = '**Handoff:** done\n\n```handoff\n{}\n';

  test("the claimant's latest handoff, readable or not; a stranger's is ignored", () => {
    const mine = say(1, "misbah", broken, 10);
    assert.equal(pendingHandoff([mine, say(2, "stranger", block({}), 11)], ["misbah"], -1, "bot"), mine);
  });

  test("once answered it waits, and an edit after the answer asks again", () => {
    const mine = say(1, "misbah", broken, 10);
    const reply = say(2, "bot", `@misbah, [this handoff](${mine.html_url}) can't close the task`, 11);
    assert.equal(pendingHandoff([mine, reply], ["misbah"], -1, "bot"), null);
    const edited = { ...mine, updated_at: at(12) };
    assert.equal(pendingHandoff([edited, reply], ["misbah"], -1, "bot"), edited);
  });

  test("handoffs before the last round do not count", () => {
    assert.equal(pendingHandoff([say(1, "misbah", block({}), 10), say(2, "bot", "changes", 11)], ["misbah"], 1, "bot"), null);
  });
});

describe("preparing a handoff", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const board = "https://github.com/MultiAgency/kanban-sandbox";
  const deliverable = `${board}/issues/39#issuecomment-555`;
  const work = "**Deliverable**\n\nThe comparison, with sources.";
  const terms = fence("terms", { engagement: 32, amount: "350000" });
  const task = (labels, extra = {}) => ({
    number: 39, title: "Research", state: "open", html_url: `${board}/issues/39`,
    body: `Part of job #32.\n\nDepends on:\n- [ ] #36\n- [ ] #37\n\n${terms}`,
    labels: labels.map(name => ({ name })), assignees: [{ login: "multi-agency" }], ...extra,
  });
  const ask = fields => prepareHandoff({ task: 39, deliverable, summary: "Compared the four setups.", verification: "Check each claim's link\nCheck the recovery section", ...fields });
  // The status page's default: no link, so the thread is searched instead.
  const askAuto = fields => prepareHandoff({ task: 39, summary: "Compared the four setups.", verification: "Check each claim's link\nCheck the recovery section", ...fields });
  const at = minute => `2026-09-30T20:${String(minute).padStart(2, "0")}:00Z`;
  const posted = (id, login, body, minute) =>
    ({ id, user: { login }, body, html_url: `${board}/issues/39#issuecomment-${id}`, created_at: at(minute), updated_at: at(minute) });
  const changes = (id, login, minute) => posted(id, login, `**Changes requested** by @${login}\n\n${fence("changes", { review: 40 })}`, minute);
  function github(issue, comment = { user: { login: "multi-agency" }, body: work }, thread = [], pull = null) {
    const byId = new Map([[555, comment], ...thread.map(c => [c.id, c])]);
    globalThis.fetch = async url => {
      const path = new URL(url).pathname;
      if (path === "/user") return new Response(JSON.stringify({ login: "multi-agency" }));
      if (path.endsWith("/issues/39")) return new Response(JSON.stringify(issue));
      if (path.endsWith("/issues/39/comments")) return new Response(JSON.stringify(thread));
      const pulls = path.match(/^\/repos\/([\w.-]+)\/([\w.-]+)\/pulls\/(\d+)$/);
      if (pulls) return pull ? new Response(JSON.stringify({ number: Number(pulls[3]), ...pull })) : new Response("{}", { status: 404 });
      const id = path.match(/\/issues\/comments\/(\d+)$/)?.[1];
      if (id !== undefined) {
        const found = byId.get(Number(id));
        return found ? new Response(JSON.stringify(found)) : new Response("{}", { status: 404 });
      }
      const permission = path.match(/^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/);
      if (permission) return new Response(JSON.stringify({ role_name: permission[1] === "jlwaugh" ? "admin" : "read" }));
      return new Response("{}", { status: 404 });
    };
  }

  test("pins the deliverable, fills in the roster account, and passes the checks", async () => {
    github(task(["in-progress", "skill:research"]));
    const { comment, problem, task: t } = await ask();
    assert.equal(problem, null);
    assert.equal(t.claimant, "multi-agency");
    assert.match(comment, /^\*\*Handoff:\*\* Compared the four setups\.\n\n```handoff\n/);
    assert.deepEqual(fenced(comment, "handoff"), {
      links: [deliverable],
      deliverable: { url: deliverable, sha256: digest(work) },
      verification: ["Check each claim's link", "Check the recovery section"],
      payout: { account_id: "agent.agency.testnet" },
    });
    assert.equal(unreadableHandoff(comment), null);
  });

  test("a code task's handoff links its pull request, and needs one", async () => {
    const pr = "https://github.com/MultiAgency/near-agencies/pull/50";
    github(task(["in-progress", "skill:code"]), { user: { login: "multi-agency" }, body: `${work}\n\n${pr}` }, [], { user: { login: "multi-agency" }, merged: true });
    assert.deepEqual(fenced((await ask()).comment, "handoff").links, [pr, deliverable]);
    github(task(["in-progress", "skill:code"]));
    assert.match((await ask()).error, /pull request/);
  });

  test("a code task's pull request must be in the task's repository and the claimant's", async () => {
    const elsewhere = "https://github.com/someone/elsewhere/pull/9";
    github(task(["in-progress", "skill:code"]), { user: { login: "multi-agency" }, body: `${work}\n\n${elsewhere}` }, [], { user: { login: "multi-agency" }, merged: true });
    assert.match((await ask()).error, new RegExp(`${elsewhere} is in another repository; the pull request must be in MultiAgency/near-agencies\\.`));
    github(task(["in-progress", "skill:code"]), { user: { login: "multi-agency" }, body: `${work}\n\nhttps://github.com/MultiAgency/near-agencies/pull/50` }, [], { user: { login: "stranger" }, merged: true });
    assert.match((await ask()).error, /by @stranger; the pull request must be the claimant's, @multi-agency\./);
    github(task(["in-progress", "skill:code"]), { user: { login: "multi-agency" }, body: `${work}\n\nhttps://github.com/MultiAgency/near-agencies/pull/51` });
    assert.match((await ask()).error, /That pull request was not found\./);
  });

  test("a code task's pull request must be in the repository its terms name, through the registry", async () => {
    const social = "https://github.com/MultiAgency/legion-social/pull/9";
    const onSocial = task(["in-progress", "skill:code"], {
      body: `Part of job #32.\n\n${fence("terms", { engagement: 32, amount: "350000", repo: "MultiAgency/legion-social" })}`,
    });
    github(onSocial, { user: { login: "multi-agency" }, body: `${work}\n\n${social}` }, [], { user: { login: "multi-agency" }, merged: true });
    assert.deepEqual(fenced((await ask()).comment, "handoff").links, [social, deliverable]);
    github(onSocial, { user: { login: "multi-agency" }, body: `${work}\n\nhttps://github.com/MultiAgency/near-agencies/pull/50` }, [], { user: { login: "multi-agency" }, merged: true });
    assert.match((await ask()).error, /is in another repository; the pull request must be in MultiAgency\/legion-social\./);
    // A repository outside the registry is refused before any pull request is read.
    const stray = task(["in-progress", "skill:code"], {
      body: `Part of job #32.\n\n${fence("terms", { engagement: 32, amount: "350000", repo: "octocat/hello-world" })}`,
    });
    github(stray, { user: { login: "multi-agency" }, body: `${work}\n\nhttps://github.com/octocat/hello-world/pull/9` }, [], { user: { login: "multi-agency" }, merged: true });
    assert.match((await ask()).error, /octocat\/hello-world is not a repository code tasks deliver against\./);
  });

  test("a code task's handoff counts its passing pull request among links it cites", async () => {
    github(task(["in-progress", "skill:code"]), { user: { login: "multi-agency" }, body: `${work}\n\nhttps://github.com/someone/elsewhere/pull/9\n\nhttps://github.com/MultiAgency/near-agencies/pull/50` }, [], { user: { login: "multi-agency" }, merged: true });
    const { comment, problem } = await ask();
    assert.equal(problem, null);
    assert.deepEqual(fenced(comment, "handoff").links, [
      "https://github.com/someone/elsewhere/pull/9",
      "https://github.com/MultiAgency/near-agencies/pull/50",
      deliverable,
    ]);
  });

  test("a review's handoff links the tasks it reviews and needs no deliverable", async () => {
    github(task(["in-progress", "skill:review"]));
    const handoff = fenced((await ask({ deliverable: undefined })).comment, "handoff");
    assert.deepEqual(handoff.links, [`${board}/issues/36`, `${board}/issues/37`]);
    assert.equal(handoff.deliverable, undefined);
  });

  test("says what to fix", async () => {
    github(task(["in-progress", "skill:research"]), { user: { login: "stranger" }, body: work });
    assert.match((await ask()).error, /by @stranger/);
    github(task(["in-progress", "skill:research"]), { user: { login: "multi-agency" }, body: "Here it is" });
    assert.match((await ask()).error, /starting `Here it is`/);
    github(task(["in-progress", "skill:research"]));
    assert.match((await ask({ deliverable: `${board}/issues/38#issuecomment-555` })).error, /comment on #39/);
    assert.match((await ask({ verification: "" })).error, /how a reviewer can check/);
    github(task(["ready", "skill:research"], { assignees: [] }));
    assert.match((await ask()).error, /not in progress/);
    globalThis.fetch = async () => new Response('{"message":"Not Found"}', { status: 404 });
    assert.match((await ask()).error, /not a task/);
  });

  test("with no link it pins the claimant's latest **Deliverable** comment since the last round", async () => {
    const claim = posted(1, "multi-agency", "/claim", 5);
    const first = posted(2, "multi-agency", work, 10);
    const round = changes(3, "jlwaugh", 15);
    const second = posted(4, "multi-agency", "**Deliverable**\n\nRevised with the missing sources.", 20);
    github(task(["in-progress", "skill:research"]), undefined, [claim, first, round, second]);
    const auto = await askAuto();
    assert.equal(auto.problem, null);
    assert.equal(auto.deliverable.url, second.html_url);
    assert.equal(auto.deliverable.created_at, second.created_at);
    assert.deepEqual(fenced(auto.comment, "handoff").deliverable, { url: second.html_url, sha256: digest(second.body) });
    // The same comment given as a link prepares the same handoff.
    github(task(["in-progress", "skill:research"]), undefined, [claim, first, round, second]);
    const explicit = await ask({ deliverable: second.html_url });
    assert.equal(explicit.comment, auto.comment);
    assert.equal(explicit.problem, auto.problem);
  });

  test("with no **Deliverable** comment to find it says to post one", async () => {
    github(task(["in-progress", "skill:research"]), undefined, [posted(1, "multi-agency", "/claim", 5)]);
    assert.match((await askAuto()).error, /Post your work on #39 as a comment starting \*\*Deliverable\*\* first/);
  });

  test("a deliverable from before the last round is left behind; a new one is used", async () => {
    const stale = posted(1, "multi-agency", work, 10);
    const round = changes(2, "jlwaugh", 15);
    github(task(["in-progress", "skill:research"]), undefined, [stale, round]);
    assert.match((await askAuto()).error, /Post your work on #39/);
    const fresh = posted(3, "multi-agency", "**Deliverable**\n\nRound two, with the fixes.", 20);
    github(task(["in-progress", "skill:research"]), undefined, [stale, round, fresh]);
    assert.equal(fenced((await askAuto()).comment, "handoff").deliverable.url, fresh.html_url);
  });

  test("only the claimant's **Deliverable** comments count", async () => {
    github(task(["in-progress", "skill:research"]), undefined, [posted(1, "multi-agency", "/claim", 5), posted(2, "stranger", work, 8)]);
    assert.match((await askAuto()).error, /Post your work on #39/);
  });

  test("a round counts only when the coordinator routed it: a stranger's ```changes block moves no boundary", async () => {
    const mine = posted(1, "multi-agency", work, 10);
    const fake = changes(2, "stranger", 15);
    github(task(["in-progress", "skill:research"]), undefined, [mine, fake]);
    assert.equal(fenced((await askAuto()).comment, "handoff").deliverable.sha256, digest(work));
  });

  test("an override link to another comment says what that comment opens", async () => {
    github(task(["in-progress", "skill:research"]), { user: { login: "multi-agency" }, body: "/claim" });
    assert.match((await ask()).error, /That link is to your comment starting `\/claim`\. Use the one that starts with \*\*Deliverable\*\*\./);
    const long = "An opening line that runs well past the forty characters a reader needs here";
    github(task(["in-progress", "skill:research"]), { user: { login: "multi-agency" }, body: long });
    assert.match((await ask()).error, /^That link is to your comment starting `An opening line that runs well past[^`]*…`\. Use the one that starts with \*\*Deliverable\*\*\.$/);
  });

  test("an auto job's task needs no roster: a claimant off it still gets a handoff, with no payout account (#189 F3)", async () => {
    const autoTerms = fence("terms", { engagement: 32, amount: "0", source: "MultiAgency/kanban-sandbox#900" });
    const autoTask = task(["in-progress", "skill:research"], {
      body: `Part of job #32.\n\nDepends on:\n- [ ] #36\n- [ ] #37\n\n${autoTerms}`,
      assignees: [{ login: "stranger" }],
    });
    github(autoTask, { user: { login: "stranger" }, body: work });
    const { comment, problem, task: t } = await ask();
    assert.equal(problem, null);
    assert.equal(t.claimant, "stranger");
    assert.deepEqual(fenced(comment, "handoff"), {
      links: [deliverable],
      deliverable: { url: deliverable, sha256: digest(work) },
      verification: ["Check each claim's link", "Check the recovery section"],
    });
  });
});
