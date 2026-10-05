// The epic issue that opens a job on the board: a paid engagement whose
// deposit is final (lib/engagements.mjs), or one opened from the board with
// no deposit at all (lib/coordinator.mjs, a ```job-request issue). Either
// way the ```engagement block is bot-authored, which is what makes the issue
// a job (lib/engagement-state.mjs).
import { fence, github } from "./github.mjs";
import { network, txLink } from "./network.mjs";

/** Create the epic for an engagement record whose deposit is final — or,
 * with a deposit of "0" and no transaction, one opened from the board. */
export function createEpic(record) {
  const { deposit } = record;
  const engagement = {
    engagement_id: record.code,
    channel: record.channel,
    // The board request the job was opened from, when one was: the request's
    // handled mark is the bot's answer comment, and this field is the fallback
    // that finds the job when that comment never landed (lib/coordinator.mjs).
    ...(record.request ? { request: record.request } : {}),
    // The registry issue an auto job builds (lib/coordinator.mjs): one job
    // per issue, however often the coordinator restarts, is judged from this
    // field, and a job's tasks carry it on their ```terms.
    ...(record.source ? { source: record.source } : {}),
    org: deposit.org,
    // The repository the job named on intake, when it named one; without it
    // every code task defaults to near-agencies (agents/claude-worker/repos.mjs).
    ...(record.repo ? { repo: record.repo } : {}),
    // An absent transaction drops out of the block (JSON.stringify keeps no
    // undefined field): only a deposit that landed on chain carries one.
    deposit: { amount: deposit.amount, asset: network.usdc, treasury: network.treasury, transaction: deposit.transaction, network: network.networkId },
  };
  const opened = deposit.transaction
    ? `**Job** opened by \`${deposit.org}\` with a ${Number(deposit.amount) / 1e6} USDC deposit to \`${network.treasury}\` ([transaction](${txLink(deposit.transaction)})).`
    : `**Job** opened by @${deposit.org} with no deposit, so its tasks can only be volunteer work.`;
  return github("POST", "/issues", {
    title: `Job: ${record.title}`,
    labels: ["engagement"],
    body: [
      opened,
      "",
      record.brief,
      "",
      fence("engagement", engagement),
    ].join("\n"),
  });
}
