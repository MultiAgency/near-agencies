// A NEAR account brief from the FastNear API, served by the paid GET /brief
// route. Kept apart from x402-intake so it can be tested without the
// facilitator checkout.
import { isAccountId } from "./near.mjs";
import { network } from "./network.mjs";

// A hung FastNear request fails after FASTNEAR_TIMEOUT_MS instead of holding a
// paid request open.
const TIMEOUT_MS = Number(process.env.FASTNEAR_TIMEOUT_MS ?? "30000");

/** The status and JSON body for a brief of `account`. Never throws. */
export async function accountBrief(account) {
  if (!isAccountId(account)) {
    return { status: 400, body: { error: "account query parameter must be a NEAR account ID" } };
  }
  const source = `${network.fastnearApi}/v1/account/${account}/full`;
  let upstream;
  try {
    upstream = await fetch(source, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError";
    return {
      status: timedOut ? 504 : 502,
      body: { error: timedOut ? `FastNear API timed out after ${TIMEOUT_MS} ms` : "FastNear API is unreachable" },
    };
  }
  if (!upstream.ok) return { status: 502, body: { error: `FastNear API returned ${upstream.status}` } };
  let full;
  try {
    full = await upstream.json();
  } catch {
    return { status: 502, body: { error: "FastNear API returned an unreadable response" } };
  }
  return {
    status: 200,
    body: {
      account_id: full.account_id,
      state: full.state,
      tokens: (full.tokens ?? [])
        .filter(token => token.balance && token.balance !== "0")
        .map(({ contract_id, balance }) => ({ contract_id, balance })),
      staking_pools: (full.pools ?? []).map(pool => pool.pool_id),
      source,
    },
  };
}
