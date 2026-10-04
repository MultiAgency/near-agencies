// Paying a job's team from the DAO treasury: the checks before any proposal,
// one Transfer proposal per task, and recording each payment once an approver
// has voted. Shared by payout.mjs (a person at a terminal) and the coordinator
// (automatically, with a key that can only file proposals). Approving is
// always a person's vote.
import { comment, commentAt, digest, fence, github, pullRepo, pullRequest, TASK_REPO } from "./github.mjs";
import { findApproval, txBlockHeight } from "./history.mjs";
import { loadEngagement, recordPaid, settleEpic } from "./engagement-state.mjs";
import { USDC, call, view } from "./near.mjs";
import { byGithub } from "./roster.mjs";
import { pinProblem } from "./seats.mjs";
import { network, trezuRequestLink } from "./network.mjs";

export const DEAD = ["Rejected", "Failed", "Expired", "Removed"];
const list = members => members.map(m => `#${m.issue}`).join(", ");

/** Why the job's payouts cannot be proposed yet, or null. */
export async function payoutProblem(job) {
  const { members } = job;
  if (members.length === 0) return "the job has no team";
  const unfinished = members.filter(m => m.state !== "closed" || !m.handoff);
  if (unfinished.length) return `${list(unfinished)} ${unfinished.length === 1 ? "has" : "have"} not closed with a handoff`;
  const unpaid = members.filter(m => !m.payee);
  if (unpaid.length) return `no roster payout account for the claimant of ${list(unpaid)}`;
  const mismatched = members.filter(m => m.handoff.payout?.account_id !== m.payee);
  if (mismatched.length) return `the handoff's payout account differs from the payee on ${list(mismatched)}`;
  // A code task delivers a pull request; the payout counts one only once it is
  // merged, from the task's repository, by the assignee the handoff pays.
  // Another task kind may cite pull requests; its links are not the deliverable.
  for (const m of members.filter(m => m.skills?.includes("skill:code"))) {
    const pulls = [...new Set((m.handoff.links ?? [])
      .map(link => /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(link)?.[0])
      .filter(Boolean))];
    if (pulls.length === 0) return `#${m.issue}'s handoff links no pull request`;
    let problem = null;
    for (const url of pulls) {
      if (pullRepo(url) !== TASK_REPO.toLowerCase()) {
        problem ??= `#${m.issue}'s pull request ${url} is in another repository`;
        continue;
      }
      const pr = await pullRequest(url);
      const author = pr.user.login;
      const claimant = (m.claimedBy ?? []).some(login => login.toLowerCase() === author.toLowerCase()) &&
        byGithub(author)?.nearAccount === m.payee;
      if (!claimant) {
        problem ??= `#${m.issue}'s pull request ${url} is by @${author}, not the claimant`;
        continue;
      }
      if (!pr.merged) {
        problem ??= `#${m.issue}'s pull request ${url} is not merged yet`;
        continue;
      }
      problem = null;
      break;
    }
    if (problem) return problem;
  }
  return deliverablesProblem(members);
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
export async function pendingPayouts(job, approvers) {
  const pending = job.members.filter(m => m.payout?.status === "InProgress");
  return {
    approvers,
    pending: pending.map(m => ({ issue: m.issue, proposal_id: m.payout.proposal_id, proposer: m.proposal.proposer, kind: m.proposal.kind })),
    problem: pending.length ? await deliverablesProblem(pending) : null,
  };
}

/** What a payout proposal says: Trezu shows `title` and links `url`, the task. */
export const proposalDescription = (jobNumber, m) => JSON.stringify({
  title: `Job #${jobNumber}: ${m.title}`,
  notes: `MultiAgency payout to ${m.payee} for signed-off work on issue #${m.issue}`,
  url: m.url,
});

/**
 * A live proposal already filed for this task: the same task, payee, amount
 * and token. A run whose reply was lost after the proposal landed must not
 * file a second one, which could be paid twice.
 */
export function filedProposal(proposals, m) {
  return proposals.find(p => {
    const transfer = p.kind?.Transfer;
    let url = null;
    try { url = JSON.parse(p.description).url; } catch {}
    return transfer && transfer.token_id === USDC && transfer.receiver_id === m.payee && transfer.amount === m.amount &&
      url === m.url && !DEAD.includes(p.status);
  }) ?? null;
}

async function recentProposals() {
  const last = await view(network.treasury, "get_last_proposal_id", {});
  return view(network.treasury, "get_proposals", { from_index: Math.max(0, last - 100), limit: 100 });
}

/** File one proposal per task that has none, reusing any already on chain. Check payoutProblem first. */
export async function proposePayouts(job, signer, log = console.log) {
  const recent = await recentProposals();
  for (const m of job.members.filter(m => !m.payout)) {
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

/** Close the job once every task is paid, and settle its board state. */
export async function closeIfPaid(jobNumber, log = console.log) {
  const current = await loadEngagement(jobNumber);
  if (current.members.some(m => !m.paid)) return;
  if (current.state === "open") {
    await comment(jobNumber, `**Job complete.** ${current.members.length} payouts executed from \`${network.treasury}\` (${Number(current.totals.committed) / 1e6} USDC); ${Number(current.totals.margin) / 1e6} USDC of the deposit remains with MultiAgency.`);
    await github("PATCH", `/issues/${jobNumber}`, { state: "closed", state_reason: "completed" });
    log(`#${jobNumber}: closed`);
  }
  // Closed now or earlier: drop `blocked`, record each delivery.
  const settled = await settleEpic(jobNumber);
  if (settled) log(`#${jobNumber}: settled (${Object.keys(settled).join(", ")})`);
}
