// MultiAgency coordinator, run by the agency bot next to the demo server:
//
//   promote  a blocked seat becomes ready once every seat it depends on closes
//   claim    the first valid `/claim` comment on a ready seat wins: the bot
//            assigns the claimant, swaps ready -> in-progress, and names the
//            roster account the payout will go to; invalid claims get a reason,
//            and so do claims beaten to the win or made while it is in progress
//            a native GitHub assignment on a ready seat is a claim too: same
//            eligibility checks, the first eligible assignee wins, and every
//            other assignee is unassigned with a refused-claim reason
//   release  a claim with no handoff after CLAIM_TTL_HOURS returns to ready
//   close    a seat closes once its claimant's handoff (the latest since any
//            change request) passes the checks payouts make; a failing or
//            unreadable one is answered once with the reason, and editing it
//            asks again. Contributors need no write access. A revision's close
//            is announced to its reviewer on the review seat
//   tidy     a closed seat loses `ready`, `blocked` and `in-progress`: seat labels describe open work
//   join     a join request posted on the board (lib/onboarding.mjs) is
//            verified against its author and the chain and labelled
//            roster-verified or refused. An owner's `/admit` on a verified
//            request checks it again, pays the account's USDC registration if
//            it has none (REGISTRAR_ACCOUNT), and adds the member at once
//            (lib/roster.mjs); the request is then answered and closed. A
//            member's request that keeps their account, kind and operator
//            only updates what they declare (name, skills) and applies at once
//   settle   a closed engagement epic — completed, or cancelled without
//            completion — drops its `blocked` label, and its `## Team`
//            checklist ticks each seat that closed with a handoff
//   approve  an owner's `/approve` on a job without a team takes the latest
//            ```team-draft posted before it, checks it (lib/team.mjs) and
//            creates the tasks; anyone else's, or a draft that fails the
//            checks, is answered with the reason. Owners have admin or
//            maintain permission on the board
//   pay      once every task of a job has closed with a handoff that passes
//            the payout checks, file one DAO Transfer proposal per task as
//            PROPOSER_ACCOUNT (a key that can only add proposals), reusing any
//            already on chain; record each payment an approver votes through,
//            and close the job when all are paid. A job that fails the checks
//            is answered once with the reason. Every PAYOUT_SWEEP_MS
//   changes  when the reviewer of an open seat posts "Changes requested…" on
//            that seat or on a seat it depends on, the reviewed seat reopens
//            with a ```changes block its worker picks up, and its claimant
//            re-delivers. With TYPESAFE_API_KEY set, each reviewer comment is
//            also judged by Jev in shadow (lib/judge.mjs), for comparison only
//
// Claims are marked processed with a reaction from the bot, so each comment is
// answered once however often the coordinator runs.
import { comment, fence, fenced, github, isOwner, isTrusted, issue, me } from "./github.mjs";
import { loadEngagement, settleEpic } from "./engagement-state.mjs";
import { judgeHealth, shadowJudge } from "./judge.mjs";
import { closeIfPaid, payoutProblem, proposePayouts, recordApprovals } from "./payouts.mjs";
import { ensureUsdcRegistration, joinRequest, verifyJoinRequest } from "./onboarding.mjs";
import { admit, byGithub, isProfileUpdate } from "./roster.mjs";
import { comments, eligibility, handoffProblem, isClaim, openSeats, swapLabel, unreadableHandoff } from "./seats.mjs";
import { assembleTeam, teamProblem } from "./team.mjs";

const SITE_URL = process.env.SITE_URL ?? "https://demo.multiagency.ai";
const CLAIM_TTL_MS = Number(process.env.CLAIM_TTL_HOURS ?? "24") * 3600_000;
const INTERVAL_MS = 20_000;
const STALE_CYCLES = 6;
const STUCK_MS = 10 * 60_000;
// Paying reads every task of a job and the chain, so it runs less often than a
// cycle; the gap also lets a proposal whose reply was lost land before the
// next sweep looks for it on chain.
const PAYOUT_SWEEP_MS = 2 * 60_000;

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
export const coordinatorHealth = () => ({ ...health, running, interval_ms: INTERVAL_MS, judge: judgeHealth() });

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
      await settleClaims(seat, bot);
      await routeChangeRequests(seat, bot);
      if (await closeIfHandedOff(seat, bot)) continue;
      await releaseIfStale(seat);
    }
  }
  await approveTeams(bot);
  await settlePayouts(bot);
  await clearClosedSeats();
  await settleJoinRequests(bot);
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

