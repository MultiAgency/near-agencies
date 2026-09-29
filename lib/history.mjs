// Indexed history of the treasury from the FastNear Transactions API, used to
// discover wallet deposits and payout approvals (including votes relayed by
// Trezu as NEP-366 delegate actions). Discovery only: every hit is confirmed
// against RPC at FINAL before it is trusted.
import { network } from "./network.mjs";
import { rpc } from "./near.mjs";

// A hung Transactions API request fails after TX_API_TIMEOUT_MS instead of
// stalling the deposit watcher that polls it.
const TX_API_TIMEOUT_MS = Number(process.env.TX_API_TIMEOUT_MS ?? "30000");

async function txApi(path, body) {
  const response = await fetch(`${network.txApi}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TX_API_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Transactions API ${path}: ${response.status}`);
  return response.json();
}

// Successful transactions touching `account` since `fromBlock`, oldest first.
async function* accountTransactions(account, fromBlock, filters = {}) {
  let resume_token;
  do {
    const page = await txApi("/v0/account", {
      account_id: account,
      from_tx_block_height: fromBlock,
      is_success: true,
      desc: false,
      limit: 200,
      ...filters,
      ...(resume_token ? { resume_token } : {}),
    });
    const hashes = page.account_txs.map(tx => tx.transaction_hash);
    for (let i = 0; i < hashes.length; i += 20) {
      const { transactions } = await txApi("/v0/transactions", { tx_hashes: hashes.slice(i, i + 20) });
      yield* transactions;
    }
    resume_token = page.account_txs.length === 200 ? page.resume_token : undefined;
  } while (resume_token);
}

// FunctionCalls a transaction makes on behalf of each sender, unwrapping
// Delegate actions so relayed calls report the delegating account.
export function functionCalls(tx) {
  const { signer_id, receiver_id, actions } = tx.transaction;
  return actions.flatMap(action => {
    if (action.Delegate) {
      const { sender_id, receiver_id: target, actions: inner } = action.Delegate.delegate_action;
      return inner.filter(a => a.FunctionCall).map(a => ({ sender: sender_id, receiver: target, call: a.FunctionCall }));
    }
    return action.FunctionCall ? [{ sender: signer_id, receiver: receiver_id, call: action.FunctionCall }] : [];
  }).map(({ sender, receiver, call }) => ({
    sender,
    receiver,
    method: call.method_name,
    args: JSON.parse(Buffer.from(call.args, "base64").toString() || "{}"),
  }));
}

// NEP-141 ft_transfer events emitted by successful receipts of `token`.
export function ftTransfers(tx, token) {
  return tx.receipts
    .filter(r => r.receipt.receiver_id === token && "SuccessValue" in r.execution_outcome.outcome.status)
    .flatMap(r => r.execution_outcome.outcome.logs
      .filter(log => log.startsWith("EVENT_JSON:"))
      .map(log => JSON.parse(log.slice("EVENT_JSON:".length)))
      .filter(event => event.standard === "nep141" && event.event === "ft_transfer")
      .flatMap(event => event.data.map(transfer => ({ ...transfer, receipt_id: r.receipt.receipt_id }))));
}

async function confirmFinal(tx) {
  const final = await rpc("EXPERIMENTAL_tx_status", {
    tx_hash: tx.transaction.hash,
    sender_account_id: tx.transaction.signer_id,
    wait_until: "FINAL",
  });
  return final.receipts_outcome;
}

/** A USDC transfer into the treasury whose memo carries `code`. */
export async function findDeposit(code, fromBlock) {
  for await (const tx of accountTransactions(network.treasury, fromBlock, { is_event_log: true })) {
    const transfer = ftTransfers(tx, network.usdc)
      .find(t => t.new_owner_id === network.treasury && (t.memo ?? "").includes(code));
    if (!transfer) continue;
    const outcomes = await confirmFinal(tx);
    const receipt = outcomes.find(o => o.id === transfer.receipt_id);
    if (!receipt || !("SuccessValue" in receipt.outcome.status)) continue;
    return { transaction: tx.transaction.hash, org: transfer.old_owner_id, amount: transfer.amount, memo: transfer.memo };
  }
  return null;
}

/** The VoteApprove that executed treasury proposal `id`, direct or relayed. */
export async function findApproval(id, fromBlock) {
  for await (const tx of accountTransactions(network.treasury, fromBlock, { is_function_call: true })) {
    const vote = functionCalls(tx).find(c =>
      c.receiver === network.treasury && c.method === "act_proposal" && c.args.id === id && c.args.action === "VoteApprove");
    if (vote) return { transaction: tx.transaction.hash, approver: vote.sender };
  }
  return null;
}

/** Block height at which a transaction was included, from indexed history. */
export async function txBlockHeight(hash) {
  const { transactions } = await txApi("/v0/transactions", { tx_hashes: [hash] });
  if (!transactions[0]) throw new Error(`transaction ${hash} not indexed`);
  return transactions[0].receipts[0].receipt.block_height;
}

export async function finalBlockHeight() {
  const block = await rpc("block", { finality: "final" });
  return block.header.height;
}
