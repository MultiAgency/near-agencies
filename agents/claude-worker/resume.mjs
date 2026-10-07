// Resume: what a run of the Claude worker saves when it stops unfinished,
// what the next run continues from, and the numbers that bound the attempts
// (#169). A run that ends without a delivery — out of turns, out of budget,
// or thrown out by the SDK — used to leave nothing behind: its clone was
// deleted and the next run started over. Now the worker's own code commits
// whatever the run left as a work-in-progress commit on `wip/task-<n>` and
// pushes it to the remote the delivery would use, and the next run starts
// its clone there instead of at the base branch. The branch is never a pull
// request head, so no review round, gate decision or auto-merge reads it;
// it is the ledger of the attempts: one save commit per unfinished run,
// each recording the run and the checks that failed, which is also how two
// runs with no new work and five unfinished runs on one round are counted
// before the task is handed back.
//
// Like preflight.mjs, this module runs only node builtins beside the
// worker's own dependency-free modules, and every git call arrives injected
// (`run`), so the repository's tests can hold each command it runs.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/** The branch a task's unfinished runs save to. It shares the `task-<n>`
 * name's number but never carries a delivery: nothing opens, reviews or
 * merges from it. */
export const wipBranchOf = n => `wip/task-${n}`;

/** The remote a task's saves and its delivery both use: near-agencies itself
 * in branch mode, the agent's fork in fork mode (accessFor, code-mode.mjs,
 * has already decided which of the two this run ships with). */
export const deliveryRemote = (access, repo, login) =>
  access === "fork"
    ? `https://github.com/${login}/${repo.name.split("/")[1]}.git`
    : `https://github.com/${repo.name}.git`;
// A git call that hangs must not hang the run past its own cron slot: the
// clone, the pushes and the reads all answer well inside this on a healthy
// connection, and a kill reads as the failed save it is.
const GIT_TIMEOUT_MS = 120_000;

// One registry check gets this long before the save gives up on it and
// records it as failing: the checks run at save time, off the model's
// budget, and a hung `npm test` must not hold the clone open forever.
const CHECK_TIMEOUT_MS = 300_000;

// The attempts a task gets before its run hands it back instead of letting
// the next cron run retry: five unfinished runs on one round, or two runs
// in a row that saved the same tree — whatever a run wrote, the next one
// wrote again, so the work is not moving (#169's 10-and-0 loop).
export const MAX_UNFINISHED_PER_ROUND = 5;

// The line a save commit carries its machine-readable record on. The commit
// body records the run for people too; this one line is what the next run
// parses, so its shape is a contract with the parser below.
export const RUN_RECORD_PREFIX = "multiagency-run: ";

/** The message of a save commit: the run it records on the title line, the
 * failing checks in the body, and the record itself as one JSON line. */
export function saveMessage({ n, run, round, subtype, isError, turns, cost, checks, ran, checksTotal }) {
  const ended = subtype === "thrown" || turns === undefined
    ? "the model run ended without a result"
    : `${isError ? `failed (${subtype})` : subtype} after ${turns} turns at $${Number(cost ?? 0).toFixed(2)}`;
  // `round` is the id of the ```changes comment that opened the round, not
  // a number to count by: the prose names it as what it is, and the record
  // line carries it for the parser.
  const roundNote = round ? `the revision round opened by comment ${round}` : "the first round";
  const failed = checks ?? [];
  const untried = checksTotal - (ran ?? checksTotal);
  const checksNote = failed.length
    ? `Checks: ${failed.join(", ")} failed${untried > 0 ? `; ${untried} ${untried === 1 ? "check was" : "checks were"} not run` : ""}.`
    : `Checks: all ${ran ?? checksTotal} passed.`;
  const record = { task: n, run, round, subtype, ...(isError ? { isError: true } : {}), ...(turns === undefined ? {} : { turns, cost }), checks: failed };
  return [
    `wip: task #${n} run ${run} saved unfinished (${roundNote}): ${ended}`,
    "",
    `Run ${run} on task #${n} ended with the delivery unfinished — ${ended} — on ${roundNote}.`,
    checksNote,
    "The next run starts from this branch and reads this note; the branch is deleted once a run delivers.",
    "",
    `${RUN_RECORD_PREFIX}${JSON.stringify(record)}`,
  ].join("\n");
}

