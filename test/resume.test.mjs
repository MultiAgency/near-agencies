import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, test } from "node:test";

import {
  deleteSaved, deliveryRemote, failingChecks, handBackReason, resumableWork,
  saveMessage, savedChain, savedRun, saveUnfinished, setupResume,
  MAX_UNFINISHED_PER_ROUND, RUN_RECORD_PREFIX, wipBranchOf,
} from "../agents/claude-worker/resume.mjs";
import { codeRepo } from "../agents/claude-worker/repos.mjs";

const execFile = promisify(execFileCb);
const recordPrefix = new RegExp(RUN_RECORD_PREFIX.replace(/[$()*+.?[\\\]{}|]/g, "\\$&"));

// The registry entry the mechanics run against — but the checks are not the
// real ones here: every git call below runs for real, and the check runner
// answers from `checksFail` instead of shelling out, so the tests stay off
// the network and off a five-minute npm ci.
const repo = { ...codeRepo({}), checks: ["npm ci", "npm test"] };

// Real git, local only: every call is recorded and executed, except the
// check runner (bash), which fails exactly the checks `checksFail` names.
// The identity and the clean config are what gitEnv gives the delivery, set
// here so the commits the saves make are authored at all.
const identity = {
  GIT_AUTHOR_NAME: "near-builder",
  GIT_AUTHOR_EMAIL: "near-builder@users.noreply.github.com",
  GIT_COMMITTER_NAME: "near-builder",
  GIT_COMMITTER_EMAIL: "near-builder@users.noreply.github.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const gitWith = checksFail => {
  const calls = [];
  const run = async (file, args, opts = {}) => {
    calls.push({ file, args, opts });
    if (file === "bash") {
      if (checksFail?.includes(args[1])) throw new Error(`check failed: ${args[1]}`);
      return { stdout: "", stderr: "" };
    }
    return execFile(file, args, { ...opts, env: { ...identity, ...opts.env } });
  };
  run.calls = calls;
  return run;
};
const git = () => gitWith(null);

// A bare remote holding one commit on `staging`, a scratch repo for reading
// its refs, and a work clone of it with `task-14` checked out — the state a
// model run leaves behind when it stops without delivering.
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "resume-test-"));
  const remote = join(dir, "remote.git");
  const scratch = join(dir, "scratch");
  await execFile("git", ["init", "--bare", "--initial-branch=staging", remote]);
  await execFile("git", ["clone", remote, scratch], { env: identity });
  await writeFile(join(scratch, "README.md"), "# scratch\n");
  await execFile("git", ["add", "-A"], { cwd: scratch, env: identity });
  await execFile("git", ["commit", "-m", "seed staging"], { cwd: scratch, env: identity });
  await execFile("git", ["push", "origin", "staging"], { cwd: scratch, env: identity });
  const work = join(dir, "work");
  await execFile("git", ["clone", "--branch", "staging", remote, work], { env: identity });
  await execFile("git", ["checkout", "-b", "task-14"], { cwd: work, env: identity });
  return {
    dir, remote, scratch, work,
    cleanup: () => rm(dir, { recursive: true, force: true }),
    edit: (name, body) => writeFile(join(work, name), body),
    refs: async () => (await execFile("git", ["ls-remote", remote])).stdout.trim().split("\n").filter(Boolean),
    branchNames: async () => (await execFile("git", ["ls-remote", remote])).stdout.trim().split("\n").filter(Boolean).map(l => l.split("\t")[1]).filter(n => n.startsWith("refs/")),
    tipMessage: async branch => {
      await execFile("git", ["fetch", "--depth=1", remote, branch], { cwd: scratch, env: identity });
      return (await execFile("git", ["show", "-s", "--format=%B", "FETCH_HEAD"], { cwd: scratch, env: identity })).stdout;
    },
    tipMessageOrNull: async branch => {
      try {
        await execFile("git", ["fetch", "--depth=1", remote, branch], { cwd: scratch, env: identity });
        return (await execFile("git", ["show", "-s", "--format=%B", "FETCH_HEAD"], { cwd: scratch, env: identity })).stdout;
      } catch {
        return null;
      }
    },
  };
}

const save = (w, over = {}) => saveUnfinished({
  remote: w.remote, n: 14, round: 0, resumed: false, cwd: w.work, repo,
  run: git(), subtype: "error_max_turns", turns: 61, cost: 2.41, ...over,
});

