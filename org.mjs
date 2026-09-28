// Organization client: pays the engagement deposit to the MultiAgency treasury
// and receives the kanban epic that tracks the engagement.
//
//   node org.mjs "<title>" "<brief>"
import { network } from "./lib/network.mjs";
import { payAndVerify } from "./lib/pay.mjs";

const [title, brief] = process.argv.slice(2);
if (!title || !brief) {
  console.error('usage: node org.mjs "<title>" "<brief>"');
  process.exit(64);
}
const server = process.env.SERVER_URL ?? "http://127.0.0.1:4021";

try {
  const { body, settlement, received, link } = await payAndVerify({
    payer: process.env.ORG_ACCOUNT ?? "acme.agency.testnet",
    url: `${server}/engagements`,
    init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, brief }) },
    payTo: network.treasury,
    amount: BigInt(process.env.ENGAGEMENT_DEPOSIT ?? "3000000"),
  });
  console.log(`deposit: ${received} atomic USDC from ${settlement.payer} to the treasury`);
  console.log(`deposit tx: ${link}`);
  const engagement = await fetch(`${server}${body.status_url}`).then(r => r.json());
  if (engagement.status !== "open") throw new Error(`engagement not opened: ${JSON.stringify(engagement)}`);
  console.log(`engagement ${engagement.code}: ${engagement.issue_url}`);
} catch (error) {
  console.error(`org: ${error.message}`);
  process.exit(1);
}
