// Paying a job's team from the DAO treasury: the checks before any proposal,
// one Transfer proposal per task, and recording each payment once an approver
// has voted. Shared by payout.mjs (a person at a terminal) and the coordinator
// (automatically, with a key that can only file proposals). Approving is
// always a person's vote.
import { comment, commentAt, comments, digest, fence, github, pullRepo, pullRequest } from "./github.mjs";
import { codeRepo } from "../agents/claude-worker/repos.mjs";
import { findApproval, txBlockHeight } from "./history.mjs";
import { loadEngagement, recordPaid, settleEpic } from "./engagement-state.mjs";
import { USDC, call, view } from "./near.mjs";
import { byGithub } from "./roster.mjs";
import { pinProblem } from "./seats.mjs";
import { isVolunteer } from "./team.mjs";
import { network, trezuRequestLink } from "./network.mjs";

export const DEAD = ["Rejected", "Failed", "Expired", "Removed"];
const list = members => members.map(m => `#${m.issue}`).join(", ");

/** Why the job's payouts cannot be proposed yet, or null. */
export async function payoutProblem(job) {
  const { members } = job;
  if (members.length === 0) return "the job has no team";
  const unfinished = members.filter(m => m.state !== "closed" || !m.handoff);
  if (unfinished.length) return `${list(unfinished)} ${unfinished.length === 1 ? "has" : "have"} not closed with a handoff`;
  // Volunteer tasks are not paid, so only the paid ones gate on who receives
  // the money; every task still has to close with a handoff, pinned and
  // unedited, whatever its payout.
  const owed = members.filter(m => !isVolunteer(m));
  const unpaid = owed.filter(m => !m.payee);
  if (unpaid.length) return `no roster payout account for the claimant of ${list(unpaid)}`;
  const mismatched = owed.filter(m => m.handoff.payout?.account_id !== m.payee);
  if (mismatched.length) return `the handoff's payout account differs from the payee on ${list(mismatched)}`;
  // A code task delivers a pull request; the payout counts one only once it is
  // merged, from the task's repository, by the assignee the handoff pays.
  // Another task kind may cite pull requests; its links are not the deliverable.
  // A task whose payout was already proposed keeps the payee it was filed
  // with, so the roster is not read for it again: a claimant leaving the
  // roster, or an owner moving their account, must not hold the job's other
  // payouts.
  for (const m of owed.filter(m => !m.payout && m.skills?.includes("skill:code"))) {
    const problem = await pullsProblem(m, true);
    if (problem) return problem;
  }
  return deliverablesProblem(members);
}

/**
 * Why a code task's handoff owes a merged pull request yet, or null. Whatever
 * the payout, one of the claimant's pull requests must be merged from the
 * task's repository; a paid task's must also be by the account the handoff
 * pays, a volunteer's has no payee and counts the claimant alone.
 */
async function pullsProblem(m, pays) {
  const pulls = [...new Set((m.handoff.links ?? [])
    .map(link => /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(link)?.[0])
    .filter(Boolean))];
  if (pulls.length === 0) return `#${m.issue}'s handoff links no pull request`;
  // The repository the task's terms name, from the registry everything reads
  // a task's repository through (agents/claude-worker/repos.mjs); a task
  // naming none is near-agencies'. Terms naming a repository outside the
  // registry hold the payout: nothing may be shipped there.
  let repo;
  try {
    repo = codeRepo(m);
  } catch {
    return `#${m.issue}'s terms name a repository code tasks do not deliver against`;
  }
  const target = repo.name.toLowerCase();
  let problem = null;
  for (const url of pulls) {
    if (pullRepo(url) !== target) {
      problem ??= `#${m.issue}'s pull request ${url} is in another repository; the pull request must be in ${repo.name}.`;
      continue;
    }
    const pr = await pullRequest(url);
    const author = pr.user.login;
    const claimant = (m.claimedBy ?? []).some(login => login.toLowerCase() === author.toLowerCase()) &&
      (!pays || byGithub(author)?.nearAccount === m.payee);
    if (!claimant) {
      problem ??= `#${m.issue}'s pull request ${url} is by @${author}, not the claimant`;
      continue;
    }
    if (!pr.merged) {
      problem ??= `#${m.issue}'s pull request ${url} is not merged yet`;
      continue;
    }
    return null;
  }
  return problem;
}

/**
 * Why the volunteer members that still settle hold the job open, or null: a
 * volunteer is never proposed or paid, so this is the only check its delivery
 * gets, and it is the same one a paid task passes before its proposal —
 * closed with a handoff, deliverable pinned and unedited, and for a code task
 * its merged pull request.
 */