// The change requests the coordinator routed onto a seat. Anyone can comment,
// so a ```changes block from anyone else is ignored.
export async function routedRequests(thread) {
  const routed = [];
  for (const c of thread) if (fenced(c.body, "changes") && await isTrusted(c.user.login)) routed.push(c);
  return routed;
}

/**
 * The claimant's latest handoff since the last round, readable or not, unless
 * the coordinator has answered it as it stands: its reply links the handoff,
 * and editing the handoff after the reply asks again.
 */
export function pendingHandoff(thread, claimants, since, bot) {
  const latest = thread.slice(since + 1).findLast(c =>
    claimants.includes(c.user.login) && (fenced(c.body, "handoff") || unreadableHandoff(c.body)));
  if (!latest) return null;
  const answered = thread.some(c => c.user.login === bot && c.body.includes(latest.html_url) && c.created_at >= latest.updated_at);
  return answered ? null : latest;
}

async function closeIfHandedOff(seat, bot) {
  const thread = await comments(seat.number);
  const requests = await routedRequests(thread);
  const since = requests.length ? thread.indexOf(requests.at(-1)) : -1;
  const handoff = pendingHandoff(thread, seat.assignees, since, bot);
  if (!handoff) return false;
  const block = fenced(handoff.body, "handoff");
  const problem = block ? await handoffProblem(block, byGithub(handoff.user.login)) : unreadableHandoff(handoff.body);
  if (problem) {
    const login = handoff.user.login;
    await comment(seat.number, `@${login}, [this handoff](${handoff.html_url}) can't close the task: ${problem}. Edit it, or post a corrected one; ${SITE_URL}/#/status/${login} prepares one that passes.`);
    return false;
  }
  await react(handoff, "+1");
  await github("PATCH", `/issues/${seat.number}`, { state: "closed", state_reason: "completed" });
  console.log(`coordinator: #${seat.number} closed on @${handoff.user.login}'s handoff`);
  if (requests.length) await announceRevision(seat, requests, handoff);
  return true;
}

// A revision closes a reopened seat; the reviewer who asked for it hears so on
// the review seat, whatever tooling the contributor uses.
async function announceRevision(seat, requests, handoff) {
  const { review, body } = revisionNotice(seat.number, requests, handoff);
  await comment(review, body);
}

/** The review seat to tell, and what to tell it, when revision N of a seat closes. */
export function revisionNotice(number, thread, handoff) {
  const requests = thread.filter(c => fenced(c.body, "changes"));
  const { review, requested_by } = fenced(requests.at(-1).body, "changes");
  const work = fenced(handoff.body, "handoff").deliverable?.url ?? handoff.html_url;
  return { review, body: `@${requested_by}, round ${requests.length + 1} of #${number} is in: ${work}. It passed the handoff checks: sign it off here, or ask for another round.` };
}

async function clearClosedSeats() {
  for (const label of ["in-progress", "ready", "blocked"]) {
    const closed = await github("GET", `/issues?state=closed&labels=${label}&per_page=100`);
    for (const seat of closed.filter(i => !i.pull_request && fenced(i.body, "terms"))) {
      await github("DELETE", `/issues/${seat.number}/labels/${label}`);
      console.log(`coordinator: #${seat.number} closed, ${label} cleared`);
    }
  }
}