/** The record a save commit carries, read back out of a commit message:
 * null for anything that is not one of this worker's saves. */
export function savedRun(message) {
  const line = String(message ?? "").split("\n").find(l => l.startsWith(RUN_RECORD_PREFIX));
  if (!line) return null;
  try {
    const record = JSON.parse(line.slice(RUN_RECORD_PREFIX.length));
    if (typeof record.task !== "number" || typeof record.run !== "number" || typeof record.round !== "number") return null;
    return record;
  } catch {
    return null;
  }
}

/** The save commits on the branch HEAD sits on, newest first, as
 * `{ sha, tree, record }`: the ledger the next run reads its attempt
 * numbers and saved trees from. Commits without a record — the model's own
 * checkpoints — are not saves. `round` keeps a foreign save out. */
export async function savedChain({ cwd, round, run = promisify(execFile), from = "HEAD" }) {
  const { stdout } = await run("git", ["log", "--format=%H%x1f%T%x1f%B%x1e", from], { cwd, timeout: GIT_TIMEOUT_MS });
  const saves = [];
  for (const entry of stdout.split("\x1e")) {
    const [sha, tree, message] = entry.trimStart().split("\x1f");
    if (!sha) continue;
    const record = savedRun(message);
    if (record && record.round === round) saves.push({ sha, tree, record });
  }
  return saves;
}

/** Why the run hands the task back instead of leaving it to the next cron
 * run, or null while the attempts are not spent: `saves` unfinished runs on
 * one round, or two in a row whose saved trees are the same. The numbers
 * come from the ledger the saves themselves keep. */
export function handBackReason({ saves, sameTree }) {
  if (saves >= MAX_UNFINISHED_PER_ROUND) return `my last ${saves} runs on it each ended unfinished`;
  if (sameTree) return "the last two runs saved no new work: whatever one wrote, the other wrote again";
  return null;
}

/** Which of the repository's registry checks fail, run in order with a
 * timeout each and stopping at the first failure — the one check standing
 * between the work and a delivery. `failed` lists the failing checks (empty
 * when they all passed) and `ran` how many ran, so the note can say what a
 * stop left untried. */
export async function failingChecks({ repo, cwd, run = promisify(execFile) }) {
  const failed = [];
  let ran = 0;
  for (const check of repo.checks) {
    ran++;
    try {
      await run("bash", ["-c", check], { cwd, timeout: CHECK_TIMEOUT_MS });
    } catch {
      failed.push(check);
      break;
    }
  }
  return { failed, ran };
}

/** Whether an unfinished run of task `n` on revision round `round` has saved
 * work to resume, without cloning: the branch's existence on the delivery
 * remote, then — only when it exists — its tip commit's record, read from a
 * one-commit fetch into a scratch repository. Saves from an earlier round
 * (or another task's, or a hand-written one) read as none. */
