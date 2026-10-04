import assert from "node:assert/strict";
import { describe, test } from "node:test";

// The worker folder's own logic, imported from the repository root, where its
// node_modules are not installed — hence these modules import nothing.
import {
  allowedTools, codeAccess, deliversCodeSeat, isCodeSeat, mayClaim, ship,
  CODE_REFUSAL, GIT_CREDENTIAL_HELPER,
} from "../agents/claude-worker/code-mode.mjs";
import { nextTask } from "../agents/claude-worker/next-task.mjs";
import { trustCheck } from "../agents/claude-worker/trust.mjs";

const seat = (labels, assignees = []) => ({
  labels: labels.map(name => ({ name })),
  assignees: assignees.map(login => ({ login })),
});

describe("code seat eligibility", () => {
  const codeSeat = seat(["ready", "agent-eligible", "skill:code"]);

  test("a code seat is claimable when the agent has the code skill", () => {
    assert.equal(mayClaim(codeSeat, ["code"]), true);
    assert.equal(mayClaim(codeSeat, ["research", "writing", "code"]), true);
  });

  test("a code seat is not claimable without the code skill", () => {
    assert.equal(mayClaim(codeSeat, ["research", "writing"]), false);
  });

  test("a seat needing a second skill the agent lacks is not claimable", () => {
    const both = seat(["ready", "agent-eligible", "skill:code", "skill:review"]);
    assert.equal(mayClaim(both, ["code"]), false);
    assert.equal(mayClaim(both, ["code", "review"]), true);
  });

  test("the other claim rules still hold on a code seat", () => {
    assert.equal(mayClaim(seat(["agent-eligible", "skill:code"]), ["code"]), false, "not ready");
    assert.equal(mayClaim(seat(["ready", "skill:code"]), ["code"]), false, "not agent-eligible");
    assert.equal(mayClaim(seat(["ready", "agent-eligible", "skill:code"], ["near-builder"]), ["code"]), false, "assigned");
    assert.equal(mayClaim(seat(["ready", "agent-eligible", "human-only", "skill:code"]), ["code"]), false, "human-only");
  });

  test("a code seat is one labelled skill:code", () => {
    assert.equal(isCodeSeat(codeSeat), true);
    assert.equal(isCodeSeat(seat(["ready", "skill:writing"])), false);
  });
});

describe("CODE_ACCESS", () => {
  test("an agent without the code skill has none, whatever CODE_ACCESS says", () => {
    assert.equal(codeAccess(["research", "writing"], undefined), null);
    assert.equal(codeAccess(["research", "writing"], "branch"), null);
  });

  test("fork and branch are the two modes", () => {
    assert.equal(codeAccess(["code"], "fork"), "fork");
    assert.equal(codeAccess(["writing", "code"], "branch"), "branch");
  });

  test("an agent with the code skill must choose one", () => {
    assert.throws(() => codeAccess(["code"], undefined), /CODE_ACCESS is required/);
    assert.throws(() => codeAccess(["code"], ""), /CODE_ACCESS is required/);
    assert.throws(() => codeAccess(["code"], "sudo"), /CODE_ACCESS must be fork or branch/);
  });
});

describe("the git credential helper", () => {
  // gitcredentials(7): git runs a helper that is neither '!'-prefixed nor an
  // absolute path as `git credential-<value>`, and
  // `git credential-gh auth git-credential` does not exist — so a bare
  // "gh auth git-credential" makes every push fail.
  test("git runs it as a shell command, not as git credential-<value>", () => {
    assert.equal(GIT_CREDENTIAL_HELPER.startsWith("!"), true);
  });
});

