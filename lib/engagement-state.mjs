// Read an engagement's full state from its epic, its team issues, and the
// treasury: the one view shared by the payout tooling and the demo app.
import { comments, fence, fenced, github, issue, comment, isTrusted, repoIssue, repoUrl } from "./github.mjs";
import { view } from "./near.mjs";
import { trezuRequestLink, txLink } from "./network.mjs";
import { byGithub } from "./roster.mjs";
import { isVolunteer } from "./team.mjs";

/**
 * An issue counts as a job only when the bot opened it — or an owner did,
 * which lib/recover.mjs reuses when a stuck Hire's epic was opened by hand.
 * A ```engagement block a stranger wrote on their own issue — with the
 * `engagement` label or without — is never one.
 */

export async function listEngagements() {
  const epics = await github("GET", "/issues?labels=engagement&state=all&per_page=50");
  const jobs = await Promise.all(epics.map(async epic => epic.user?.login && await isTrusted(epic.user.login) ? epic : null));
  return jobs.filter(Boolean)
    .map(epic => {
      const engagement = fenced(epic.body, "engagement");
      return {
        number: epic.number,
        title: epic.title.replace(/^Job: /, ""),
        state: epic.state === "closed" && epic.state_reason !== "completed" ? "cancelled" : epic.state,
        org: engagement?.org,
        deposit: engagement?.deposit.amount,
        network: engagement?.deposit.network ?? "testnet",
        assembled: Boolean(fenced(epic.body, "team")),
        committed: fenced(epic.body, "team")?.committed ?? "0",
        created_at: epic.created_at,
      };
    });
}

export async function loadEngagement(number) {
  const epic = await issue(number);
  const engagement = fenced(epic.body, "engagement");
  // A block a stranger wrote on their own issue is not a job, whatever it
  // says; an owner's own hand-opened epic is (lib/recover.mjs reuses it).
  if (!engagement || !(epic.user?.login && await isTrusted(epic.user.login))) throw new Error(`#${number} is not an engagement`);
  const team = fenced(epic.body, "team");
  const members = team ? await Promise.all(team.members.map(member)) : [];
  const committed = BigInt(team?.committed ?? 0);
  const paid = members.filter(m => m.paid).reduce((sum, m) => sum + BigInt(m.amount), 0n);
  return {
    number: epic.number,
    title: epic.title.replace(/^Job: /, ""),
    brief: epic.body.split("\n").slice(2).join("\n").split("```engagement")[0].trim(),
    state: epic.state,
    url: epic.html_url,
    // A deposit link exists only for a deposit that landed on chain: a job
    // opened from the board carries no transaction, and no link either.
    engagement: {
      ...engagement,
      deposit: {
        ...engagement.deposit,
        ...(engagement.deposit.transaction ? { link: txLink(engagement.deposit.transaction) } : {}),
      },
    },
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

// A proposal removed by a DAO member is deleted from the treasury, not kept
// with a status: read it as Removed rather than fail the whole job. Any other
// error, such as a slow RPC, still fails.
export async function proposalState(treasury, id, read = view) {
  try {
    return await read(treasury, "get_proposal", { id });
  } catch (error) {
    if (error.message.includes("ERR_NO_PROPOSAL")) return { status: "Removed" };
    throw error;
  }
}

/** The source issue's own assignees (`owner/repo#n`), for an auto job's claimant. */
async function sourceClaimedBy(source) {
  const [repoName, number] = source.split("#");
  const sourceIssue = await repoIssue(repoName, Number(number));
  return sourceIssue.assignees.map(a => a.login);
}

// A team member's issue, its handoff, and its payout records with live proposal state.
async function member(terms) {
  const [child, thread] = await Promise.all([issue(terms.issue), comments(terms.issue)]);
  // An auto job's claimant is the source issue's assignee (#189), not the
  // board task's own — the board copies it and never claims on its own. A
  // task claimed on the board before this landed carries no issue assignee
  // yet, and keeps its board assignee as its claimant.
  const sourceAssignees = terms.source ? await sourceClaimedBy(terms.source) : null;
  const claimedBy = sourceAssignees?.length ? sourceAssignees : child.assignees.map(a => a.login);
  // Payout records count only from the bot or an owner (lib/github.mjs).
  const first = async info => {
    for (const c of thread) {
      const value = fenced(c.body, info);
      if (value && await isTrusted(c.user.login)) return value;
    }
    return null;
  };
  // A revised seat has several handoffs; the claimant's latest is the one that counts.
  const handoffComment = thread.filter(c => claimedBy.includes(c.user.login) && fenced(c.body, "handoff")).at(-1);
  const handoff = handoffComment ? fenced(handoffComment.body, "handoff") : null;
  const payout = await first("payout");
  const paid = await first("paid");
  const proposal = payout ? await proposalState(payout.treasury, payout.proposal_id) : null;
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

// Where a job stands, from what its seats and payouts show. Volunteer tasks
// wait for no payout, so they hold neither `accepting` nor the close.
export function stage(epic, team, members) {
  if (epic.state === "closed") return epic.state_reason === "completed" ? "complete" : "cancelled";
  if (!team) return "assembling";
  if (members.some(m => m.state === "open")) return "working";
  if (members.some(m => !m.payout && !isVolunteer(m))) return "accepting";
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

/**
 * A closed epic no longer waits on seats: its `blocked` label comes off, and
 * each `## Team` checkbox records whether that seat closed with a handoff.
 * Pure: returns the PATCH payload, or null when the epic already reads settled.
 */
export function settledEpicPatch(epic, members = []) {
  const labels = epic.labels.map(label => label.name);
  const body = teamChecklist(epic.body, new Map(members.map(m => [m.issue, m.state === "closed" && Boolean(m.handoff)])));
  const patch = {};
  if (labels.includes("blocked")) patch.labels = labels.filter(name => name !== "blocked");
  if (body !== epic.body) patch.body = body;
  return patch.labels || patch.body ? patch : null;
}

/** Settle one epic (a no-op for an open one, or one that is not an engagement). */
export async function settleEpic(number) {
  const epic = await issue(number);
  if (epic.state !== "closed" || !fenced(epic.body, "engagement")) return null;
  const team = fenced(epic.body, "team");
  const members = team ? await Promise.all(team.members.map(member)) : [];
  const patch = settledEpicPatch(epic, members);
  if (patch) await github("PATCH", `/issues/${number}`, patch);
  return patch;
}

// The checklist assemble.mjs writes under `## Team`, converging each box to
// whether its seat closed with a handoff. Stops at the ```team fence; boxes
// naming issues that are not team members, and everything above the section,
// are left alone.
function teamChecklist(body, delivered) {
  const lines = body.split("\n");
  let team = -1;
  lines.forEach((line, at) => {
    if (/^## Team\s*$/.test(line)) team = at;
  });
  if (team === -1) return body;
  for (let at = team + 1; at < lines.length && !lines[at].startsWith("```"); at++) {
    lines[at] = lines[at].replace(/^(- \[)([ x])(\] #)(\d+)/, (box, open, ticked, close, n) =>
      delivered.has(Number(n)) ? `${open}${delivered.get(Number(n)) ? "x" : " "}${close}${n}` : box);
  }
  return lines.join("\n");
}
