// Read an engagement's full state from its epic, its team issues, and the
// treasury: the one view shared by the payout tooling and the demo app.
import { comments, fence, fenced, github, issue, comment, repoUrl } from "./github.mjs";
import { view } from "./near.mjs";
import { trezuRequestLink, txLink } from "./network.mjs";
import { byGithub } from "./roster.mjs";

export async function listEngagements() {
  const epics = await github("GET", "/issues?labels=engagement&state=all&per_page=50");
  return epics.map(epic => {
    const engagement = fenced(epic.body, "engagement");
    return {
      number: epic.number,
      title: epic.title.replace(/^Engagement: /, ""),
      state: epic.state === "closed" && epic.state_reason !== "completed" ? "cancelled" : epic.state,
      org: engagement?.org,
      deposit: engagement?.deposit.amount,
      network: engagement?.deposit.network ?? "testnet",
      assembled: Boolean(fenced(epic.body, "team")),
      created_at: epic.created_at,
    };
  });
}

export async function loadEngagement(number) {
  const epic = await issue(number);
  const engagement = fenced(epic.body, "engagement");
  if (!engagement) throw new Error(`#${number} is not an engagement`);
  const team = fenced(epic.body, "team");
  const members = team ? await Promise.all(team.members.map(member)) : [];
  const committed = BigInt(team?.committed ?? 0);
  const paid = members.filter(m => m.paid).reduce((sum, m) => sum + BigInt(m.amount), 0n);
  return {
    number: epic.number,
    title: epic.title.replace(/^Engagement: /, ""),
    brief: epic.body.split("\n").slice(2).join("\n").split("```engagement")[0].trim(),
    state: epic.state,
    url: epic.html_url,
    engagement: { ...engagement, deposit: { ...engagement.deposit, link: txLink(engagement.deposit.transaction) } },
    stage: stage(epic, team, members),
    members,
    totals: {
      deposit: engagement.deposit.amount,
      committed: committed.toString(),
      paid: paid.toString(),
      margin: (BigInt(engagement.deposit.amount) - committed).toString(),
    },
  };
}

// A team member's issue, its handoff, and its payout records with live proposal state.
async function member(terms) {
  const [child, thread] = await Promise.all([issue(terms.issue), comments(terms.issue)]);
  const first = info => thread.map(c => fenced(c.body, info)).find(Boolean) ?? null;
  // A revised seat has several handoffs; the latest is the one that counts.
  const handoffComment = thread.filter(c => fenced(c.body, "handoff")).at(-1);
  const handoff = handoffComment ? fenced(handoffComment.body, "handoff") : null;
  const payout = first("payout");
  const paid = first("paid");
  const proposal = payout ? await view(payout.treasury, "get_proposal", { id: payout.proposal_id }) : null;
  const claimedBy = child.assignees.map(a => a.login);
  const claimant = claimedBy.map(byGithub).find(Boolean) ?? null;
  return {
    ...terms,
    // Early engagements pinned the payee in the terms; now the claimant is paid.
    // A payout already proposed records its payee, which stays true after the
    // claimant leaves the roster.
    payee: terms.payee ?? payout?.payee ?? claimant?.nearAccount ?? null,
    title: child.title,
    url: child.html_url,
    state: child.state,
    human: child.labels.some(label => label.name === "human-only"),
    skills: child.labels.map(label => label.name).filter(name => name.startsWith("skill:")),
    handoff,
    handoffSummary: handoffComment?.body.match(/^\*\*Handoff:\*\*\s*(.+)$/m)?.[1] ?? null,
    handoffBy: handoffComment?.user.login ?? null,
    claimedBy,
    deliverables: [
      ...(handoff?.changed_files ?? []).map(path => ({ path, url: `${repoUrl}/blob/main/${path}` })),
      ...(handoff?.links ?? []).filter(url => url.includes("#issuecomment-")).map(url => ({ path: "deliverable comment", url })),
    ],
    worker: handoff?.hermes ?? null,
    payout: payout && { ...payout, status: proposal.status, trezu: trezuRequestLink(payout.proposal_id) },
    proposal,
    paid: paid && { ...paid, link: txLink(paid.transaction) },
  };
}

function stage(epic, team, members) {
  if (epic.state === "closed") return epic.state_reason === "completed" ? "complete" : "cancelled";
  if (!team) return "assembling";
  if (members.some(m => m.state === "open")) return "working";
  if (members.some(m => !m.payout)) return "accepting";
  return "paying";
}

/** Record an executed payout on its issue as a machine-readable ```paid block. */
export async function recordPaid(m, { transaction, approver }) {
  const record = { proposal_id: m.payout.proposal_id, treasury: m.payout.treasury, payee: m.payee, amount: m.amount, transaction, approver };
  await comment(m.issue, [
    `**Paid:** \`${approver}\` approved DAO proposal ${record.proposal_id}; ${Number(m.amount) / 1e6} USDC sent to \`${m.payee}\` ([transaction](${txLink(transaction)})).`,
    "",
    fence("paid", record),
  ].join("\n"));
}