describe("allowed tools per CODE_ACCESS", () => {
  const n = 14;
  const login = "near-builder";
  const base = [
    "Read(./**)", "Write(./**)", "Edit(./**)", "Glob", "Grep", "WebSearch", "WebFetch",
    "Bash(gh issue view:*)", "Bash(gh issue comment:*)", "Bash(gh api:*)",
    "mcp__multiagency__deliverable_sha256",
  ];

  test("without code mode: the board, the deliverable and research, nothing else", () => {
    assert.deepEqual(allowedTools(null, n, login), base);
  });

  test("branch mode adds only the exact commands the instructions give task 14", () => {
    assert.deepEqual(allowedTools("branch", n, login), [
      ...base,
      "Bash(git clone --branch staging https://github.com/MultiAgency/near-agencies.git .)",
      "Bash(git checkout:*)", "Bash(git add:*)", "Bash(git commit:*)",
      "Bash(git push -u origin task-14)",
      "Bash(npm ci)", "Bash(npm run check)", "Bash(npm test)",
      "Bash(gh pr create:*)", "Bash(gh pr view:*)",
    ]);
  });

  test("fork mode clones the fork, forks once and fetches upstream staging, not the repository", () => {
    assert.deepEqual(allowedTools("fork", n, login), [
      ...base,
      "Bash(git clone https://github.com/near-builder/near-agencies.git .)",
      "Bash(git fetch https://github.com/MultiAgency/near-agencies.git staging)",
      "Bash(gh repo fork MultiAgency/near-agencies --clone=false)",
      "Bash(git checkout:*)", "Bash(git add:*)", "Bash(git commit:*)",
      "Bash(git push -u origin task-14)",
      "Bash(npm ci)", "Bash(npm run check)", "Bash(npm test)",
      "Bash(gh pr create:*)", "Bash(gh pr view:*)",
    ]);
  });

  test("the push is the task's branch only: another task's branch is not pushable", () => {
    const tools = allowedTools("branch", 15, login);
    assert.equal(tools.includes("Bash(git push -u origin task-15)"), true);
    assert.equal(tools.includes("Bash(git push -u origin task-14)"), false);
  });

  test("no mode hands Claude the whole shell, a force-push or an arbitrary clone", () => {
    for (const tools of [allowedTools(null, n, login), allowedTools("fork", n, login), allowedTools("branch", n, login)]) {
      assert.equal(tools.includes("Bash(git status:*)"), false);
      assert.equal(tools.includes("Bash(git config:*)"), false);
      assert.equal(tools.includes("Bash(git push:*)"), false, "push:* would also allow --force and --delete on any branch");
      assert.equal(tools.includes("Bash(git clone:*)"), false, "clone:* accepts -c and --upload-pack, which run commands");
      assert.equal(tools.includes("Bash(npm install:*)"), false);
      assert.equal(tools.includes("Bash(npm publish:*)"), false);
      assert.equal(tools.includes("Bash(gh repo delete:*)"), false);
    }
  });
});