async function settleJoinRequests(bot) {
  const open = await github("GET", "/issues?state=open&per_page=100");
  for (const request of open.filter(i => !i.pull_request && joinRequest(i.body))) {
    const author = request.user.login;
    const labels = request.labels.map(label => label.name);
    if (labels.includes("roster-verified")) {
      await admitOnRequest(request, bot);
      // Live means the deployed roster holds this request, not just the login:
      // a re-registration already has an entry before the owner's change lands.
      const listed = byGithub(author);
      if (listed?.proof !== request.html_url) continue;
      await comment(request.number, `@${author} is on the MultiAgency roster, paid to \`${listed.nearAccount}\`. The tasks you can claim now, and what to do next: ${SITE_URL}/#/status/${author}`);
      await github("PATCH", `/issues/${request.number}`, { state: "closed", state_reason: "completed" });
      console.log(`coordinator: join #${request.number} completed for ${author}`);
      continue;
    }
    // Age is judged at posting time, so the verdict does not depend on when it runs.
    const { builder, refusal } = await verifyJoinRequest(joinRequest(request.body), { author, now: new Date(request.created_at), issue: request.number });
    if (refusal) {
      await comment(request.number, `This join request can't be accepted: ${refusal}. Sign a new one at the demo's Join page or with \`node roster.mjs join\`, and open a new issue.`);
      await github("PATCH", `/issues/${request.number}`, { state: "closed", state_reason: "not_planned" });
      console.log(`coordinator: join #${request.number} refused: ${refusal}`);
      continue;
    }
    await github("POST", `/issues/${request.number}/labels`, { labels: ["roster-verified"] });
    if (isProfileUpdate(byGithub(author), builder)) {
      admit({ ...builder, proof: request.html_url });
      await comment(request.number, `@${author}'s roster entry is updated: ${builder.name}, ${builder.skills.join(", ")}. Same account and kind, so no owner approval is needed. What's next: ${SITE_URL}/#/status/${author}`);
      await github("PATCH", `/issues/${request.number}`, { state: "closed", state_reason: "completed" });
      console.log(`coordinator: join #${request.number} updated ${author}'s entry`);
      continue;
    }
    await comment(request.number, `Verified: the signature is from a key that controls the NEAR account, and @${author} posted it. A MultiAgency owner admits it by commenting \`/admit\` here; this issue then closes.`);
    console.log(`coordinator: join #${request.number} verified for ${author}`);
  }
}

export const isAdmission = comment => /^\/admit\b/i.test(comment.body.trim());

async function admitOnRequest(request, bot) {
  for (const command of (await comments(request.number)).filter(isAdmission)) {
    if (await answered(command, bot)) continue;
    const owner = command.user.login;
    const { builder, refusal } = !(await isOwner(owner)) ? { refusal: "only a MultiAgency owner can admit a member" }
      // Judged at posting time, as when it was verified.
      : await verifyJoinRequest(joinRequest(request.body), { author: request.user.login, now: new Date(request.created_at), issue: request.number });
    if (refusal) {
      await react(command, "-1");
      await comment(request.number, `@${owner}, not admitted: ${refusal}.`);
      continue;
    }
    // Registration first: if it fails, the command stays unanswered and the next cycle retries it.
    const usdc = await ensureUsdcRegistration(builder.nearAccount);
    admit({ ...builder, proof: request.html_url });
    await react(command, "+1");
    const note = usdc.registered ? ` MultiAgency registered \`${builder.nearAccount}\` for testnet USDC, so payouts can reach it.` : usdc.problem ? ` Before a payout: ${usdc.problem}.` : "";
    await comment(request.number, `**Admitted** by @${owner}.${note}`);
    console.log(`coordinator: join #${request.number} admitted by ${owner}${usdc.registered ? " (USDC registered)" : ""}`);
    return;
  }
}

export const isChangeRequest = c => /^\**changes requested/i.test(c.body.trim()) && !fenced(c.body, "changes");

