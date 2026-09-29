// MultiAgency coordinator, run by the agency bot next to the demo server:
//
//   promote  a blocked seat becomes ready once every seat it depends on closes
//   claim    the first valid `/claim` comment on a ready seat wins: the bot
//            assigns the claimant, swaps ready -> in-progress, and names the
//            roster account the payout will go to; invalid claims get a reason
//            a native GitHub assignment on a ready seat is a claim too: same
//            eligibility checks, the first eligible assignee wins, and every
//            other assignee is unassigned with a refused-claim reason
//   release  a claim with no handoff after CLAIM_TTL_HOURS returns to ready
//   close    a seat closes once its claimant's handoff (the latest since any
//            change request) passes the checks payouts make; a failing one is
//            answered with the reason. Contributors need no write access
//   tidy     a closed seat loses `in-progress`: seat labels describe open work
//   join     a join request posted on the board (lib/onboarding.mjs) is
//            verified against its author and the chain and labelled
//            roster-verified or refused; once an owner's roster change is
//            deployed, the request is answered and closed
//   settle   a closed engagement epic — completed, or cancelled without
//            completion — drops its `blocked` label, and its `## Team`
//            checklist ticks each seat that closed with a handoff
//   changes  when the reviewer of an open seat posts "Changes requested…" on
//            that seat or on a seat it depends on, the reviewed seat reopens
//            with a ```changes block its worker picks up, and its claimant
//            re-delivers
//
// Claims are marked processed with a reaction from the bot, so each comment is
// answered once however often the coordinator runs.
import { comment, fence, fenced, github, issue, me } from "./github.mjs";
import { settleEpic } from "./engagement-state.mjs";
import { joinRequest, verifyJoinRequest } from "./onboarding.mjs";
import { byGithub } from "./roster.mjs";
import { comments, eligibility, handoffProblem, isClaim, openSeats, swapLabel } from "./seats.mjs";

const CLAIM_TTL_MS = Number(process.env.CLAIM_TTL_HOURS ?? "24") * 3600_000;
const INTERVAL_MS = 20_000;
const STALE_CYCLES = 6;
const STUCK_MS = 10 * 60_000;

export function startCoordinator() {
  health.started_at = new Date().toISOString();
  setInterval(() => cycle(), INTERVAL_MS);
  // Self-healing: a cycle stuck past STUCK_MS exits the process, and the host's
  // restart-on-failure policy (Railway: ON_FAILURE) brings it back. Cycles that
  // fail quickly (GitHub down, a bad token) do not: a restart cannot fix those,
  // and restarting in a loop would take the site down. /api/health reports them.
  setInterval(() => {
    if (!coordinatorStuck()) return;
    console.error(`coordinator: a cycle has been running since ${health.cycle_started_at}; exiting so the host restarts it`);
    process.exit(1);
  }, INTERVAL_MS);
}

// One cycle at a time: a second would repeat the first one's comments. Every
// request a cycle makes is time-bounded, so a cycle always ends.
const health = { started_at: null, cycles: 0, cycle_started_at: null, last_completed_at: null, last_error: null };
let running = false;
export const coordinatorHealth = () => ({ ...health, running, interval_ms: INTERVAL_MS });

/** A cycle that has not finished after STUCK_MS is stuck; every request in it is time-bounded. */
export const coordinatorStuck = (now = Date.now()) => running && now - Date.parse(health.cycle_started_at) > STUCK_MS;

/** Stale after six cycles without success, counted from start until the first one completes. */
export const coordinatorStale = (now = Date.now()) =>
  now - Date.parse(health.last_completed_at ?? health.started_at ?? new Date(now).toISOString()) > STALE_CYCLES * INTERVAL_MS;

export async function cycle(run = async () => coordinate(await me())) {
  if (running) return false;
  running = true;
  health.cycle_started_at = new Date().toISOString();
  try {
    await run();
    health.cycles += 1;
    health.last_completed_at = new Date().toISOString();
  } catch (error) {
    health.last_error = { at: new Date().toISOString(), message: error.message };
    console.error(`coordinator: ${error.message}`);
  } finally {
    running = false;
  }
  return true;
}

async function coordinate(bot) {
  for (const seat of await openSeats()) {
    if (seat.labels.includes("blocked") && seat.assignees.length === 0) await promote(seat);
    else if (seat.labels.includes("ready")) {
      if (seat.assignees.length === 0) await settleClaims(seat, bot);
      else await settleAssignments(seat);
    }
    else if (seat.labels.includes("in-progress")) {
      await routeChangeRequests(seat, bot);
      if (await closeIfHandedOff(seat, bot)) continue;
      await releaseIfStale(seat);
    }
  }
  await clearClosedSeats();
  await settleJoinRequests();
  await settleClosedEpics();
}

