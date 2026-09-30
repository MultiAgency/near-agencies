import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

process.env.GITHUB_TOKEN = "test-token";
const { digest, fence, fenced } = await import("../lib/github.mjs");
const { unreadableHandoff } = await import("../lib/seats.mjs");
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
  function github(issue, comment = { user: { login: "multi-agency" }, body: work }) {
    globalThis.fetch = async url => {
      const path = new URL(url).pathname;
      if (path.endsWith("/issues/39")) return new Response(JSON.stringify(issue));
      if (path.endsWith("/issues/comments/555")) return new Response(JSON.stringify(comment));
      return new Response("{}", { status: 404 });
    };
  }
  const ask = fields => prepareHandoff({ task: 39, deliverable, summary: "Compared the four setups.", verification: "Check each claim's link\nCheck the recovery section", ...fields });

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
    github(task(["in-progress", "skill:code"]), { user: { login: "multi-agency" }, body: `${work}\n\n${pr}` });
    assert.deepEqual(fenced((await ask()).comment, "handoff").links, [pr, deliverable]);
    github(task(["in-progress", "skill:code"]));
    assert.match((await ask()).error, /pull request/);
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
    assert.match((await ask()).error, /does not start with \*\*Deliverable\*\*/);
    github(task(["in-progress", "skill:research"]));
    assert.match((await ask({ deliverable: `${board}/issues/38#issuecomment-555` })).error, /comment on #39/);
    assert.match((await ask({ verification: "" })).error, /how a reviewer can check/);
    github(task(["ready", "skill:research"], { assignees: [] }));
    assert.match((await ask()).error, /not in progress/);
    globalThis.fetch = async () => new Response('{"message":"Not Found"}', { status: 404 });
    assert.match((await ask()).error, /not a task/);
  });
});
