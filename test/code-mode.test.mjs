import assert from "node:assert/strict";
import { describe, test } from "node:test";

// The worker folder's own logic, imported from the repository root, where its
// node_modules are not installed — hence these modules import nothing.
import {
  accessFor, allowedTools, codeAccess, codeImageRefusal, codeRepoRefusal,
  deliversCodeSeat, isCodeSeat, mayClaim, ship, termsOf,
  CODE_IMAGE_REFUSAL_FIRST_LINE, CODE_REPO_REFUSAL_FIRST_LINE, CODE_REFUSAL,
  GIT_CREDENTIAL_HELPER,
} from "../agents/claude-worker/code-mode.mjs";
import { codeRepo } from "../agents/claude-worker/repos.mjs";
import { nextTask } from "../agents/claude-worker/next-task.mjs";
import { trustCheck } from "../agents/claude-worker/trust.mjs";

// The registry entries the tests ship against: near-agencies by default, and
// the rehearsal repository whose toolchain a node image lacks.
const near = codeRepo({});
const legion = codeRepo({ repo: "MultiAgency/legion-social" });

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

describe("accessFor", () => {
  test("near-agencies takes CODE_ACCESS; any other repository forks, whatever CODE_ACCESS says", () => {
    assert.equal(accessFor(near, "branch"), "branch");
    assert.equal(accessFor(near, "fork"), "fork");
    assert.equal(accessFor(legion, "branch"), "fork", "branch access holds nothing back on a repository the token has write on; legion-social is not it");
    assert.equal(accessFor(legion, "fork"), "fork");
  });
});