// `blocked` on an epic means waiting on seats, so it cannot outlive the epic
// itself. The sweep settles any closed epic that still wears the label —
// cancelled by hand, or closed before settling existed, included.
async function settleClosedEpics() {
  const closed = await github("GET", "/issues?labels=engagement,blocked&state=closed&per_page=100");
  for (const epic of closed.filter(i => !i.pull_request)) {
    const patch = await settleEpic(epic.number);
    if (patch) console.log(`coordinator: #${epic.number} settled (${Object.keys(patch).join(", ")})`);
  }
}

async function closeIfHandedOff(seat, bot) {
  const thread = await comments(seat.number);
  const since = thread.findLastIndex(c => fenced(c.body, "changes"));
  const handoff = thread.slice(since + 1).findLast(c => seat.assignees.includes(c.user.login) && fenced(c.body, "handoff"));
  if (!handoff || await answered(handoff, bot)) return false;
  const problem = await handoffProblem(fenced(handoff.body, "handoff"), byGithub(handoff.user.login));
  if (problem) {
    await react(handoff, "confused");
    await comment(seat.number, `@${handoff.user.login}, this handoff can't close the seat: ${problem}. Post a corrected handoff.`);
    return false;
  }
  await react(handoff, "+1");
  await github("PATCH", `/issues/${seat.number}`, { state: "closed", state_reason: "completed" });
  console.log(`coordinator: #${seat.number} closed on @${handoff.user.login}'s handoff`);
  return true;
}

async function clearClosedSeats() {
  const closed = await github("GET", "/issues?state=closed&labels=in-progress&per_page=100");
  for (const seat of closed.filter(i => !i.pull_request && fenced(i.body, "terms"))) {
    await github("DELETE", `/issues/${seat.number}/labels/in-progress`);
    console.log(`coordinator: #${seat.number} closed, in-progress cleared`);
  }
}

async function settleJoinRequests() {
  const open = await github("GET", "/issues?state=open&per_page=100");
  for (const request of open.filter(i => !i.pull_request && joinRequest(i.body))) {
    const author = request.user.login;
    const labels = request.labels.map(label => label.name);
    if (labels.includes("roster-verified")) {
      // Live means the deployed roster holds this request, not just the login:
      // a re-registration already has an entry before the owner's change lands.
      const listed = byGithub(author);
      if (listed?.proof !== request.html_url) continue;
      await comment(request.number, `@${author} is on the MultiAgency roster, paid to \`${listed.nearAccount}\`. Ready seats you are eligible for are open to you.`);
      await github("PATCH", `/issues/${request.number}`, { state: "closed", state_reason: "completed" });
      console.log(`coordinator: join #${request.number} completed for ${author}`);
      continue;
    }
    // Age is judged at posting time, so the verdict does not depend on when it runs.
    const { refusal } = await verifyJoinRequest(joinRequest(request.body), { author, now: new Date(request.created_at), issue: request.number });
    if (refusal) {
      await comment(request.number, `This join request can't be accepted: ${refusal}. Sign a new one at the demo's Join page or with \`node roster.mjs join\`, and open a new issue.`);
      await github("PATCH", `/issues/${request.number}`, { state: "closed", state_reason: "not_planned" });
      console.log(`coordinator: join #${request.number} refused: ${refusal}`);
      continue;
    }
    await github("POST", `/issues/${request.number}/labels`, { labels: ["roster-verified"] });
    await comment(request.number, `Verified: the signature is from a full-access key of the NEAR account, and @${author} posted it. A MultiAgency owner adds it with \`node roster.mjs add ${request.number}\`; this issue closes once the roster change is live.`);
    console.log(`coordinator: join #${request.number} verified for ${author}`);
  }
}

export const isChangeRequest = c => /^\**changes requested/i.test(c.body.trim()) && !fenced(c.body, "changes");

async function routeChangeRequests(reviewSeat, bot) {
  if (reviewSeat.dependsOn.length === 0 || reviewSeat.assignees.length === 0) return;
  const reviewers = new Set(reviewSeat.assignees.filter(login => login !== bot));
  const onReview = (await comments(reviewSeat.number)).filter(c => reviewers.has(c.user.login) && isChangeRequest(c));
  for (const n of reviewSeat.dependsOn) {
    const onSeat = (await comments(n)).filter(c => reviewers.has(c.user.login) && isChangeRequest(c));
    for (const request of [...onReview, ...onSeat]) {
      if (await answered(request, bot)) continue;
      const reviewed = await issue(n);
      if (reviewed.state === "closed") {
        await github("PATCH", `/issues/${n}`, { state: "open" });
        await swapLabel(n, "ready", "in-progress");
      }
      await comment(n, [
        `**Changes requested** by @${request.user.login}, reviewing in #${reviewSeat.number}. This seat is reopened for a revision by ${reviewed.assignees.map(a => `@${a.login}`).join(", ")}.`,
        "",
        request.body.trim().split("\n").map(line => `> ${line}`).join("\n"),
        "",
        fence("changes", { review: reviewSeat.number, requested_by: request.user.login, request: request.html_url }),
      ].join("\n"));
      await react(request, "eyes");
      console.log(`coordinator: routed changes from #${reviewSeat.number} to #${n}`);
    }
  }
}

