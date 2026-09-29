// Payouts from the MultiAgency DAO treasury, from a terminal. The coordinator
// proposes and records them on its own (lib/payouts.mjs has the rules); these
// commands are the manual path, and the only way to vote from a local key.
//
//   node payout.mjs status    <job>                   each task's work and payout state
//   node payout.mjs propose   <job> --as <requestor>  file one Transfer proposal per task
//   node payout.mjs approve   <job> --as <approver>   vote directly (testnet, or a local approver key);
//                                                    the approver must not be the proposer
//   node payout.mjs reconcile <job>                   record approvals made elsewhere (a wallet, Trezu)
//
// Proposals are filed only after every task is closed with a handoff whose
// `payout.account_id` matches the task's payee, every pull request a handoff
// links (code tasks) is merged, and every deliverable a handoff pins by sha256
// is unedited. Each proposal and executed payout is recorded on its task; the
// job closes once every payout has executed, which also settles its board
// state: the `blocked` label comes off and the `## Team` checklist records
// which tasks delivered. NEAR_NETWORK selects testnet (default) or mainnet.
import { loadEngagement, recordPaid } from "./lib/engagement-state.mjs";
import { call, explorer, ftBalance, view } from "./lib/near.mjs";
import { network } from "./lib/network.mjs";
import { DEAD, closeIfPaid, deliverablesProblem, payoutProblem, proposePayouts, recordApprovals } from "./lib/payouts.mjs";

const [command, jobNumber, flag, signer] = process.argv.slice(2);
const needsSigner = command === "propose" || command === "approve";
if (!["status", "propose", "approve", "reconcile"].includes(command) || !jobNumber || (needsSigner && (flag !== "--as" || !signer))) {
  console.error("usage: node payout.mjs status|reconcile <job> | propose|approve <job> --as <account>");
  process.exit(64);
}

const job = await loadEngagement(jobNumber);
const paidOn = job.engagement.deposit.network ?? "testnet";
if (paidOn !== network.networkId) {
  throw new Error(`#${jobNumber} was paid on ${paidOn}; set NEAR_NETWORK=${paidOn}`);
}
const { members } = job;
if (members.length === 0) throw new Error(`#${jobNumber} has no assembled team`);

if (command === "status") {
  for (const m of members) {
    const payout = m.payout ? `proposal ${m.payout.proposal_id} ${m.payout.status}${m.paid ? ` paid ${m.paid.transaction}` : ""}` : "no proposal";
    console.log(`#${m.issue} ${m.state} handoff=${m.handoff ? "yes" : "no"} → ${m.payee} ${m.amount}: ${payout}`);
  }
} else if (command === "propose") {
  const problem = await payoutProblem(job);
  if (problem) throw new Error(problem);
  await proposePayouts(job, signer);
  reportDead();
  await closeIfPaid(jobNumber);
} else if (command === "approve") {
  const pending = members.filter(m => m.payout?.status === "InProgress");
  // Sputnik lets a member approve their own proposal; separation of duties is ours to keep.
  const own = pending.filter(m => m.proposal.proposer === signer);
  if (own.length > 0) {
    throw new Error(`${signer} filed the proposals for ${own.map(m => `#${m.issue}`).join(", ")}; another approver must vote`);
  }
  const problem = await deliverablesProblem(pending);
  if (problem) throw new Error(problem);
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
  await closeIfPaid(jobNumber);
} else {
  await recordApprovals(job);
  reportDead();
  await closeIfPaid(jobNumber);
}

function reportDead() {
  for (const m of members.filter(m => m.payout && DEAD.includes(m.payout.status))) {
    console.log(`#${m.issue}: proposal ${m.payout.proposal_id} is ${m.payout.status}; file a new proposal`);
  }
}