describe("the shipping instructions", () => {
  // Every command the instructions give must be one the allowlist allows:
  // the allowlist exists for these instructions and nothing else.
  const commanded = lines => [...lines.join("\n").matchAll(/`([^`]+)`/g)]
    .map(m => m[1]).filter(s => /^(git|gh|npm)\b/.test(s));
  const allowed = (tools, cmd) => tools.some(t => {
    const entry = t.match(/^Bash\((.+?)(?::\*)?\)$/);
    return entry && (cmd === entry[1] || (t.endsWith(":*)") && cmd.startsWith(`${entry[1]} `)));
  });

  test("fork mode: the fork once, upstream staging fetched, the branch from FETCH_HEAD, staging as the base", () => {
    const text = ship("fork", 14, "near-builder", false).join("\n");
    assert.match(text, /`git clone https:\/\/github\.com\/near-builder\/near-agencies\.git \.`/);
    assert.match(text, /`git fetch https:\/\/github\.com\/MultiAgency\/near-agencies\.git staging`/);
    assert.match(text, /`git checkout -b task-14 FETCH_HEAD`/, "task-14 starts at staging's tip, not at what the fork checked out");
    assert.match(text, /--head near-builder:task-14 --base staging/);
    assert.equal(text.includes("gh repo sync"), false, "no sync can create staging on a fork that lacks it");
  });

  test("branch mode: staging cloned by name, the branch from it, staging as the base", () => {
    const text = ship("branch", 14, "near-builder", false).join("\n");
    assert.match(text, /`git clone --branch staging https:\/\/github\.com\/MultiAgency\/near-agencies\.git \.`/);
    assert.match(text, /`git checkout -b task-14`/);
    assert.match(text, /--head task-14 --base staging/);
  });

  test("a revision checks out the task branch and opens no second pull request, in either mode", () => {
    for (const access of ["fork", "branch"]) {
      const text = ship(access, 14, "near-builder", true).join("\n");
      assert.match(text, /`git checkout task-14`/);
      assert.equal(text.includes("gh pr create"), false);
    }
  });

  test("every command the instructions give is one the allowlist allows", () => {
    for (const access of ["fork", "branch"]) {
      for (const revision of [false, true]) {
        const commands = commanded(ship(access, 14, "near-builder", revision));
        assert.equal(commands.length > 5, true, `${access}: the instructions do name commands`);
        for (const cmd of commands) {
          assert.equal(allowed(allowedTools(access, 14, "near-builder"), cmd), true, `${access}: ${cmd}`);
        }
      }
    }
  });
});

describe("code tools only on a delivered code seat", () => {
  const codeSeat = seat(["ready", "agent-eligible", "skill:code"]);
  const writingSeat = seat(["ready", "agent-eligible", "skill:writing"]);

  test("delivering a code seat is the one task that gets code mode", () => {
    assert.equal(deliversCodeSeat({ action: "deliver", seat: codeSeat }), true);
    assert.equal(deliversCodeSeat({ action: "deliver", seat: codeSeat, revision: true }), true);
  });

  test("claiming a code seat does not: a claim only comments /claim", () => {
    assert.equal(deliversCodeSeat({ action: "claim", seat: codeSeat }), false);
  });

  test("delivering any other seat does not, whatever the agent's skills", () => {
    assert.equal(deliversCodeSeat({ action: "deliver", seat: writingSeat }), false);
    assert.equal(deliversCodeSeat({ action: "deliver", seat: seat([]) }), false);
  });

  test("a code seat assigned to an agent without code mode gets none of it", () => {
    // Native GitHub assignment counts as a claim without a skill check, so a
    // worker without the code skill (codeMode null) can find itself delivering
    // a skill:code seat. It must neither ship it nor hand it out to Claude:
    // the gate is code mode as well as the seat, and the run says on the task
    // why it cannot take it instead.
    assert.equal(deliversCodeSeat({ action: "deliver", seat: codeSeat }), true, "the seat alone would ship it");
    const withoutCodeMode = Boolean(null) && deliversCodeSeat({ action: "deliver", seat: codeSeat });
    assert.equal(withoutCodeMode, false);
    const withCodeMode = Boolean("fork") && deliversCodeSeat({ action: "deliver", seat: codeSeat });
    assert.equal(withCodeMode, true);
    // The same gate, expressed the way worker.mjs runs it.
    assert.equal(allowedTools(withoutCodeMode ? "branch" : null, 14, "near-builder").includes("Bash(npm ci)"), false);
    assert.equal(allowedTools(withCodeMode ? "branch" : null, 14, "near-builder").includes("Bash(npm ci)"), true);
  });
});

// One agent's view of the board, shared by the nextTask() describes below:
// the seat issues, their threads, and the collaborator roles a trust check
// looks up (the bot is multi-agency, the board's coordinator; everyone else
// defaults to read). Posts are recorded, not sent.
const login = "near-builder";
const skills = ["research", "writing"];
const bot = "multi-agency";
const c = (user, body) => ({ user: { login: user }, body });
const seatIssue = (number, labels, assignees = [], created_at = "2026-10-01T00:00:00Z") => ({
  number,
  created_at,
  body: "Part of job #5.\n\n```terms\nengagement: job 5\n```",
  assignees: assignees.map(l => ({ login: l })),
  labels: labels.map(name => ({ name })),
});
const board = (issues, threads = {}, events = {}, roles = {}) => async path => {
  if (path === "/issues?state=open&per_page=100") return issues;
  const permission = path.match(/^\/collaborators\/([^/]+)\/permission$/);
  if (permission) return { role_name: roles[decodeURIComponent(permission[1])] ?? "read" };
  const on = path.match(/^\/issues\/(\d+)\/(comments|events)/);
  if (!on) throw new Error(`unexpected GET ${path}`);
  return (on[2] === "comments" ? threads : events)[on[1]] ?? [];
};
const harness = (issues, threads = {}, events = {}, extra = {}) => {
  const posted = [];
  return {
    posted,
    threads,
    task: () => nextTask({
      github: board(issues, threads, events, extra.roles),
      comment: async (number, body) => { posted.push({ number, body }); },
      login, skills, codeMode: null, bot, ...extra,
    }),
  };
};

describe("an assigned code seat on a run without code mode", () => {
  test("the refusal is posted once, not again on every cron run", async () => {
    const { task, posted, threads } = harness([seatIssue(14, ["skill:code"], [login])], { 14: [] });
    assert.deepEqual(await task(), null, "the run refuses the seat and has nothing else to take");
    assert.deepEqual(posted, [{ number: 14, body: CODE_REFUSAL }]);
    threads[14].push(c(login, CODE_REFUSAL));      // the comment the run left
    assert.deepEqual(await task(), null);          // ten minutes later
    assert.deepEqual(posted, [{ number: 14, body: CODE_REFUSAL }], "not refused a second time");
  });

  test("a new ```changes round asks anew", async () => {
    const { task, posted } = harness(
      [seatIssue(14, ["skill:code"], [login])],
      { 14: [c("agency-owner", "Once more:\n```changes\naddress the review\n```"), c(login, CODE_REFUSAL)] },
      {},
      { roles: { "agency-owner": "maintain" } },
    );
    assert.deepEqual(await task(), null);
    assert.deepEqual(posted, [], "the refusal from the last round still stands");
  });

  test("the run moves on to the seats it can deliver", async () => {
    const { task, posted } = harness(
      [seatIssue(14, ["skill:code"], [login]), seatIssue(15, ["skill:writing"], [login])],
      { 14: [], 15: [] },
    );
    const picked = await task();
    assert.deepEqual(posted, [{ number: 14, body: CODE_REFUSAL }]);
    assert.equal(picked.action, "deliver");
    assert.equal(picked.seat.number, 15, "the code seat did not stop the writing seat");
    assert.equal(picked.revision, false);
  });

  test("with code mode the assigned code seat is delivered as before", async () => {
    const { task, posted } = harness(
      [seatIssue(14, ["skill:code"], [login])],
      { 14: [] },
      {},
      { codeMode: "branch" },
    );
    const picked = await task();
    assert.deepEqual(posted, []);
    assert.equal(picked.action, "deliver");
    assert.equal(picked.seat.number, 14);
  });

  test("a dry run names the next task and posts nothing", async () => {
    const { task, posted } = harness(
      [seatIssue(14, ["skill:code"], [login]), seatIssue(15, ["skill:writing"], [login])],
      { 14: [], 15: [] },
      {},
      { dryRun: true },
    );
    const picked = await task();
    assert.deepEqual(posted, []);
    assert.equal(picked.action, "deliver");
    assert.equal(picked.seat.number, 15);
  });

  test("with nothing assigned it still claims the first ready seat it may", async () => {
    const { task, posted } = harness([seatIssue(16, ["ready", "agent-eligible"])], { 16: [] });
    const picked = await task();
    assert.deepEqual(posted, []);
    assert.equal(picked.action, "claim");
    assert.equal(picked.seat.number, 16);
  });
});