describe("allowed tools per CODE_ACCESS", () => {
  const n = 14;
  const login = "near-builder";
  const base = [
    "Read(./**)", "Write(./**)", "Edit(./**)", "Glob", "Grep", "WebSearch", "WebFetch",
    "Bash(gh issue view:*)", "Bash(gh issue comment:*)",
    "mcp__multiagency__deliverable_sha256",
  ];

  test("without code mode: the board, the deliverable and research, nothing else", () => {
    assert.deepEqual(allowedTools(null, near, n, login), base);
  });

  test("branch mode adds only the exact commands the instructions give task 14", () => {
    assert.deepEqual(allowedTools("branch", near, n, login), [
      ...base,
      "Bash(git clone --branch staging https://github.com/MultiAgency/near-agencies.git .)",
      "Bash(git checkout:*)", "Bash(git add:*)", "Bash(git commit:*)",
      "Bash(git push -u origin task-14)",
      "Bash(npm ci)", "Bash(npm run check)", "Bash(npm test)",
      "Bash(gh pr create:*)", "Bash(gh pr view:*)",
    ]);
  });

  test("fork mode clones the fork, forks once and fetches upstream staging, not the repository", () => {
    assert.deepEqual(allowedTools("fork", near, n, login), [
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

  test("legion-social forks, fetches its own staging and lists its registry's checks exactly, with no prefixes", () => {
    assert.deepEqual(allowedTools("fork", legion, 7, login), [
      ...base,
      "Bash(git clone https://github.com/near-builder/legion-social.git .)",
      "Bash(git fetch https://github.com/MultiAgency/legion-social.git staging)",
      "Bash(gh repo fork MultiAgency/legion-social --clone=false)",
      "Bash(git checkout:*)", "Bash(git add:*)", "Bash(git commit:*)",
      "Bash(git push -u origin task-7)",
      ...legion.checks.map(c => `Bash(${c})`),
      "Bash(gh pr create:*)", "Bash(gh pr view:*)",
    ]);
  });

  test("the push is the task's branch only: another task's branch is not pushable", () => {
    for (const repo of [near, legion]) {
      const tools = allowedTools("fork", repo, 15, login);
      assert.equal(tools.includes("Bash(git push -u origin task-15)"), true);
      assert.equal(tools.includes("Bash(git push -u origin task-14)"), false);
    }
  });

  test("no mode allows gh api: the token would reach every endpoint a planted comment names", () => {
    for (const tools of [
      allowedTools(null, near, n, login),
      allowedTools("fork", near, n, login),
      allowedTools("branch", near, n, login),
      allowedTools("fork", legion, n, login),
    ]) {
      assert.equal(tools.some(t => t.includes("gh api")), false,
        "gh api approves, closes, relabels and deletes whatever the token can; hashing is deliverable_sha256's job");
    }
  });

  test("no mode hands Claude the whole shell, a force-push or an arbitrary clone", () => {
    for (const tools of [
      allowedTools(null, near, n, login),
      allowedTools("fork", near, n, login),
      allowedTools("branch", near, n, login),
      allowedTools("fork", legion, n, login),
    ]) {
      assert.equal(tools.includes("Bash(git status:*)"), false);
      assert.equal(tools.includes("Bash(git config:*)"), false);
      assert.equal(tools.includes("Bash(git push:*)"), false, "push:* would also allow --force and --delete on any branch");
      assert.equal(tools.includes("Bash(git clone:*)"), false, "clone:* accepts -c and --upload-pack, which run commands");
      assert.equal(tools.includes("Bash(npm install:*)"), false);
      assert.equal(tools.includes("Bash(npm publish:*)"), false);
      assert.equal(tools.includes("Bash(cargo:*)"), false, "the checks are exact commands, not prefixes: cargo publish would ride a prefix");
      assert.equal(tools.includes("Bash(gh repo delete:*)"), false);
    }
  });
});

describe("the shipping instructions", () => {
  // Every command the instructions give must be one the allowlist allows:
  // the allowlist exists for these instructions and nothing else.
  const commanded = lines => [...lines.join("\n").matchAll(/`([^`]+)`/g)]
    .map(m => m[1]).filter(s => /^(git|gh|npm|cargo)\b/.test(s));
  const allowed = (tools, cmd) => tools.some(t => {
    const entry = t.match(/^Bash\((.+?)(?::\*)?\)$/);
    return entry && (cmd === entry[1] || (t.endsWith(":*)") && cmd.startsWith(`${entry[1]} `)));
  });
  // The repository/access pairs a run can actually meet: accessFor decides.
  const shipping = [[near, "fork"], [near, "branch"], [legion, "fork"]];

  test("fork mode: the fork once, upstream staging fetched, the branch from FETCH_HEAD, staging as the base", () => {
    const text = ship("fork", near, 14, "near-builder", false).join("\n");
    assert.match(text, /`git clone https:\/\/github\.com\/near-builder\/near-agencies\.git \.`/);
    assert.match(text, /`git fetch https:\/\/github\.com\/MultiAgency\/near-agencies\.git staging`/);
    assert.match(text, /`git checkout -b task-14 FETCH_HEAD`/, "task-14 starts at staging's tip, not at what the fork checked out");
    assert.match(text, /--head near-builder:task-14 --base staging/);
    assert.equal(text.includes("gh repo sync"), false, "no sync can create staging on a fork that lacks it");
  });

  test("branch mode: staging cloned by name, the branch from it, staging as the base", () => {
    const text = ship("branch", near, 14, "near-builder", false).join("\n");
    assert.match(text, /`git clone --branch staging https:\/\/github\.com\/MultiAgency\/near-agencies\.git \.`/);
    assert.match(text, /`git checkout -b task-14`/);
    assert.match(text, /--head task-14 --base staging/);
  });

  test("a revision checks out the task branch and opens no second pull request, in either mode", () => {
    for (const [repo, access] of shipping) {
      const text = ship(access, repo, 14, "near-builder", true).join("\n");
      assert.match(text, /`git checkout task-14`/);
      assert.equal(text.includes("gh pr create"), false);
    }
  });

  test("the instructions name the repository the task's terms name, and run its registry's checks", () => {
    for (const repo of [near, legion]) {
      const text = ship("fork", repo, 14, "near-builder", false).join("\n");
      assert.match(text, new RegExp(`pull request against staging of ${repo.name}`));
      for (const check of repo.checks) {
        assert.equal(text.includes(`\`${check}\``), true, `${repo.name}: ${check}`);
      }
    }
  });

  test("every command the instructions give is one the allowlist allows", () => {
    for (const [repo, access] of shipping) {
      for (const revision of [false, true]) {
        const commands = commanded(ship(access, repo, 14, "near-builder", revision));
        assert.equal(commands.length > 5, true, `${repo.name} ${access}: the instructions do name commands`);
        for (const cmd of commands) {
          assert.equal(allowed(allowedTools(access, repo, 14, "near-builder"), cmd), true, `${repo.name} ${access}: ${cmd}`);
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
    assert.equal(allowedTools(withoutCodeMode ? "branch" : null, near, 14, "near-builder").includes("Bash(npm ci)"), false);
    assert.equal(allowedTools(withCodeMode ? "branch" : null, near, 14, "near-builder").includes("Bash(npm ci)"), true);
  });
});

describe("a seat's ```terms", () => {
  test("parse as JSON, the way the board writes them", () => {
    assert.deepEqual(termsOf({ body: "Part of job #5.\n\n```terms\n{\"engagement\": 5, \"repo\": \"MultiAgency/legion-social\"}\n```" }), {
      engagement: 5, repo: "MultiAgency/legion-social",
    });
  });

  test("absent, malformed or non-JSON terms read as null, and the registry then reads the default", () => {
    assert.equal(termsOf({}), null);
    assert.equal(termsOf({ body: "no block here" }), null);
    assert.equal(termsOf({ body: "```terms\nengagement: job 5\n```" }), null);
  });
});

describe("the repository refusals", () => {
  test("each refusal starts with its own fixed first line — the once-per-round match", () => {
    const repoBody = codeRepoRefusal("octocat/hello-world");
    const imageBody = codeImageRefusal("rust", "node");
    assert.equal(repoBody.startsWith(CODE_REPO_REFUSAL_FIRST_LINE), true);
    assert.equal(imageBody.startsWith(CODE_IMAGE_REFUSAL_FIRST_LINE), true);
    assert.equal(CODE_REPO_REFUSAL_FIRST_LINE === CODE_IMAGE_REFUSAL_FIRST_LINE, false,
      "one refusal must not count for the other");
    assert.match(repoBody, /octocat\/hello-world/);
    assert.match(imageBody, /`rust` toolchain and this image carries `node`/);
  });
});

// One agent's view of the board, shared by the nextTask() describes below:
// the seat issues, their threads, and — should any code ask — collaborator
// roles, counted in `reads.roles`. Nothing may ask: the worker's trust is
// the coordinator's login alone, so the count staying at zero is the rule
// ("a 403 can't happen because nothing reads roles"), and a role answer of
// admin for everyone is the strongest adversary a reintroduced lookup would
// meet. Posts are recorded, not sent.
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
const board = (issues, threads = {}, events = {}) => {
  const reads = { roles: 0 };
  const github = async path => {
    if (path === "/issues?state=open&per_page=100") return issues;
    const permission = path.match(/^\/collaborators\/([^/]+)\/permission$/);
    if (permission) {
      reads.roles++;
      return { role_name: "admin" };
    }
    const on = path.match(/^\/issues\/(\d+)\/(comments|events)/);
    if (!on) throw new Error(`unexpected GET ${path}`);
    return (on[2] === "comments" ? threads : events)[on[1]] ?? [];
  };
  github.reads = reads;
  return github;
};
const harness = (issues, threads = {}, events = {}, extra = {}) => {
  const posted = [];
  const github = board(issues, threads, events);
  return {
    posted,
    threads,
    reads: github.reads,
    task: () => nextTask({
      github,
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

  test("an owner's hand-written ```changes asks nothing anew: only the coordinator's opens a round", async () => {
    const { task, posted } = harness(
      [seatIssue(14, ["skill:code"], [login])],
      { 14: [c(login, CODE_REFUSAL), c("jlwaugh", "Once more:\n```changes\naddress the review\n```")] },
    );
    assert.deepEqual(await task(), null);
    assert.deepEqual(posted, [], "the owner's block is not a round: the coordinator posts every block a round is owed to, and this one is not its own");
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

// A code seat whose terms name a repository (#82): the worker image a run
// carries decides whether it can ship the seat at all.
const repoSeat = (number, labels, repo, assignees = []) => ({
  number,
  created_at: "2026-10-01T00:00:00Z",
  body: [
    "Part of job #5.",
    "",
    "```terms",
    JSON.stringify(repo ? { engagement: 5, repo } : { engagement: 5 }),
    "```",
  ].join("\n"),
  assignees: assignees.map(l => ({ login: l })),
  labels: labels.map(name => ({ name })),
});
describe("a code seat's repository decides whether this run takes it", () => {
  const codeSkills = { skills: ["code"], codeMode: "fork" };

  test("a node worker leaves a rust repository's ready seat unclaimed, for a worker that has it", async () => {
    const { task, posted } = harness(
      [repoSeat(20, ["ready", "agent-eligible", "skill:code"], "MultiAgency/legion-social")],
      { 20: [] },
      {},
      codeSkills,
    );
    assert.deepEqual(await task(), null);
    assert.deepEqual(posted, [], "a claimable seat the image cannot build is skipped, not refused");
  });

  test("a rust worker claims it", async () => {
    const { task, posted } = harness(
      [repoSeat(20, ["ready", "agent-eligible", "skill:code"], "MultiAgency/legion-social")],
      { 20: [] },
      {},
      { ...codeSkills, toolchain: "rust" },
    );
    const picked = await task();
    assert.deepEqual(posted, []);
    assert.equal(picked.action, "claim");
    assert.equal(picked.seat.number, 20);
  });

  test("a rust worker takes a near-agencies seat: its image carries node too", async () => {
    // The rust image is built FROM node:22-slim (Dockerfile), so near-agencies'
    // npm checks run on it: the seat is neither skipped nor refused with a
    // false "needs node".
    const { task, posted } = harness(
      [repoSeat(24, ["skill:code"], undefined, [login])],
      { 24: [] },
      {},
      { ...codeSkills, toolchain: "rust" },
    );
    const picked = await task();
    assert.deepEqual(posted, []);
    assert.equal(picked.action, "deliver");
    assert.equal(picked.seat.number, 24);
  });

  test("a rust worker claims a ready near-agencies seat too", async () => {
    const { task, posted } = harness(
      [repoSeat(25, ["ready", "agent-eligible", "skill:code"], undefined)],
      { 25: [] },
      {},
      { ...codeSkills, toolchain: "rust" },
    );
    const picked = await task();
    assert.deepEqual(posted, []);
    assert.equal(picked.action, "claim");
    assert.equal(picked.seat.number, 25);
  });

  test("an assigned rust seat is refused once on a node worker, and the run moves on", async () => {
    const { task, posted, threads } = harness(
      [repoSeat(20, ["skill:code"], "MultiAgency/legion-social", [login]), repoSeat(21, ["skill:writing"], undefined, [login])],
      { 20: [], 21: [] },
      {},
      codeSkills,
    );
    const picked = await task();
    assert.equal(picked.seat.number, 21, "the rust seat did not stop the writing seat");
    assert.equal(posted.length, 1);
    assert.equal(posted[0].number, 20);
    assert.equal(posted[0].body.startsWith(CODE_IMAGE_REFUSAL_FIRST_LINE), true);
    threads[20].push(c(login, posted[0].body));   // the comment the run left
    const again = await task();
    assert.equal(again.seat.number, 21, "the second run still delivers the seat it can");
    assert.equal(posted.length, 1, "not refused a second time");
  });

  test("an assigned seat naming a repository outside the registry is refused, not attempted", async () => {
    const { task, posted } = harness(
      [repoSeat(22, ["skill:code"], "octocat/hello-world", [login])],
      { 22: [] },
      {},
      codeSkills,
    );
    assert.deepEqual(await task(), null);
    assert.deepEqual(posted.map(p => p.body.startsWith(CODE_REPO_REFUSAL_FIRST_LINE)), [true]);
  });

  test("near-agencies seats deliver on a node worker as they always did", async () => {
    const { task, posted } = harness(
      [repoSeat(23, ["skill:code"], undefined, [login])],
      { 23: [] },
      {},
      { ...codeSkills, codeMode: "branch" },
    );
    const picked = await task();
    assert.deepEqual(posted, []);
    assert.equal(picked.seat.number, 23);
  });

  test("a dry run names no seat it cannot ship", async () => {
    const { task, posted } = harness(
      [repoSeat(20, ["ready", "agent-eligible", "skill:code"], "MultiAgency/legion-social")],
      { 20: [] },
      {},
      { ...codeSkills, dryRun: true },
    );
    assert.deepEqual(await task(), null);
    assert.deepEqual(posted, []);
  });
});

// The ```changes boundary both nextTask() places read — the revision round a
// handoff must be newer than, and the round a refusal is counted within —
// counts only the coordinator's own block: it writes every block a round is
// owed to, posting one itself when it routes a reviewer's request
// (lib/coordinator.mjs). Anything else — a stranger's, an owner's own
// hand-written — opens no round, so it can neither reopen a handed-off task
// (a second deliverable, a second paid run) nor un-count a refusal.
describe("the ```changes boundary counts only the coordinator's own block", () => {
  const changes = user => c(user, "Once more:\n```changes\naddress the review\n```");
  const handoff = c(login, "Done.\n\n```handoff\nlinks: x\n```");

  test("a stranger's ```changes after a handoff leaves the task handed off", async () => {
    const { task } = harness(
      [seatIssue(15, ["skill:writing"], [login])],
      { 15: [handoff, changes("stranger")] },
    );
    assert.deepEqual(await task(), null, "the stranger's round is not one: no second delivery");
  });

  test("the coordinator's ```changes after a handoff still starts a new round", async () => {
    const { task } = harness(
      [seatIssue(15, ["skill:writing"], [login])],
      { 15: [handoff, changes(bot)] },
    );
    const picked = await task();
    assert.equal(picked.action, "deliver");
    assert.equal(picked.revision, true);
  });

  test("an owner's hand-written ```changes opens none: the seat stays handed off", async () => {
    const { task } = harness(
      [seatIssue(15, ["skill:writing"], [login])],
      { 15: [handoff, changes("jlwaugh")] },
    );
    assert.deepEqual(await task(), null, "an owner's block is not a round; the coordinator posts the round itself when it routes the request");
  });

  test("a stranger's ```changes leaves an earlier refusal counted", async () => {
    const { task, posted } = harness(
      [seatIssue(14, ["skill:code"], [login])],
      { 14: [changes(bot), c(login, CODE_REFUSAL), changes("stranger")] },
    );
    assert.deepEqual(await task(), null);
    assert.deepEqual(posted, [], "the refusal from the bot's round still stands");
  });

  test("the credited round comes back with the task, not a stranger's later block", async () => {
    const credited = { ...changes(bot), html_url: "https://github.com/x/y/issues/15#issuecomment-1" };
    const stranger = { ...changes("stranger"), html_url: "https://github.com/x/y/issues/15#issuecomment-2" };
    const { task } = harness(
      [seatIssue(15, ["skill:writing"], [login])],
      { 15: [handoff, credited, stranger] },
    );
    const picked = await task();
    assert.equal(picked.revision, true);
    assert.deepEqual(picked.round, credited, "the delivery prompt must name the credited round, not the stranger's block after it");
  });

  test("no role lookup takes part, so no token's 403 can fail the check open", async () => {
    const { task, reads } = harness(
      [seatIssue(15, ["skill:writing"], [login])],
      { 15: [handoff, changes(bot), changes("stranger"), changes("jlwaugh")] },
    );
    await task();
    assert.equal(reads.roles, 0, "trust is the coordinator's login alone: no GitHub read decides it, on any token");
  });

  test("the coordinator's ```changes after the refusal asks anew", async () => {
    const { task, posted } = harness(
      [seatIssue(14, ["skill:code"], [login])],
      { 14: [c(login, CODE_REFUSAL), changes(bot)] },
    );
    assert.deepEqual(await task(), null);
    assert.deepEqual(posted, [{ number: 14, body: CODE_REFUSAL }]);
  });
});

describe("the trust check", () => {
  test("the coordinator's login is the only trusted one — an owner's is not", () => {
    const trusted = trustCheck({ bot });
    assert.equal(trusted("multi-agency"), true);
    assert.equal(trusted("Multi-Agency"), true, "logins are not case-sensitive");
    assert.equal(trusted("stranger"), false);
    assert.equal(trusted("jlwaugh"), false, "an owner's hand-written block is not a round: the coordinator writes the blocks rounds are owed to, and this is not one of its own");
  });

  test("a missing bot login is refused up front, naming the setting", () => {
    assert.throws(() => trustCheck({}), /\(BOARD_BOT\) is required/);
  });
});
