// The epic issue that opens a paid engagement on the board.
import { fence, github } from "./github.mjs";
import { network, txLink } from "./network.mjs";

/** Create the epic for an engagement record whose deposit is final. */
export function createEpic(record) {
  const { deposit } = record;
  const engagement = {
    engagement_id: record.code,
    channel: record.channel,
    org: deposit.org,
    // The repository the job named on intake, when it named one; without it
    // every code task defaults to near-agencies (agents/claude-worker/repos.mjs).
    ...(record.repo ? { repo: record.repo } : {}),
    deposit: { amount: deposit.amount, asset: network.usdc, treasury: network.treasury, transaction: deposit.transaction, network: network.networkId },
  };
  return github("POST", "/issues", {
    title: `Job: ${record.title}`,
    labels: ["engagement"],
    body: [
      `**Job** opened by \`${deposit.org}\` with a ${Number(deposit.amount) / 1e6} USDC deposit to \`${network.treasury}\` ([transaction](${txLink(deposit.transaction)})).`,
      "",
      record.brief,
      "",
      fence("engagement", engagement),
    ].join("\n"),
  });
}
