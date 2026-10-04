import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { chosenDeposit, payerProblems } from "../lib/engagements.mjs";

const NEAR = 10n ** 24n;
const deposit = "3000000";
// The range a server that lets buyers choose configures: 1-10 USDC.
const range = { deposit, depositMin: "1000000", depositMax: "10000000" };

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

test("publicQuote says when recovery gave up, so the page stops saying the job is being opened", async () => {
  const { publicQuote } = await import("../lib/engagements.mjs");
  const base = { code: "c", title: "t", amount: "1", channel: "x", status: "deposit_settled_epic_failed", expires_at: "" };
  assert.equal(publicQuote({ ...base, attempts: 1 }).gave_up, undefined);
  assert.equal(publicQuote({ ...base, attempts: 99 }).gave_up, true);
});

describe("the buyer's chosen deposit", () => {
  const brief = { title: "A one-page guide", brief: "Write the guide, with sources." };

  test("with no amount named, the server's default is the deposit", () => {
    assert.deepEqual(chosenDeposit(brief, range), { amount: "3000000" });
    assert.deepEqual(chosenDeposit({ ...brief, amount: "" }, range), { amount: "3000000" });
    const locked = { deposit, depositMin: deposit, depositMax: deposit };
    assert.deepEqual(chosenDeposit({ ...brief, amount: "5000000" }, locked), { problem: "the deposit must be at most 3 USDC" },
      "a server that configures no range takes only its default");
  });

  test("a choice within the server's range is taken, in base units", () => {
    assert.deepEqual(chosenDeposit({ ...brief, amount: "5000000" }, range), { amount: "5000000" });
    assert.deepEqual(chosenDeposit({ ...brief, amount: 5000000 }, range), { amount: "5000000" }, "a JSON number is a choice too");
    assert.deepEqual(chosenDeposit({ ...brief, amount: "1000000" }, range), { amount: "1000000" });
    assert.deepEqual(chosenDeposit({ ...brief, amount: "10000000" }, range), { amount: "10000000" });
  });

  test("a choice outside the range, or not a whole number of base units, is refused with the reason", () => {
    assert.match(chosenDeposit({ ...brief, amount: "999999" }, range).problem, /at least 1 USDC/);
    assert.match(chosenDeposit({ ...brief, amount: "10000001" }, range).problem, /at most 10 USDC/);
    assert.match(chosenDeposit({ ...brief, amount: "1.5" }, range).problem, /whole number/);
    assert.match(chosenDeposit({ ...brief, amount: "-1" }, range).problem, /whole number/);
    assert.match(chosenDeposit({ ...brief, amount: "five" }, range).problem, /whole number/);
  });

  test("the payer check reads the chosen amount off the quote", () => {
    assert.deepEqual(payerProblems({ exists: true, available: NEAR / 10n, usdc: 5_000_000n }, "5000000"), []);
    assert.deepEqual(payerProblems({ exists: true, available: NEAR / 10n, usdc: 3_000_000n }, "5000000"), [
      "it needs 5 USDC and holds 3 USDC",
    ]);
  });
});
