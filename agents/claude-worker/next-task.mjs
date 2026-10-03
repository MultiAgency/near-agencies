// Which task this worker's run takes from the board: the first seat assigned
// to the agent with no handoff since the last change request (deliver it), or
// otherwise the first ready seat it may claim (/claim it). It imports nothing
// but code-mode.mjs, and its GitHub access arrives injected, so the
// repository's tests can run whole cron runs from the root, where this
// folder's dependencies (the Claude SDK) are not installed.
import { CODE_REFUSAL, isCodeSeat, mayClaim, refusalPosted } from "./code-mode.mjs";

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const isSeat = issue => !issue.pull_request && /```terms\n/.test(issue.body ?? "");

// When a task last became claimable: its latest `ready` label, or its creation.
async function readySince(github, issue) {
  const events = await github(`/issues/${issue.number}/events?per_page=100`);
  const ready = events.filter(e => e.event === "labeled" && e.label?.name === "ready").at(-1);
  return Date.parse(ready?.created_at ?? issue.created_at);
}

/** The one task for this run, or null. `github` reads the board the way
 * worker.mjs's github() does; `comment` posts a comment on a seat. With
 * dryRun nothing is posted: --dry-run only names the task. */
export async function nextTask({ github, comment, login, skills, codeMode, claimAfterMs = 0, dryRun = false }) {
  const seats = (await github("/issues?state=open&per_page=100")).filter(isSeat);
  for (const seat of seats.filter(s => s.assignees.some(a => same(a.login, login)))) {
    const thread = await github(`/issues/${seat.number}/comments?per_page=100`);
    const since = thread.findLastIndex(c => c.body.includes("```changes\n"));
    const handedOff = thread.slice(since + 1).some(c => same(c.user.login, login) && c.body.includes("```handoff\n"));
    if (handedOff) continue;
    // Native GitHub assignment counts as a claim without a skill check, so a
    // run without code mode can find a skill:code seat assigned to it: the
    // shipping steps would name commands it is not allowed to run. Say so on
    // the seat — once per revision round, matched on the refusal's fixed
    // first line — instead of refusing it again on every cron run, and move
    // on to the seats this run can deliver.
    if (isCodeSeat(seat) && !codeMode) {
      if (!dryRun && !refusalPosted(thread, login)) await comment(seat.number, CODE_REFUSAL);
      continue;
    }
    return { action: "deliver", seat, revision: since !== -1 };
  }
  for (const seat of seats.filter(s => mayClaim(s, skills))) {
    const wait = claimAfterMs - (Date.now() - await readySince(github, seat));
    if (wait > 0) {
      console.log(`worker: leaving #${seat.number} to others for ${Math.ceil(wait / 60_000)} more min`);
      continue;
    }
    const thread = await github(`/issues/${seat.number}/comments?per_page=100`);
    if (!thread.some(c => same(c.user.login, login) && c.body.trim().startsWith("/claim"))) return { action: "claim", seat };
  }
  return null;
}
