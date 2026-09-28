// Acceptance and payouts from the MultiAgency DAO treasury.
//
//   node payout.mjs status    <epic>                   each member's work and payout state
//   node payout.mjs propose   <epic> --as <requestor>  file one Transfer proposal per member
//   node payout.mjs approve   <epic> --as <approver>   vote directly (testnet, or a local approver key);
//                                                     the approver must not be the proposer
//   node payout.mjs reconcile <epic>                   record approvals made elsewhere (Trezu on mainnet)
//
// Proposals are filed only after every team issue is closed with a handoff
// whose `payout.account_id` matches the seat's payee, and every pull request a
// handoff links (code seats) is merged. Each proposal and
// executed payout is recorded on its issue; the epic closes once every payout
// has executed. NEAR_NETWORK selects testnet (default) or mainnet.
import { comment, fence, github, pullRequest } from "./lib/github.mjs";
import { findApproval, txBlockHeight } from "./lib/history.mjs";
import { loadEngagement, recordPaid } from "./lib/engagement-state.mjs";
import { USDC, call, explorer, ftBalance, view } from "./lib/near.mjs";
import { network, trezuRequestLink } from "./lib/network.mjs";

const [command, epicNumber, flag, signer] = process.argv.slice(2);
const needsSigner = command === "propose" || command === "approve";
if (!["status", "propose", "approve", "reconcile"].includes(command) || !epicNumber || (needsSigner && (flag !== "--as" || !signer))) {
  console.error("usage: node payout.mjs status|reconcile <epic> | propose|approve <epic> --as <account>");
  process.exit(64);
}

const engagement = await loadEngagement(epicNumber);
const paidOn = engagement.engagement.deposit.network ?? "testnet";
if (paidOn !== network.networkId) {
  throw new Error(`#${epicNumber} was paid on ${paidOn}; set NEAR_NETWORK=${paidOn}`);
}
const { members } = engagement;
if (members.length === 0) throw new Error(`#${epicNumber} has no assembled team`);