describe("the branch and remote names", () => {
  test("the saved branch is never a delivery branch", () => {
    assert.equal(wipBranchOf(14), "wip/task-14");
    assert.notEqual(wipBranchOf(14), "task-14");
  });

  test("the delivery remote: the repository in branch mode, the fork in fork mode", () => {
    assert.equal(deliveryRemote("branch", repo, "near-builder"), "https://github.com/MultiAgency/near-agencies.git");
    assert.equal(deliveryRemote("fork", repo, "near-builder"), "https://github.com/near-builder/near-agencies.git");
  });
});

describe("the save commit's message", () => {
  test("records the run, the round, the cost and the failing checks", () => {
    const message = saveMessage({
      n: 14, run: 2, round: 0, subtype: "error_max_turns", turns: 61, cost: 2.412,
      checks: ["npm test"], ran: 3, checksTotal: 3,
    });
    assert.match(message, /^wip: task #14 run 2 saved unfinished/);
    assert.match(message, /error_max_turns after 61 turns at \$2\.41/);
    assert.match(message, /Checks: npm test failed\./, "the failing check was the last one: nothing was left untried");
    assert.deepEqual(savedRun(message), {
      task: 14, run: 2, round: 0, subtype: "error_max_turns", turns: 61, cost: 2.412, checks: ["npm test"],
    });
    const stopped = saveMessage({
      n: 14, run: 2, round: 0, subtype: "error_max_turns", turns: 61, cost: 2.412,
      checks: ["npm run check"], ran: 2, checksTotal: 3,
    });
    assert.match(stopped, /Checks: npm run check failed; 1 check was not run\./);
  });

  test("a run the SDK threw out records no turns or cost", () => {
    const message = saveMessage({ n: 14, run: 1, round: 0, subtype: "thrown", checks: [], checksTotal: 2 });
    const record = savedRun(message);
    assert.equal(record.subtype, "thrown");
    assert.equal("turns" in record, false);
    assert.match(message, /Checks: all 2 passed\./);
  });

  test("a revision round is named, and its id travels in the record", () => {
    const message = saveMessage({ n: 14, run: 1, round: 777001, subtype: "error_max_budget_usd", turns: 3, cost: 3, checks: ["npm ci"], checksTotal: 2 });
    assert.match(message, /revision round 777001/);
    assert.equal(savedRun(message).round, 777001);
  });

  test("a model call that failed reads as failed in the note, and its record carries isError", () => {
    // The SDK ends such a run with subtype "success" and is_error: true;
    // the note must never read as a delivery.
    const message = saveMessage({
      n: 14, run: 1, round: 0, subtype: "success", isError: true, turns: 4, cost: 0.31,
      checks: [], checksTotal: 3,
    });
    assert.match(message, /^wip: task #14 run 1 saved unfinished/);
    assert.match(message, /failed \(success\) after 4 turns at \$0\.31/);
    const record = savedRun(message);
    assert.equal(record.subtype, "success");
    assert.equal(record.isError, true);
    // A run that ended cleanly records no isError at all.
    const clean = savedRun(saveMessage({
      n: 14, run: 1, round: 0, subtype: "success", turns: 4, cost: 0.31, checks: [], checksTotal: 3,
    }));
    assert.equal("isError" in clean, false);
  });

  test("anything that is not a save reads as none", () => {
    assert.equal(savedRun("a plain commit message"), null);
    assert.equal(savedRun(`${RUN_RECORD_PREFIX}not json`), null);
    assert.equal(savedRun(`${RUN_RECORD_PREFIX}{"task":"14"}`), null);
    assert.equal(savedRun(""), null);
    assert.equal(savedRun(undefined), null);
  });
});

describe("failingChecks", () => {
  test("runs the registry's checks in order and stops at the first failure", async () => {
    const run = gitWith(["npm test"]);
    const { failed, ran } = await failingChecks({ repo, cwd: "/nowhere", run });
    assert.deepEqual(failed, ["npm test"]);
    assert.equal(ran, 2, "npm ci passed, npm test failed and stopped the run");
    const ranChecks = run.calls.filter(c => c.file === "bash").map(c => c.args[1]);
    assert.deepEqual(ranChecks, ["npm ci", "npm test"]);
  });

  test("each check runs under a timeout, so a hung check cannot hang the save", async () => {
    const run = git();
    await failingChecks({ repo, cwd: "/nowhere", run });
    for (const call of run.calls.filter(c => c.file === "bash")) {
      assert.equal(typeof call.opts.timeout, "number");
      assert.ok(call.opts.timeout > 0);
    }
  });

  test("no failure reads as an empty list, with every check run", async () => {
    assert.deepEqual(await failingChecks({ repo, cwd: "/nowhere", run: git() }), { failed: [], ran: 2 });
  });
});

describe("saving an unfinished run", () => {
  test("a fresh run's work lands on wip/task-14 with the run recorded, forced past any older branch", async () => {
    const w = await workspace();
    try {
      await w.edit("lib.js", "// step one\n");
      const run = git();
      const saved = await save(w, { run });
      assert.equal(saved.run, 1, "the first unfinished run of the round");
      assert.equal(saved.previousTree, null, "no earlier save to compare with");
      assert.notEqual(saved.tree, null);
      assert.deepEqual(await w.branchNames(), ["refs/heads/staging", "refs/heads/wip/task-14"],
        "only the wip branch joined staging");
      const message = await w.tipMessage("wip/task-14");
      assert.match(message, /^wip: task #14 run 1 saved unfinished/);
      assert.match(message, /error_max_turns after 61 turns/);
      assert.match(message, new RegExp(recordPrefix.source + "\\{\"task\":14"));
      const push = run.calls.find(c => c.args[0] === "push");
      assert.deepEqual(push.args, ["push", "--force", "origin", "HEAD:refs/heads/wip/task-14"],
        "a first save replaces whatever an older round left on the name");
      assert.equal(await w.tipMessageOrNull("refs/heads/task-14"), null,
        "no delivery branch exists: no pull request head was written");
    } finally {
      await w.cleanup();
    }
  });

  test("the work itself is in the save, committed or not", async () => {
    const w = await workspace();
    try {
      await w.edit("lib.js", "// step one\n");
      await save(w);
      const second = await mkdtemp(join(tmpdir(), "resume-check-"));
      try {
        await execFile("git", ["clone", "--branch", "wip/task-14", w.remote, second], { env: identity });
        assert.equal(await readFile(join(second, "lib.js"), "utf8"), "// step one\n");
      } finally {
        await rm(second, { recursive: true, force: true });
      }
    } finally {
      await w.cleanup();
    }
  });

  test("a resumed run pushes without force and numbers itself after the ledger", async () => {
    const w = await workspace();
    try {
      await w.edit("lib.js", "// step one\n");
      await save(w);
      await w.edit("more.js", "// step two\n");
      const run = git();
      const saved = await save(w, { resumed: true, run, turns: 55, cost: 0.9 });
      assert.equal(saved.run, 2);
      assert.notEqual(saved.tree, saved.previousTree, "the second save holds new work");
      const push = run.calls.find(c => c.args[0] === "push");
      assert.deepEqual(push.args, ["push", "origin", "HEAD:refs/heads/wip/task-14"],
        "the remote tip is this chain's own ancestor: nothing to force");
      const ledger = await savedChain({ cwd: w.work, round: 0, run });
      assert.equal(ledger.length, 2);
      assert.equal(ledger[0].record.run, 2, "newest first");
      assert.equal(ledger[1].record.run, 1);
    } finally {
      await w.cleanup();
    }
  });

  test("a saved branch this run did not start from is left standing: nothing is saved, nothing pushed", async () => {
    const w = await workspace();
    try {
      await w.edit("lib.js", "// step one\n");
      await save(w);
      // A later run whose setup failed: it builds on the base branch instead,
      // so it did not start from the saved work — resumed reads false — and
      // its own work must not land on top of what it never saw.
      const run = git();
      await w.edit("other.js", "// a fallback run's work\n");
      const saved = await save(w, { run });
      assert.equal(saved.skipped, true, "the save refused to overwrite this round's ledger");
      assert.equal(saved.record.run, 1, "and names the save it would have overwritten");
      assert.equal(run.calls.some(c => c.args[0] === "push"), false, "nothing was pushed");
      assert.equal(run.calls.some(c => c.args[0] === "commit"), false, "nothing was committed either");
      const [wipRef] = (await w.refs()).filter(l => l.endsWith("refs/heads/wip/task-14"));
      assert.equal(saved.tip, wipRef.split("\t")[0], "the branch's tip is untouched");
      const tip = await w.tipMessage("wip/task-14");
      assert.match(tip, /^wip: task #14 run 1 saved unfinished/, "the ledger still holds the first run's save alone");
    } finally {
      await w.cleanup();
    }
  });

  test("a changed tree without a commit by the model is progress; an unchanged one is not", async () => {
    const w = await workspace();
    try {
      const run = git();
      // Run 1: the model edits but commits nothing — the save commits for it.
      await w.edit("lib.js", "// edited, uncommitted\n");
      const first = await save(w, { run });
      // Run 2 resumes that tree and writes nothing new.
      await execFile("git", ["fetch", "origin", "wip/task-14"], { cwd: w.work, env: identity });
      await execFile("git", ["reset", "--hard", "origin/wip/task-14"], { cwd: w.work, env: identity });
      const second = await save(w, { resumed: true, run });
      assert.equal(second.run, 2);
      assert.equal(second.tree, first.tree, "an unchanged tree is the whole point of the comparison");
      assert.match(handBackReason({ saves: second.run, sameTree: second.tree === second.previousTree }), /no new work/);
    } finally {
      await w.cleanup();
    }
  });

  test("a run that never cloned cannot save: git answers, the worker catches it", async () => {
    const w = await workspace();
    const empty = await mkdtemp(join(tmpdir(), "resume-empty-"));
    try {
      await assert.rejects(
        () => saveUnfinished({
          remote: w.remote, n: 14, round: 0, resumed: false, cwd: empty, repo,
          run: git(), subtype: "error_max_turns", turns: 1, cost: 0,
        }),
        /not a git repository|fatal/i,
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
      await w.cleanup();
    }
  });
});

describe("the ledger and the hand-back", () => {
  test("only saves count: the model's own checkpoint commits are not runs", async () => {
    const w = await workspace();
    try {
      const run = git();
      await w.edit("a.js", "a\n");
      await save(w, { run });
      // The model's own checkpoint commit sits between the saves.
      await w.edit("b.js", "b\n");
      await execFile("git", ["add", "-A"], { cwd: w.work, env: identity });
      await execFile("git", ["commit", "-m", "step: added b, left the tests unrun"], { cwd: w.work, env: identity });
      await w.edit("c.js", "c\n");
      const second = await save(w, { resumed: true, run });
      assert.equal(second.run, 2, "the model's checkpoint is not a run");
      assert.equal((await savedChain({ cwd: w.work, round: 0, run })).length, 2);
    } finally {
      await w.cleanup();
    }
  });

  test("only the round's own saves are in the ledger", async () => {
    const w = await workspace();
    try {
      await w.edit("lib.js", "// work\n");
      await save(w);
      assert.deepEqual(await savedChain({ cwd: w.work, round: 999, run: git() }), [],
        "a save recorded for another round is not this round's");
    } finally {
      await w.cleanup();
    }
  });

  test(`hand-back: ${MAX_UNFINISHED_PER_ROUND} unfinished runs on one round, or two that saved the same tree`, () => {
    assert.equal(handBackReason({ saves: 1, sameTree: false }), null);
    assert.equal(handBackReason({ saves: 2, sameTree: false }), null);
    assert.equal(handBackReason({ saves: MAX_UNFINISHED_PER_ROUND - 1, sameTree: false }), null);
    assert.match(handBackReason({ saves: MAX_UNFINISHED_PER_ROUND, sameTree: false }), /unfinished/);
    assert.match(handBackReason({ saves: 9, sameTree: false }), /unfinished/);
    assert.match(handBackReason({ saves: 2, sameTree: true }), /no new work/);
  });

  test("the first save of a round never hands back on progress: it has no tree to compare", async () => {
    const w = await workspace();
    try {
      // A run that writes nothing at all still saves — an empty marker with
      // the run record — and its tree equals the base's, not a previous
      // save's (there is none).
      const first = await save(w);
      assert.equal(first.previousTree, null);
      assert.equal(handBackReason({ saves: first.run, sameTree: false }), null);
    } finally {
      await w.cleanup();
    }
  });
});

describe("finding the work to resume", () => {
  test("no branch on the remote reads as none", async () => {
    const w = await workspace();
    try {
      assert.equal(await resumableWork({ remote: w.remote, n: 14, round: 0, run: git() }), null);
    } finally {
      await w.cleanup();
    }
  });

  test("this round's save is found, with its tip and record", async () => {
    const w = await workspace();
    try {
      await w.edit("lib.js", "// work\n");
      await save(w);
      const found = await resumableWork({ remote: w.remote, n: 14, round: 0, run: git() });
      assert.notEqual(found, null);
      assert.match(found.tip, /^[0-9a-f]{40,}$/);
      assert.equal(found.record.task, 14);
      assert.equal(found.record.run, 1);
    } finally {
      await w.cleanup();
    }
  });

  test("an earlier round's save, a plain tip, and a foreign record read as none", async () => {
    const w = await workspace();
    try {
      await w.edit("lib.js", "// work\n");
      await save(w);
      assert.equal(await resumableWork({ remote: w.remote, n: 14, round: 5, run: git() }), null,
        "work from an earlier round is ignored");
      // A wip branch whose tip carries no save record at all.
      await execFile("git", ["push", "origin", "staging:refs/heads/wip/task-15"], { cwd: w.scratch, env: identity });
      assert.equal(await resumableWork({ remote: w.remote, n: 15, round: 0, run: git() }), null);
    } finally {
      await w.cleanup();
    }
  });

  test("an unreachable remote reads as none instead of ending the run", async () => {
    assert.equal(await resumableWork({ remote: "/nonexistent/remote.git", n: 14, round: 0, run: git() }), null);
  });
});

describe("setting a resumed clone up", () => {
  test("branch mode: the clone starts at the saved branch, as the delivery's branch", async () => {
    const w = await workspace();
    try {
      await w.edit("lib.js", "// step one\n");
      await save(w);
      const found = await resumableWork({ remote: w.remote, n: 14, round: 0, run: git() });
      const cwd = await mkdtemp(join(tmpdir(), "resume-clone-"));
      try {
        const setup = await setupResume({ remote: w.remote, forkFetch: null, baseBranch: "staging", n: 14, resume: found, cwd, run: git() });
        assert.equal(setup.base, "staging");
        const branch = (await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, env: identity })).stdout.trim();
        assert.equal(branch, "task-14", "the delivery's own branch name, at the saved tip");
        assert.equal(await readFile(join(cwd, "lib.js"), "utf8"), "// step one\n");
        assert.match(setup.log, /run 1 saved unfinished/, "the log names the save commit");
        assert.match(setup.note, recordPrefix, "the note is the save's record");
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    } finally {
      await w.cleanup();
    }
  });

  test("a revision round's base is the pull request's branch, and fork mode fetches its upstream", async () => {
    const w = await workspace();
    try {
      // A revision round: the pull request's branch exists, and the saved
      // work builds on it. The branch is pushed from the work clone, which
      // has task-14 checked out.
      await execFile("git", ["push", "origin", "task-14:refs/heads/task-14"], { cwd: w.work, env: identity });
      await w.edit("fix.js", "// revision work\n");
      await save(w, { round: 4242 });
      const found = await resumableWork({ remote: w.remote, n: 14, round: 4242, run: git() });
      const cwd = await mkdtemp(join(tmpdir(), "resume-clone-"));
      try {
        const setup = await setupResume({
          remote: w.remote, forkFetch: [w.remote, "staging"], baseBranch: "staging",
          n: 14, resume: found, cwd, run: git(),
        });
        assert.equal(setup.base, "refs/remotes/origin/task-14", "the round's base is the pull request's head");
        assert.match(setup.log, /saved unfinished/);
        assert.match(setup.note, recordPrefix);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    } finally {
      await w.cleanup();
    }
  });
});

describe("deleting the saved branch after a delivery", () => {
  test("the branch goes, and nothing else", async () => {
    const w = await workspace();
    try {
      await w.edit("lib.js", "// work\n");
      await save(w);
      const run = git();
      await deleteSaved({ remote: w.remote, n: 14, cwd: w.work, run });
      assert.deepEqual(await w.branchNames(), ["refs/heads/staging"]);
      const push = run.calls.find(c => c.args[0] === "push");
      assert.deepEqual(push.args, ["push", "origin", "--delete", "wip/task-14"]);
    } finally {
      await w.cleanup();
    }
  });

  test("a delivery that never saved deletes nothing and pushes nothing", async () => {
    const w = await workspace();
    try {
      const run = git();
      await deleteSaved({ remote: w.remote, n: 14, cwd: w.work, run });
      assert.equal(run.calls.some(c => c.args[0] === "push"), false,
        "no branch, no delete: a first delivery is not an error to log");
      assert.deepEqual(await w.branchNames(), ["refs/heads/staging"]);
    } finally {
      await w.cleanup();
    }
  });
});
