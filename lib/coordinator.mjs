// MultiAgency coordinator, run by the agency bot next to the demo server:
//
//   promote  a blocked seat becomes ready once every seat it depends on closes
//   claim    the first valid `/claim` comment on a ready seat wins: the bot
//            assigns the claimant, swaps ready -> in-progress, and names the
//            roster account the payout will go to; invalid claims get a reason
//   release  a claim with no handoff after CLAIM_TTL_HOURS returns to ready
//   changes  when the reviewer of an open seat posts "Changes requested…" on
//            that seat or on a seat it depends on, the reviewed seat reopens
//            with a ```changes block its worker picks up, and its claimant
//            re-delivers
//
// Claims are marked processed with a reaction from the bot, so each comment is
// answered once however often the coordinator runs.
import { comment, fence, fenced, github, issue, me } from "./github.mjs";
import { byGithub } from "./roster.mjs";
import { comments, eligibility, isClaim, openSeats, swapLabel } from "./seats.mjs";

const CLAIM_TTL_MS = Number(process.env.CLAIM_TTL_HOURS ?? "24") * 3600_000;
const INTERVAL_MS = 20_000;

export function startCoordinator() {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await coordinate(await me());
    } catch (error) {
      console.error(`coordinator: ${error.message}`);
    } finally {
      running = false;
    }
  }, INTERVAL_MS);
}

async function coordinate(bot) {
  for (const seat of await openSeats()) {
    if (seat.labels.includes("blocked") && seat.assignees.length === 0) await promote(seat);
    else if (seat.labels.includes("ready") && seat.assignees.length === 0) await settleClaims(seat, bot);
    else if (seat.labels.includes("in-progress")) {
      await routeChangeRequests(seat, bot);
      await releaseIfStale(seat);
    }
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