// The ```changes boundary both nextTask() places read — the revision round a
// handoff must be newer than, and the round a refusal is counted within —
// counts only a round the board credits: the bot's or an owner's, the same
// rule the coordinator applies. A stranger's block opens no round, so it can
// neither reopen a handed-off task (a second deliverable, a second paid run)
// nor un-count a refusal.
describe("the ```changes boundary counts only the bot or an owner", () => {
  const changes = user => c(user, "Once more:\n```changes\naddress the review\n```");
  const handoff = c(login, "Done.\n\n```handoff\nlinks: x\n```");

  test("a stranger's ```changes after a handoff leaves the task handed off", async () => {
    const { task } = harness(
      [seatIssue(15, ["skill:writing"], [login])],
      { 15: [handoff, changes("stranger")] },
    );
    assert.deepEqual(await task(), null, "the stranger's round is not one: no second delivery");
  });

  test("the bot's ```changes after a handoff still starts a new round", async () => {
    const { task } = harness(
      [seatIssue(15, ["skill:writing"], [login])],
      { 15: [handoff, changes(bot)] },
    );
    const picked = await task();
    assert.equal(picked.action, "deliver");
    assert.equal(picked.revision, true);
  });

  test("an owner's ```changes starts one too", async () => {
    const { task } = harness(
      [seatIssue(15, ["skill:writing"], [login])],
      { 15: [handoff, changes("jlwaugh")] },
      {},
      { roles: { jlwaugh: "admin" } },
    );
    const picked = await task();
    assert.equal(picked.revision, true);
  });

  test("a stranger's ```changes leaves an earlier refusal counted", async () => {
    const { task, posted } = harness(
      [seatIssue(14, ["skill:code"], [login])],
      { 14: [changes(bot), c(login, CODE_REFUSAL), changes("stranger")] },
    );
    assert.deepEqual(await task(), null);
    assert.deepEqual(posted, [], "the refusal from the bot's round still stands");
  });

  test("the bot's ```changes after the refusal asks anew", async () => {
    const { task, posted } = harness(
      [seatIssue(14, ["skill:code"], [login])],
      { 14: [c(login, CODE_REFUSAL), changes(bot)] },
    );
    assert.deepEqual(await task(), null);
    assert.deepEqual(posted, [{ number: 14, body: CODE_REFUSAL }]);
  });
});