async function volunteerProblem(members) {
  const settling = members.filter(m => !m.paid && isVolunteer(m));
  if (settling.some(m => m.state !== "closed" || !m.handoff)) {
    return `${list(settling)} ${settling.length === 1 ? "has" : "have"} not closed with a handoff`;
  }
  for (const m of settling.filter(m => m.skills?.includes("skill:code"))) {
    const problem = await pullsProblem(m, false);
    if (problem) return problem;
  }
  return deliverablesProblem(settling);
}

// A deliverable is a comment its author can still edit; the handoff pins the
// signed-off text, so an edit after the handoff stops the payout.
export async function deliverablesProblem(members) {
  const unpinned = members.filter(m => pinProblem(m.handoff));
  if (unpinned.length) return `the handoffs of ${list(unpinned)} link a deliverable comment without pinning its sha256`;
  for (const m of members.filter(m => m.handoff.deliverable)) {
    const { url, sha256 } = m.handoff.deliverable;
    if (digest((await commentAt(url)).body) !== sha256) return `#${m.issue}'s deliverable was edited after its handoff`;
  }
  return null;
}

/** Accounts that may approve the treasury's transfer proposals, from its role policy. */
export async function daoApprovers() {
  const { roles } = await view(network.treasury, "get_policy", {});
  const votes = ["transfer:VoteApprove", "transfer:*", "*:VoteApprove", "*:*"];
  return [...new Set(roles.filter(r => r.kind.Group && r.permissions.some(p => votes.includes(p))).flatMap(r => r.kind.Group))];
}

/** A job's proposals waiting for a vote, what an approver's wallet needs to vote, and any reason not to. */
export async function pendingPayouts(job, approvers, proposals = null) {
  const pending = job.members.filter(m => m.payout?.status === "InProgress");
  // The treasury is read only for a job with something to vote on; a job with
  // none (a volunteer's team included) costs no chain read.
  const recent = proposals ?? (pending.length ? await recentProposals() : []);
  const duplicated = pending
    .map(m => ({ m, matches: matchingProposals(recent, m) }))
    .filter(({ matches }) => matches.length > 1);
  return {
    approvers,
    pending: pending.map(m => ({ issue: m.issue, proposal_id: m.payout.proposal_id, proposer: m.proposal.proposer, kind: m.proposal.kind })),
    problem: duplicated.length
      ? duplicated.map(({ m, matches }) => duplicateProblem(m, matches)).join("; ")
      : pending.length ? await deliverablesProblem(pending) : null,
  };
}

/** Why a task with more than one live proposal must not be approved as it stands. */
function duplicateProblem(m, matches) {
  const ids = matches.map(p => p.id);
  const extras = ids.filter(id => id !== m.payout.proposal_id);
  return `#${m.issue} has ${ids.length} live payout proposals (${ids.join(", ")}) for one payment; reject ${extras.join(", ")} so only ${m.payout.proposal_id} can be paid`;
}

/** What a payout proposal says: Trezu shows `title` and links `url`, the task. */
export const proposalDescription = (jobNumber, m) => JSON.stringify({
  title: `Job #${jobNumber}: ${m.title}`,
  notes: `MultiAgency payout to ${m.payee} for signed-off work on issue #${m.issue}`,
  url: m.url,
});

/**
 * Every live proposal already filed for this task: the same task, payee,
 * amount and token. More than one means two coordinators raced to file it,
 * and approving both would pay the task twice.
 */
function matchingProposals(proposals, m) {
  return proposals.filter(p => {
    const transfer = p.kind?.Transfer;
    let url = null;
    try { url = JSON.parse(p.description).url; } catch {}
    return transfer && transfer.token_id === USDC && transfer.receiver_id === m.payee && transfer.amount === m.amount &&
      url === m.url && !DEAD.includes(p.status);
  });
}

/**
 * A live proposal already filed for this task: the same task, payee, amount
 * and token. A run whose reply was lost after the proposal landed must not
 * file a second one, which could be paid twice.
 */
export function filedProposal(proposals, m) {
  return matchingProposals(proposals, m)[0] ?? null;
}

async function recentProposals() {
  const last = await view(network.treasury, "get_last_proposal_id", {});
  return view(network.treasury, "get_proposals", { from_index: Math.max(0, last - 100), limit: 100 });
}

