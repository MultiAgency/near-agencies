// Which task this worker's run takes from the board: the first seat assigned
// to the agent with no handoff since the last change request (deliver it), or
// otherwise the first ready seat it may claim (/claim it). It imports nothing
// but code-mode.mjs, repos.mjs and trust.mjs, and its GitHub access arrives
// injected, so the repository's tests can run whole cron runs from the root,
// where this folder's dependencies (the Claude SDK) are not installed.
import {
  CODE_ACCESS_REFUSAL_FIRST_LINE, CODE_IMAGE_REFUSAL_FIRST_LINE,
  CODE_REPO_REFUSAL_FIRST_LINE, CODE_REFUSAL, DELIVERY_BLOCKED_FIRST_LINE,
  HAND_BACK_FIRST_LINE,
  accessFor, blockerStands, codeAccessRefusal, codeImageRefusal, codeRepoRefusal,
  canShip, deliveryBlockedPush, deliveryBlockedRead, isCodeSeat,
  mayClaim, refusalPosted, termsOf,
} from "./code-mode.mjs";
import { canBuild, codeRepo } from "./repos.mjs";
import { latestChangesRound, trustCheck } from "./trust.mjs";

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const isSeat = issue => !issue.pull_request && /```terms\n/.test(issue.body ?? "");

// The registry entry for a seat's repository, or null when its terms name one
// outside the registry: codeRepo throws there, and a refusal — not a crash —
// is how an assigned seat meets that.
const seatRepo = seat => {
  try {
    return codeRepo(termsOf(seat));
  } catch {
    return null;
  }
};

// Whether a review task waits on task `n`: an open seat labelled
// skill:review whose "Depends on:" list names it (lib/team.mjs writes
// `- [ ] #n`). Its sign-off can still ask for a revision, which must land in
// an open pull request, so a reviewed delivery never turns on auto-merge.
const reviewedBy = (seats, n) =>
  seats.some(s => s.number !== n &&
    (s.labels ?? []).some(label => (label?.name ?? label) === "skill:review") &&
    [...(s.body ?? "").matchAll(/^- \[[ x]\] #(\d+)/gm)].some(m => Number(m[1]) === n));

// When a task last became claimable: its latest `ready` label, or its creation.
async function readySince(github, issue) {
  const events = await github(`/issues/${issue.number}/events?per_page=100`);
  const ready = events.filter(e => e.event === "labeled" && e.label?.name === "ready").at(-1);
  return Date.parse(ready?.created_at ?? issue.created_at);
}

/** The one task for this run, or null. `github` reads the board the way
 * worker.mjs's github() does; `comment` posts a comment on a seat; `bot` is
 * the coordinator's login, the only ```changes author a round counts from
 * (trust.mjs). A deliver result carries `round`, the credited ```changes
 * comment a revision is to address, so the delivery prompt can name it
 * instead of "the latest", which a stranger's later block would be, and
 * `reviewed`, whether a review task waits on this one. With
 * dryRun nothing is posted: --dry-run only names the task. `toolchain` is
 * what this worker's image carries (WORKER_TOOLCHAIN, the Dockerfile's
 * TOOLCHAIN): a code seat whose repository's checks the image cannot run —
 * canBuild: rust covers node, node covers only node — whose repository the
 * run's CODE_ACCESS cannot ship — canShip: fork mode ships any registry
 * repository, branch mode only near-agencies — or whose terms name a
 * repository outside the registry is never taken. `probe` is the delivery
 * preflight (preflight.mjs), the last gate a code seat meets before the
 * model run: it checks with the run's own credentials that the pull
 * request can land, and a failed check costs the seat one blocker comment
 * — never a model run — and the run moves on; while the agent's own
 * blocker is the seat's latest word (blockerStands), later runs skip it
 * without probing again. */
export async function nextTask({ github, comment, login, skills, codeMode, bot, claimAfterMs = 0, dryRun = false, toolchain = "node", probe = null }) {
  const trusted = trustCheck({ bot });
  const seats = (await github("/issues?state=open&per_page=100")).filter(isSeat);
  for (const seat of seats.filter(s => s.assignees.some(a => same(a.login, login)))) {
    const thread = await github(`/issues/${seat.number}/comments?per_page=100`);
    // A ```changes block opens a revision round only when the coordinator
    // wrote it — it posts every block a round is owed to, when it routes a
    // reviewer's request. Anyone else's, an owner's hand-written one
    // included, counts for nothing: it must not reopen a handed-off task (a
    // second deliverable and a second paid run) or un-count a refusal.
    const since = latestChangesRound(thread, trusted);
    const handedOff = thread.slice(since + 1).some(c => same(c.user.login, login) && c.body.includes("```handoff\n"));
    if (handedOff) continue;
    // A hand-back spends this agent's attempts on the seat for the round
    // (#169): the run that gave it up waits out the coordinator's stale
    // release like anyone else, and no later run of the same round picks the
    // seat up to loop over it again. A new round asks anew.
    if (await refusalPosted(thread, login, trusted, HAND_BACK_FIRST_LINE)) continue;
    // Native GitHub assignment counts as a claim without a skill check, so a
    // run without code mode can find a skill:code seat assigned to it: the
    // shipping steps would name commands it is not allowed to run. Say so on
    // the seat — once per revision round, matched on the refusal's fixed
    // first line — instead of refusing it again on every cron run, and move
    // on to the seats this run can deliver.
    if (isCodeSeat(seat) && !codeMode) {
      if (!dryRun && !(await refusalPosted(thread, login, trusted))) await comment(seat.number, CODE_REFUSAL);
      continue;
    }
    // With code mode, the seat's repository decides whether this run can
    // ship it at all: one outside the registry is refused, not attempted,
    // one whose toolchain this image lacks cannot run its checks (#82) — the
    // rust image carries node too, so only a rust repository is out of a
    // node image's reach (canBuild) — and one the run's CODE_ACCESS cannot
    // reach has no token that could fork or push it (canShip).
    // Either refusal is posted on the seat — once per revision round, on its
    // own fixed first line — and the run moves on to what it can deliver.
    if (isCodeSeat(seat) && codeMode) {
      const repo = seatRepo(seat);
      if (!repo || !canBuild(toolchain, repo) || !canShip(repo, codeMode)) {
        if (!dryRun) {
          const [first, body] = !repo
            ? [CODE_REPO_REFUSAL_FIRST_LINE, codeRepoRefusal(termsOf(seat)?.repo)]
            : !canBuild(toolchain, repo)
              ? [CODE_IMAGE_REFUSAL_FIRST_LINE, codeImageRefusal(repo.image, toolchain)]
              : [CODE_ACCESS_REFUSAL_FIRST_LINE, codeAccessRefusal(repo.name)];
          if (!(await refusalPosted(thread, login, trusted, first))) await comment(seat.number, body);
        }
        continue;
      }
      // The model run is the spend this selection guards (#115): before it,
      // check with this run's own credentials that the delivery can land at
      // all — the probe runs the delivery's own git path against the real
      // repository (#130). A definitive failure costs the seat one blocker
      // comment and this run nothing else; an inconclusive one (a network
      // blip) costs only the skip itself, and the next run probes again.
      // While the agent's own blocker is the seat's latest word, the seat
      // is skipped without probing and without redoing the work — until
      // the round changes or someone else comments (blockerStands).
      if (probe) {
        if (blockerStands(thread, login, trusted)) continue;
        if (!dryRun) {
          const access = accessFor(repo, codeMode);
          const found = await probe({ access, repo, login });
          if (!found.ok) {
            if (found.status && !(await refusalPosted(thread, login, trusted, DELIVERY_BLOCKED_FIRST_LINE))) {
              const subject = found.step === "push" && access === "fork"
                ? `${login}/${repo.name.split("/")[1]}`
                : repo.name;
              const body = found.step === "push"
                ? deliveryBlockedPush(subject, found.detail)
                : deliveryBlockedRead(subject, found.detail);
              await comment(seat.number, body);
            } else if (!found.status) {
              console.log(`worker: leaving #${seat.number} for now: the delivery check is unsure (${found.detail})`);
            }
            continue;
          }
        }
      }
    }
    return { action: "deliver", seat, revision: since !== -1, round: since === -1 ? null : thread[since], reviewed: reviewedBy(seats, seat.number) };
  }
  for (const seat of seats.filter(s => mayClaim(s, skills))) {
    // A repository this run cannot ship is never claimed: outside the
    // registry nothing may be shipped there, a toolchain this image lacks
    // cannot run its checks (#82) — the rust image carries node too, so only
    // a rust repository is out of a node image's reach (canBuild) — and a
    // repository the run's CODE_ACCESS cannot reach has no token that could
    // fork or push it (canShip). All stay open — unclaimed — for a worker
    // that can ship them.
    if (isCodeSeat(seat)) {
      const repo = seatRepo(seat);
      if (!repo || !canBuild(toolchain, repo) || !canShip(repo, codeMode)) {
        const why = !repo
          ? "its terms name a repository outside the registry"
          : !canBuild(toolchain, repo)
            ? `${repo.name} needs the ${repo.image} image`
            : `${repo.name} needs a fork-mode worker`;
        console.log(`worker: leaving #${seat.number} alone: ${why}`);
        continue;
      }
    }
    const wait = claimAfterMs - (Date.now() - await readySince(github, seat));
    if (wait > 0) {
      console.log(`worker: leaving #${seat.number} to others for ${Math.ceil(wait / 60_000)} more min`);
      continue;
    }
    const thread = await github(`/issues/${seat.number}/comments?per_page=100`);
    if (thread.some(c => same(c.user.login, login) && c.body.trim().startsWith("/claim"))) continue;
    // Nor does this agent re-claim a seat it handed back unfinished this
    // round (#169): the stale release may make it claimable again, but the
    // attempts it spent stay spent until the round changes.
    if (await refusalPosted(thread, login, trusted, HAND_BACK_FIRST_LINE)) continue;
    // The claim is cheap, but it is the delivery's first step: claiming a
    // seat whose pull request these credentials could never ship takes the
    // coordinator's assignment for a run that could only refuse it (#115).
    // The same read-only probe decides here — silently, for the seat is not
    // this agent's to explain itself on while unclaimed, and the next run
    // probes again, so a token fixed later is claimed then.
    if (probe && !dryRun && isCodeSeat(seat)) {
      const repo = seatRepo(seat);
      const found = await probe({ access: accessFor(repo, codeMode), repo, login });
      if (!found.ok) {
        console.log(`worker: leaving #${seat.number} alone: the delivery check ${found.status ? `answers ${found.status}` : "is unsure"} (${found.detail})`);
        continue;
      }
    }
    return { action: "claim", seat };
  }
  return null;
}