if (command === "status") {
  for (const m of members) {
    const payout = m.payout ? `proposal ${m.payout.proposal_id} ${m.payout.status}${m.paid ? ` paid ${m.paid.transaction}` : ""}` : "no proposal";
    console.log(`#${m.issue} ${m.state} handoff=${m.handoff ? "yes" : "no"} → ${m.payee} ${m.amount}: ${payout}`);
  }
} else if (command === "propose") {
  const unfinished = members.filter(m => m.state !== "closed" || !m.handoff);
  if (unfinished.length > 0) {
    throw new Error(`not accepted yet: ${unfinished.map(m => `#${m.issue}`).join(", ")} lack a closed issue with a handoff`);
  }
  const unpaid = members.filter(m => !m.payee);
  if (unpaid.length > 0) {
    throw new Error(`no roster payout account for the claimant of ${unpaid.map(m => `#${m.issue}`).join(", ")}`);
  }
  const mismatched = members.filter(m => m.handoff.payout?.account_id !== m.payee);
  if (mismatched.length > 0) {
    throw new Error(`handoff payout account differs from terms on ${mismatched.map(m => `#${m.issue}`).join(", ")}`);
  }
  // Code seats deliver a pull request; the work counts only once it is merged.
  for (const m of members) {
    for (const url of (m.handoff.links ?? []).filter(link => /\/pull\/\d+$/.test(link))) {
      const pr = await pullRequest(url);
      if (!pr.merged) throw new Error(`#${m.issue}: ${url} is not merged yet`);
    }
  }
  for (const m of members.filter(m => !m.payout)) {
    const kind = { Transfer: { token_id: USDC, receiver_id: m.payee, amount: m.amount, msg: null } };
    // Trezu parses JSON descriptions and displays `title` (else `notes`) with a `url` link.
    const description = JSON.stringify({
      title: `Engagement #${epicNumber}: ${m.title}`,
      notes: `MultiAgency payout to ${m.payee} for accepted work on issue #${m.issue}`,
      url: m.url,
    });
    const { hash, value: proposalId } = await call(signer, network.treasury, "add_proposal", { proposal: { description, kind } });
    const trezu = trezuRequestLink(proposalId);
    await comment(m.issue, [
      `**Payout proposed:** DAO proposal ${proposalId} on \`${network.treasury}\` transfers ${Number(m.amount) / 1e6} USDC to \`${m.payee}\`${trezu ? ` ([review in Trezu](${trezu}))` : ""}.`,
      "",
      fence("payout", { proposal_id: proposalId, treasury: network.treasury, payee: m.payee, amount: m.amount, proposed_tx: hash }),
    ].join("\n"));
    console.log(`#${m.issue}: proposal ${proposalId} (${explorer(hash)})${trezu ? ` ${trezu}` : ""}`);
  }
} else if (command === "approve") {
  const pending = members.filter(m => m.payout?.status === "InProgress");
  // Sputnik lets a member approve their own proposal; separation of duties is ours to keep.
  const own = pending.filter(m => m.proposal.proposer === signer);
  if (own.length > 0) {
    throw new Error(`${signer} filed the proposals for ${own.map(m => `#${m.issue}`).join(", ")}; another approver must vote`);
  }
  for (const m of pending) {
    const before = await ftBalance(m.payee);
    // Sputnik v2.3.1 requires the proposal kind echoed back (ERR_WRONG_KIND guard).
    const { hash } = await call(signer, network.treasury, "act_proposal", {
      id: m.payout.proposal_id,
      action: "VoteApprove",
      proposal: m.proposal.kind,
    }, { gas: "200000000000000" });
    // The transfer runs as a detached promise whose callback can flip the
    // status to Failed; FINAL covers it, and the balance delta is the proof.
    const { status } = await view(network.treasury, "get_proposal", { id: m.payout.proposal_id });
    const received = (await ftBalance(m.payee)) - before;
    if (status !== "Approved" || received !== BigInt(m.amount)) {
      throw new Error(`proposal ${m.payout.proposal_id} is ${status}; ${m.payee} received ${received} of ${m.amount}`);
    }
    await recordPaid(m, { transaction: hash, approver: signer });
    console.log(`#${m.issue}: paid ${m.amount} to ${m.payee} (${explorer(hash)})`);
  }
  await closeIfPaid();
} else {
  for (const m of members.filter(m => m.payout?.status === "Approved" && !m.paid)) {
    const approval = await findApproval(m.payout.proposal_id, await txBlockHeight(m.payout.proposed_tx));
    if (!approval) {
      console.log(`#${m.issue}: proposal ${m.payout.proposal_id} is Approved but its vote is not indexed yet`);
      continue;
    }
    await recordPaid(m, approval);
    console.log(`#${m.issue}: paid ${m.amount} to ${m.payee}, approved by ${approval.approver} (${explorer(approval.transaction)})`);
  }
  for (const m of members.filter(m => m.payout && ["Rejected", "Failed", "Expired", "Removed"].includes(m.payout.status))) {
    console.log(`#${m.issue}: proposal ${m.payout.proposal_id} is ${m.payout.status}; file a new proposal`);
  }
  await closeIfPaid();
}

async function closeIfPaid() {
  const current = await loadEngagement(epicNumber);
  if (current.state !== "open" || current.members.some(m => !m.paid)) return;
  await comment(epicNumber, `**Engagement complete.** ${current.members.length} payouts executed from \`${network.treasury}\` (${Number(current.totals.committed) / 1e6} USDC); ${Number(current.totals.margin) / 1e6} USDC of the deposit remains with MultiAgency.`);
  await github("PATCH", `/issues/${epicNumber}`, { state: "closed", state_reason: "completed" });
  console.log(`#${epicNumber}: closed`);
}
