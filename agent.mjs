// Paying agent: buys a NEAR account brief for 1000 atomic USDC.
import { network } from "./lib/network.mjs";
import { payAndVerify } from "./lib/pay.mjs";

const payer = process.env.PAYER_ACCOUNT ?? "agency.testnet";

const indexed = await fetch(`${network.fastnearApi}/v1/account/${payer}/ft`).then(r => r.json());
const indexedBalance = indexed.tokens?.find(token => token.contract_id === network.usdc)?.balance;
console.log(`payer ${payer}: ${indexedBalance ?? "untracked"} atomic USDC per FastNear API`);

try {
  const { body, settlement, received, link } = await payAndVerify({
    payer,
    url: process.env.RESOURCE_URL ?? `http://127.0.0.1:4021/brief?account=${payer}`,
    payTo: process.env.PAY_TO,
    amount: BigInt(process.env.AMOUNT ?? "1000"),
  });
  console.log("resource:", JSON.stringify(body, null, 2));
  console.log("settlement:", JSON.stringify(settlement));
  console.log(`${process.env.PAY_TO} received ${received} atomic USDC`);
  console.log(link);
} catch (error) {
  console.error(`agent: ${error.message}`);
  process.exit(1);
}