async function promote(seat) {
  if (seat.dependsOn.length === 0) return;
  const parents = await Promise.all(seat.dependsOn.map(n => issue(n)));
  if (parents.some(p => p.state !== "closed")) return;
  await swapLabel(seat.number, "blocked", "ready");
  await comment(seat.number, `Dependencies ${seat.dependsOn.map(n => `#${n}`).join(", ")} are done. This seat is open: comment \`/claim\` to take it.`);
  console.log(`coordinator: #${seat.number} ready`);
}

async function settleClaims(seat, bot) {
  for (const claim of (await comments(seat.number)).filter(isClaim)) {
    if (await answered(claim, bot)) continue;
    const builder = byGithub(claim.user.login);
    const refusal = eligibility(seat, builder);
    if (refusal) {
      await react(claim, "-1");
      await comment(seat.number, `@${claim.user.login} can't claim this seat: ${refusal}.`);
      continue;
    }
    await github("POST", `/issues/${seat.number}/assignees`, { assignees: [claim.user.login] });
    await swapLabel(seat.number, "ready", "in-progress");
    await react(claim, "+1");
    await comment(seat.number, `Claimed by @${claim.user.login}. On acceptance, ${Number(seat.terms.amount) / 1e6} USDC is paid to \`${builder.nearAccount}\`.`);
    console.log(`coordinator: #${seat.number} claimed by ${claim.user.login}`);
    return;
  }
}

// A native GitHub assignment (the assign button) on a `ready` seat counts as a
// claim by that assignee, checked against the roster exactly like a /claim.
// Only the first eligible assignee stays on the seat: an ineligible one, or an
// eligible one beaten to it, is refused and removed, since payouts name the
// account of whichever assignee is left. The coordinator itself assigns no one
// else: settling a /claim swaps the label to in-progress in the same pass, so
// a `ready` seat that still has assignees was assigned on GitHub.
export function assignmentClaims(seat) {
  const decided = seat.assignees.map(login => {
    const builder = byGithub(login);
    return { login, builder, refusal: eligibility(seat, builder) };
  });
  const accepted = decided.find(claim => !claim.refusal) ?? null;
  const refused = decided.flatMap(claim => {
    if (claim.refusal) return [claim];
    if (claim === accepted) return [];
    return [{ ...claim, refusal: `@${accepted.login} claimed it first` }];
  });
  return { accepted, refused };
}

async function settleAssignments(seat) {
  const { accepted, refused } = assignmentClaims(seat);
  for (const claim of refused) {
    await github("DELETE", `/issues/${seat.number}/assignees`, { assignees: [claim.login] });
    await comment(seat.number, `@${claim.login} can't claim this seat: ${claim.refusal}.`);
    console.log(`coordinator: #${seat.number} refused ${claim.login}: ${claim.refusal}`);
  }
  if (!accepted) return;
  await swapLabel(seat.number, "ready", "in-progress");
  await comment(seat.number, `Claimed by @${accepted.login}. On acceptance, ${Number(seat.terms.amount) / 1e6} USDC is paid to \`${accepted.builder.nearAccount}\`.`);
  console.log(`coordinator: #${seat.number} claimed by ${accepted.login} (GitHub assignment)`);
}

async function releaseIfStale(seat) {
  if (Date.now() - Date.parse(seat.updatedAt) < CLAIM_TTL_MS) return;
  const thread = await comments(seat.number);
  if (thread.some(c => fenced(c.body, "handoff"))) return;
  for (const login of seat.assignees) {
    await github("DELETE", `/issues/${seat.number}/assignees`, { assignees: [login] });
  }
  await swapLabel(seat.number, "in-progress", "ready");
  await comment(seat.number, `No handoff after ${CLAIM_TTL_MS / 3600_000} hours, so this seat is open again. Comment \`/claim\` to take it.`);
  console.log(`coordinator: #${seat.number} released`);
}

const reactionsOf = claim => github("GET", `/issues/comments/${claim.id}/reactions?per_page=100`);
const answered = async (claim, bot) => (await reactionsOf(claim)).some(r => r.user.login === bot);
const react = (claim, content) => github("POST", `/issues/comments/${claim.id}/reactions`, { content });