/** File one proposal per paid task that has none, reusing any already on chain. Check payoutProblem first. */
export async function proposePayouts(job, signer, log = console.log) {
  // Volunteer tasks file nothing and read nothing: the sweep skips them whole.
  const targets = job.members.filter(m => !m.payout && !isVolunteer(m));
  if (targets.length === 0) return;
  const recent = await recentProposals();
  for (const m of targets) {
    const filed = filedProposal(recent, m);
    let proposalId = filed?.id;
    let hash = null;
    if (!filed) {
      const proposal = {
        description: proposalDescription(job.number, m),
        kind: { Transfer: { token_id: USDC, receiver_id: m.payee, amount: m.amount, msg: null } },
      };
      // add_proposal burns about 3 Tgas; the default 100 Tgas would reserve 0.1 NEAR per call.
      ({ hash, value: proposalId } = await call(signer, network.treasury, "add_proposal", { proposal }, { gas: "30000000000000" }));
    }
    const trezu = trezuRequestLink(proposalId);
    await comment(m.issue, [
      `**Payout proposed:** DAO proposal ${proposalId} on \`${network.treasury}\` transfers ${Number(m.amount) / 1e6} USDC to \`${m.payee}\`${trezu ? ` ([review in Trezu](${trezu}))` : ""}.`,
      "",
      fence("payout", { proposal_id: proposalId, treasury: network.treasury, payee: m.payee, amount: m.amount, proposed_tx: hash }),
    ].join("\n"));
    log(`#${m.issue}: proposal ${proposalId}${filed ? " (already on chain)" : ""}`);
  }
}

/**
 * One comment per task holding more than one live proposal for its payout,
 * naming the ids and asking an approver to reject the extras: the task's
 * recorded payout keys to one of them, and approving two would pay it twice.
 * Said once per wording, so the sweep repeats nothing; a further duplicate
 * changes the ids and is named by a fresh comment.
 */
export async function flagDuplicateProposals(job, bot, log = console.log) {
  const pending = job.members.filter(m => m.payout?.status === "InProgress");
  if (pending.length === 0) return;
  const recent = await recentProposals();
  for (const m of pending) {
    const matches = matchingProposals(recent, m);
    if (matches.length < 2) continue;
    const ids = matches.map(p => p.id);
    const extras = ids.filter(id => id !== m.payout.proposal_id);
    const named = ids => ids.length === 2 ? `${ids[0]} and ${ids[1]}` : ids.join(", ");
    const body = [
      `**Duplicate payout proposals:** DAO proposals ${named(ids)} on \`${network.treasury}\` each pay this task ${Number(m.amount) / 1e6} USDC to \`${m.payee}\`.`,
      `Approve ${m.payout.proposal_id} alone and reject ${named(extras)}, so this task cannot be paid twice.`,
    ].join(" ");
    const said = (await comments(m.issue)).some(c => c.user.login === bot && c.body === body);
    if (said) continue;
    await comment(m.issue, body);
    log(`#${m.issue}: proposals ${named(ids)} are live for one payout; flagged for the extras' rejection`);
  }
}

/** Record each payment an approver has voted through, from the treasury's history. */
export async function recordApprovals(job, log = console.log) {
  for (const m of job.members.filter(m => m.payout?.status === "Approved" && !m.paid)) {
    // A proposal found on chain rather than filed here has no transaction of
    // ours; the job's deposit is earlier than any vote on it.
    const from = await txBlockHeight(m.payout.proposed_tx ?? job.engagement.deposit.transaction);
    const approval = await findApproval(m.payout.proposal_id, from);
    if (!approval) {
      log(`#${m.issue}: proposal ${m.payout.proposal_id} is Approved but its vote is not indexed yet`);
      continue;
    }
    await recordPaid(m, approval);
    log(`#${m.issue}: paid ${m.amount} to ${m.payee}, approved by ${approval.approver}`);
  }
}

/**
 * Close the job once every task is paid — volunteer tasks settle once
 * delivered. Returns what an undelivered volunteer task holds against the
 * close, or null once the job closes (or already stood closed, or a paid
 * task still waits on its payout, which payoutProblem's hold already names).
 */
export async function closeIfPaid(jobNumber, log = console.log) {
  const current = await loadEngagement(jobNumber);
  if (current.members.some(m => !m.paid && !isVolunteer(m))) return null;
  // A volunteer's work is never proposed or paid, so for it this close is the
  // only delivery check: callers reach it without payoutProblem (the
  // coordinator without a proposer, payout.mjs reconcile and approve), and a
  // job must not complete over an undelivered or edited volunteer task.
  const held = await volunteerProblem(current.members);
  if (held) return held;
  if (current.state === "open") {
    const paid = current.members.filter(m => m.paid).length;
    await comment(jobNumber, `**Job complete.** ${paid} payouts executed from \`${network.treasury}\` (${Number(current.totals.committed) / 1e6} USDC); ${Number(current.totals.margin) / 1e6} USDC of the deposit remains with MultiAgency.`);
    await github("PATCH", `/issues/${jobNumber}`, { state: "closed", state_reason: "completed" });
    log(`#${jobNumber}: closed`);
  }
  // Closed now or earlier: drop `blocked`, record each delivery.
  const settled = await settleEpic(jobNumber);
  if (settled) log(`#${jobNumber}: settled (${Object.keys(settled).join(", ")})`);
  return null;
}