describe("the trust check", () => {
  const roles = map => async path => {
    const permission = path.match(/^\/collaborators\/([^/]+)\/permission$/);
    if (!permission) throw new Error(`unexpected GET ${path}`);
    const role = map[decodeURIComponent(permission[1])];
    if (role === undefined) throw new Error(`GitHub GET ${path}: 404`);
    return { role_name: role };
  };

  test("the bot is trusted with no lookup at all, a stranger is not", async () => {
    const trusted = trustCheck({ github: roles({}), bot });
    assert.equal(await trusted("multi-agency"), true);
    assert.equal(await trusted("Multi-Agency"), true, "logins are not case-sensitive");
    assert.equal(await trusted("stranger"), false, "a 404 role lookup is no role");
  });

  test("an owner (admin or maintain) is trusted, a reader is not", async () => {
    const trusted = trustCheck({ github: roles({ jlwaugh: "admin", second: "maintain", reader: "read" }), bot });
    assert.equal(await trusted("jlwaugh"), true);
    assert.equal(await trusted("second"), true);
    assert.equal(await trusted("reader"), false);
  });

  test("a failed lookup is not trusted, and is not kept as an answer", async () => {
    let up = false;
    const flaky = async path => {
      if (!/^\/collaborators\/[^/]+\/permission$/.test(path) || !up) throw new Error(`GitHub GET ${path}: 503`);
      return { role_name: "admin" };
    };
    const trusted = trustCheck({ github: flaky, bot });
    assert.equal(await trusted("jlwaugh"), false, "while the lookup fails, the round is not one");
    up = true;
    assert.equal(await trusted("jlwaugh"), true, "the failed lookup was not kept");
  });
});