async function routeChangeRequests(reviewSeat, bot) {
  if (reviewSeat.dependsOn.length === 0 || reviewSeat.assignees.length === 0) return;
  const reviewers = new Set(reviewSeat.assignees.filter(login => login !== bot));
  // Every reviewer comment is also judged in shadow (lib/judge.mjs); only the regex routes.
  const requestsOn = async n => {
    const said = (await comments(n)).filter(c => reviewers.has(c.user.login));
    for (const c of said) await shadowJudge(c, isChangeRequest(c));
    return said.filter(isChangeRequest);
  };
  const onReview = await requestsOn(reviewSeat.number);
  for (const n of reviewSeat.dependsOn) {
    const onSeat = await requestsOn(n);
    for (const request of [...onReview, ...onSeat]) {
      if (await answered(request, bot)) continue;
      const reviewed = await issue(n);
      if (reviewed.state === "closed") {
        await github("PATCH", `/issues/${n}`, { state: "open" });
        await swapLabel(n, "ready", "in-progress");
      }
      await comment(n, [
        `**Changes requested** by @${request.user.login}, reviewing in #${reviewSeat.number}. This task is reopened for another round by ${reviewed.assignees.map(a => `@${a.login}`).join(", ")}.`,
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
  // The open list was read at the top of the cycle, and an owner closing the
  // seat since — a replacement, a withdrawal — wins the race only against the
  // label write. Re-read the seat before its first visible effect, so a closed
  // seat is not labelled ready with a claim invitation nobody can answer.
  const live = await issue(seat.number);
  if (live.state !== "open") return;
  await swapLabel(seat.number, "blocked", "ready");
  await comment(seat.number, `Dependencies ${seat.dependsOn.map(n => `#${n}`).join(", ")} are done. This task is open: comment \`/claim\` to take it.`);
  console.log(`coordinator: #${seat.number} ready`);
}

async function settleClaims(seat, bot) {
  let accepted = null;
  for (const claim of (await comments(seat.number)).filter(isClaim)) {
    if (await answered(claim, bot)) continue;
    // The assignee re-claiming, or their win interrupted mid-sequence, needs
    // no answer: the assignee list already says them.
    if (seat.assignees.includes(claim.user.login)) continue;
    const builder = byGithub(claim.user.login);
    const refusal = eligibility(seat, builder)
      ?? (accepted ? `@${accepted} claimed it first` : null)
      ?? (seat.assignees.length ? `this task is already claimed by @${seat.assignees[0]}` : null);
    if (refusal) {
      await react(claim, "-1");
      await comment(seat.number, `@${claim.user.login} can't claim this task: ${refusal}.`);
      continue;
    }
    accepted = claim.user.login;
    await github("POST", `/issues/${seat.number}/assignees`, { assignees: [claim.user.login] });
    await swapLabel(seat.number, "ready", "in-progress");
    await react(claim, "+1");
    await comment(seat.number, claimed(claim.user.login, seat, builder));
    console.log(`coordinator: #${seat.number} claimed by ${claim.user.login}`);
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
    await comment(seat.number, `@${claim.login} can't claim this task: ${claim.refusal}.`);
    console.log(`coordinator: #${seat.number} refused ${claim.login}: ${claim.refusal}`);
  }
  if (!accepted) return;
  await swapLabel(seat.number, "ready", "in-progress");
  await comment(seat.number, claimed(accepted.login, seat, accepted.builder));
  console.log(`coordinator: #${seat.number} claimed by ${accepted.login} (GitHub assignment)`);
}

const claimed = (login, seat, builder) =>
  `Claimed by @${login}. Once the work is signed off, ${Number(seat.terms.amount) / 1e6} USDC is paid to \`${builder.nearAccount}\`. ` +
  `When it is delivered, ${SITE_URL}/#/status/${login} prepares your handoff.`;

async function releaseIfStale(seat) {
  if (Date.now() - Date.parse(seat.updatedAt) < CLAIM_TTL_MS) return;
  const thread = await comments(seat.number);
  if (thread.some(c => seat.assignees.includes(c.user.login) && fenced(c.body, "handoff"))) return;
  for (const login of seat.assignees) {
    await github("DELETE", `/issues/${seat.number}/assignees`, { assignees: [login] });
  }
  await swapLabel(seat.number, "in-progress", "ready");
  await comment(seat.number, `No handoff after ${CLAIM_TTL_MS / 3600_000} hours, so this task is open again. Comment \`/claim\` to take it.`);
  console.log(`coordinator: #${seat.number} released`);
}

export const isApproval = comment => /^\/approve\b/i.test(comment.body.trim());

/** The latest team draft posted before this command: a later one was not what the owner saw. */
export function draftFor(thread, command) {
  const draft = thread.slice(0, thread.indexOf(command)).filter(c => c.body.includes("```team-draft\n")).at(-1);
  return draft && { comment: draft, issues: fenced(draft.body, "team-draft")?.issues ?? null };
}

async function approveTeams(bot) {
  const jobs = await github("GET", "/issues?labels=engagement&state=open&per_page=100");
  for (const job of jobs.filter(j => !j.pull_request && !fenced(j.body, "team"))) {
    const thread = await comments(job.number);
    for (const command of thread.filter(isApproval)) {
      if (await answered(command, bot)) continue;
      const owner = command.user.login;
      const draft = draftFor(thread, command);
      const refusal = !(await isOwner(owner)) ? "only a MultiAgency owner can approve a team"
        : !draft ? "there is no team draft above the command"
        : !draft.issues ? `the [team draft](${draft.comment.html_url}) is not valid JSON`
        : teamProblem(job, draft.issues);
      if (refusal) {
        await react(command, "-1");
        await comment(job.number, `@${owner}, the team was not approved: ${refusal}.`);
        continue;
      }
      const { team, committed } = await assembleTeam(job, draft.issues);
      await react(command, "+1");
      await comment(job.number, [
        `**Team approved** by @${owner}, from [the team draft](${draft.comment.html_url}): ${team.map(t => `#${t.issue} ${t.title} (${Number(t.amount) / 1e6} USDC)`).join("; ")}.`,
        `${Number(committed) / 1e6} of ${Number(fenced(job.body, "engagement").deposit.amount) / 1e6} USDC committed. Tasks without dependencies are open to claim now.`,
      ].join(" "));
      console.log(`coordinator: #${job.number} team approved by ${owner}: ${team.map(t => `#${t.issue}`).join(", ")}`);
      break;
    }
  }
}

let payoutSweepAt = 0;
async function settlePayouts(bot) {
  if (Date.now() - payoutSweepAt < PAYOUT_SWEEP_MS) return;
  payoutSweepAt = Date.now();
  const proposer = process.env.PROPOSER_ACCOUNT;
  const jobs = await github("GET", "/issues?labels=engagement&state=open&per_page=100");
  for (const listed of jobs.filter(j => !j.pull_request && fenced(j.body, "team"))) {
    // Cheap first: a job with an open task is not ready, whatever else holds.
    const tasks = await Promise.all(fenced(listed.body, "team").members.map(m => issue(m.issue)));
    if (tasks.some(t => t.state !== "closed")) continue;
    const job = await loadEngagement(listed.number);
    const log = line => console.log(`coordinator: ${line}`);
    if (job.members.some(m => !m.payout) && proposer) {
      const problem = await payoutProblem(job);
      if (problem) {
        await holdOnce(job.number, problem, bot);
        continue;
      }
      await proposePayouts(job, proposer, log);
    }
    await recordApprovals(await loadEngagement(job.number), log);
    await closeIfPaid(job.number, log);
  }
}

// Says why a job's payouts are held, once per reason, on the job itself.
async function holdOnce(number, problem, bot) {
  const body = `**Payouts on hold:** ${problem}. They are proposed once this is fixed.`;
  const said = (await comments(number)).filter(c => c.user.login === bot && c.body.startsWith("**Payouts on hold:**")).at(-1);
  if (said?.body !== body) await comment(number, body);
}

const reactionsOf = claim => github("GET", `/issues/comments/${claim.id}/reactions?per_page=100`);
const answered = async (claim, bot) => (await reactionsOf(claim)).some(r => r.user.login === bot);
const react = (claim, content) => github("POST", `/issues/comments/${claim.id}/reactions`, { content });