export async function resumableWork({ remote, n, round, run = promisify(execFile) }) {
  const branch = wipBranchOf(n);
  let tip = null;
  try {
    const { stdout } = await run("git", ["ls-remote", remote, `refs/heads/${branch}`], { timeout: GIT_TIMEOUT_MS });
    tip = stdout.trim().split("\t")[0] || null;
  } catch {
    return null;
  }
  if (!tip) return null;
  const scratch = await mkdtemp(join(tmpdir(), "wip-probe-"));
  try {
    await run("git", ["init", "--quiet"], { cwd: scratch, timeout: GIT_TIMEOUT_MS });
    await run("git", ["fetch", "--depth=1", remote, branch], { cwd: scratch, timeout: GIT_TIMEOUT_MS });
    const { stdout } = await run("git", ["show", "-s", "--format=%B", "FETCH_HEAD"], { cwd: scratch, timeout: GIT_TIMEOUT_MS });
    const record = savedRun(stdout);
    return record && record.task === n && record.round === round ? { tip, record } : null;
  } catch {
    return null;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Prepare the clone a resumed run works in: the same clone and fork setup
 * the delivery instructions give, started at the saved branch instead of the
 * base, with the work checked out as the local branch `task-<n>` the
 * delivery pushes. `resume` is resumableWork's answer for this run; the
 * caller has already decided to resume. `forkFetch` is the upstream fetch
 * fork mode's setup makes — the pair of URL and base branch — and null in
 * branch mode, whose clone already carries the base. Returns what the prompt
 * tells the model: where the previous run stopped — its commits after the
 * round's base, and its last note. The model runs no git here: reading the
 * log is the worker's own code, and nothing joins the allowlist for it. */
export async function setupResume({ remote, forkFetch = null, baseBranch, n, resume, cwd, run = promisify(execFile) }) {
  await run("git", forkFetch ? ["clone", remote, "."] : ["clone", "--branch", baseBranch, remote, "."], { cwd, timeout: GIT_TIMEOUT_MS });
  if (forkFetch) {
    await run("git", ["fetch", forkFetch[0], forkFetch[1]], { cwd, timeout: GIT_TIMEOUT_MS });
  }
  await run("git", ["checkout", "-b", `task-${n}`, `refs/remotes/origin/${wipBranchOf(n)}`], { cwd, timeout: GIT_TIMEOUT_MS });
  // Where the round started: the pull request's branch on a revision round
  // (its head is what the saved work builds on), the base branch otherwise —
  // upstream's, fetched above, in fork mode.
  const base = resume.record.round
    ? `refs/remotes/origin/task-${n}`
    : forkFetch ? "FETCH_HEAD" : baseBranch;
  const read = async args => {
    try {
      return (await run("git", args, { cwd, timeout: GIT_TIMEOUT_MS })).stdout;
    } catch {
      return "";
    }
  };
  return {
    base,
    log: await read(["log", "--oneline", `${base}..HEAD`]),
    note: await read(["show", "-s", "--format=%B", "HEAD"]),
  };
}

/** Save an unfinished run: commit whatever the clone holds — the model's
 * checkpoints beneath, any uncommitted change on top — as one save commit
 * recording the run, and push the branch to `wip/task-<n>` on the delivery
 * remote. `round` is the revision round the run worked on (0 for the first),
 * `resumed` whether this run started from the saved branch. A run that did
 * not (a new round's first save, or a first save at all) forces the push, so
 * a round's ledger replaces the old one's instead of mixing with it — but
 * only once the remote reads as holding no save of this round: a run whose
 * own lookup found the branch and then could not set up from it (worker.mjs
 * fell back to the base branch) finds it again here, saves nothing, and
 * returns `skipped` instead — overwriting the branch would wipe the round's
 * ledger, its saved work and its run numbers, which the next run is to
 * resume. Returns
 * what bounding the attempts reads: this run's number among the round's
 * unfinished runs, its saved tree, and the tree the previous save holds.
 * Nothing here touches a pull request branch: the only ref written is
 * `wip/task-<n>`. */
export async function saveUnfinished({ remote, n, round, resumed, resumedFrom, cwd, repo, run = promisify(execFile), subtype, isError, turns, cost }) {
  // A run that did not start from the round's saved branch must not overwrite
  // it: the branch is the ledger the next run resumes and counts from. This
  // run's own lookup found it and then lost it — its setup failed and
  // worker.mjs fell back to the base branch — so the remote is read fresh
  // here rather than trusted from before the run: still there, nothing is
  // committed or pushed, and the caller says why. Gone (or an older round's,
  // whose ledger a new round replaces): the push below may force.
  if (!resumed) {
    const kept = await resumableWork({ remote, n, round, run });
    if (kept) return { skipped: true, tip: kept.tip, record: kept.record };
  }
  // The ledger is read from the save this run resumed, not from HEAD: a run
  // that rewrote its history (a rebase, a reset) may have dropped the earlier
  // save commits, and counting from its own chain would start the attempts
  // over and the bound would never trip. Each save records its run number,
  // so the newest one carries the count forward.
  const before = await savedChain({ cwd, round, run, from: resumedFrom ?? "HEAD" });
  const runNumber = (before[0]?.record.run ?? before.length) + 1;
  const { failed, ran } = await failingChecks({ repo, cwd, run });
  const message = saveMessage({
    n, run: runNumber, round, subtype, isError, turns, cost,
    checks: failed, ran, checksTotal: repo.checks.length,
  });
  // The comment and pull-request-body drafts go to `.board/` in the clone —
  // the instructions say so — and the save never stages them, whatever the
  // name a stray draft at the root answers to: a save is a checkpoint of the
  // work, and a resumed delivery would push the drafts (and any check
  // leftovers git does not already ignore) into the pull request. The
  // excluded names are the ones the drafts answered to before the
  // `.board/` instruction existed.
  const drafts = [".board", "deliverable.md", "handoff.md", "pr-body.md"];
  await run("git", ["add", "-A", "--", ".", ...drafts.map(d => `:!${d}`)], { cwd, timeout: GIT_TIMEOUT_MS });
  await run("git", ["commit", "--allow-empty", "--message", message], { cwd, timeout: GIT_TIMEOUT_MS });
  // A run that started from the saved branch may have left it: rewritten its
  // history, or checked out another commit altogether. Its save must still
  // land, and must never drop the saves it resumed, so when HEAD no longer
  // descends from the resumed tip, the save becomes a merge of both: the tree
  // is this run's, the first parent its own history, the second the resumed
  // save. The push stays a fast-forward, no save is ever overwritten, and a
  // push the remote refuses (someone else saved meanwhile) still hands back.
  if (resumedFrom && !await isAncestor({ cwd, run, ancestor: resumedFrom })) {
    const { stdout: merged } = await run("git", ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-p", resumedFrom, "-m", message], { cwd, timeout: GIT_TIMEOUT_MS });
    await run("git", ["reset", "--soft", merged.trim()], { cwd, timeout: GIT_TIMEOUT_MS });
  }
  const { stdout } = await run("git", ["rev-parse", "HEAD^{tree}"], { cwd, timeout: GIT_TIMEOUT_MS });
  const tree = stdout.trim();
  const args = ["push", ...(resumed ? [] : ["--force"]), "origin", `HEAD:refs/heads/${wipBranchOf(n)}`];
  await run("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
  return { run: runNumber, tree, previousTree: before[0]?.tree ?? null, message };
}

/** Whether `ancestor` is HEAD or one of its ancestors in the clone. */
async function isAncestor({ cwd, run, ancestor }) {
  try {
    await run("git", ["merge-base", "--is-ancestor", ancestor, "HEAD"], { cwd, timeout: GIT_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** The tip of `task-<n>` on the delivery remote: its commit id, `null` when
 * the branch does not exist, `undefined` when the remote cannot be read. */
export async function taskTip({ remote, n, run = promisify(execFile) }) {
  try {
    const { stdout } = await run("git", ["ls-remote", remote, `refs/heads/task-${n}`], { timeout: GIT_TIMEOUT_MS });
    return stdout.trim().split("\t")[0] || null;
  } catch {
    return undefined;
  }
}

/** Whether this run delivered: it moved `task-<n>` on the delivery remote
 * (`before` is the tip read before the model run) to the clone's HEAD. A
 * result of `success` alone says only that the model stopped without an
 * error — it may have stopped short of pushing, after saying it cannot do the
 * work — and in a revision round the clone starts at the pull request's head,
 * so a HEAD equal to `task-<n>` proves nothing unless this run moved it. A
 * read that fails, before or after, counts as not delivered: the work is then
 * saved rather than lost. */
export async function deliveredHead({ remote, n, cwd, before, run = promisify(execFile) }) {
  if (before === undefined) return false;
  try {
    const [after, { stdout: head }] = await Promise.all([
      taskTip({ remote, n, run }),
      run("git", ["rev-parse", "HEAD"], { cwd, timeout: GIT_TIMEOUT_MS }),
    ]);
    return Boolean(after) && after !== before && after === head.trim();
  } catch {
    return false;
  }
}

/** Delete the saved branch after a delivery: nothing is waiting to resume,
 * and the next task on this number starts clean. A delivery that never
 * saved — most of them — finds no branch on the remote and pushes nothing:
 * the delete is for the run that took saved work up and finished it. A
 * remote that cannot be read at all still throws: the branch, if any, is
 * left for the next delivery to find. */
export async function deleteSaved({ remote, n, cwd, run = promisify(execFile) }) {
  const { stdout } = await run("git", ["ls-remote", remote, `refs/heads/${wipBranchOf(n)}`], { cwd, timeout: GIT_TIMEOUT_MS });
  if (!stdout.trim()) return;
  await run("git", ["push", "origin", "--delete", wipBranchOf(n)], { cwd, timeout: GIT_TIMEOUT_MS });
}
