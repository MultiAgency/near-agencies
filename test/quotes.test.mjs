import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { payerProblems } from "../lib/engagements.mjs";

const NEAR = 10n ** 24n;
const deposit = "3000000";

describe("payer check", () => {
  test("an account with the USDC and NEAR for gas can pay", () => {
    assert.deepEqual(payerProblems({ exists: true, available: NEAR / 10n, usdc: 3_000_000n }, deposit), []);
  });

  test("names every shortfall", () => {
    assert.deepEqual(payerProblems({ exists: true, available: 0n, usdc: 0n }, deposit), [
      "it needs at least 0.05 NEAR for gas and has 0 NEAR available",
      "it needs 3 USDC and holds 0 USDC",
    ]);
  });

  test("an unknown account has nothing else to check", () => {
    assert.deepEqual(payerProblems({ exists: false }, deposit), ["the account does not exist on testnet"]);
  });
});

test("publicQuote does not return the stored error text", async () => {
  const { publicQuote } = await import("../lib/engagements.mjs");
  const quote = publicQuote({ code: "c", title: "t", amount: "1", channel: "x", status: "deposit_settled_epic_failed", expires_at: "", error: "GitHub 401: Bad credentials ghp_secret" });
  assert.ok(!JSON.stringify(quote).includes("Bad credentials"));
  assert.equal(publicQuote({ code: "c", status: "open", error: "x" }).error, undefined);
});
