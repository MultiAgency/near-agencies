import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { chosenDeposit, createQuote, invalidBrief, payerProblems } from "../lib/engagements.mjs";

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

describe("the repository a job names", () => {
  const brief = { title: "A one-page guide", brief: "Write the guide, with sources." };

  test("a registry repository is taken; none named means the default", () => {
    assert.equal(invalidBrief(brief), null);
    assert.equal(invalidBrief({ ...brief, repo: "" }), null);
    assert.equal(invalidBrief({ ...brief, repo: null }), null);
    assert.equal(invalidBrief({ ...brief, repo: "MultiAgency/near-agencies" }), null);
  });

  test("any other value refuses the quote with the reason", () => {
    assert.match(invalidBrief({ ...brief, repo: "octocat/hello-world" }), /repo must be a repository code tasks deliver against/);
    assert.match(invalidBrief({ ...brief, repo: "multiagency/legion-social" }), /repo must be/, "the registry's names are exact");
    assert.match(invalidBrief({ ...brief, repo: 5 }), /repo must be/);
    assert.match(invalidBrief({ ...brief, repo: ["MultiAgency/legion-social"] }), /repo must be/, "an array is not a name");
    // legion-social is on the registry, but no worker delivers there until #82:
    // a job naming it would take a deposit for code tasks that hold at payout.
    assert.match(invalidBrief({ ...brief, repo: "MultiAgency/legion-social" }), /workers do not deliver to MultiAgency\/legion-social yet/);
  });
});

describe("the quote record", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("carries the repository the brief named, and none when it did not", async () => {
    // createQuote reads the final block height over RPC; nothing else goes online.
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { header: { height: 100 } } }), { headers: { "content-type": "application/json" } });
    const named = await createQuote({
      title: "A one-page guide", brief: "Write the guide, with sources.", channel: "wallet", amount: "3000000", repo: "MultiAgency/legion-social",
    });
    assert.equal(named.repo, "MultiAgency/legion-social");
    const plain = await createQuote({
      title: "A one-page guide", brief: "Write the guide, with sources.", channel: "wallet", amount: "3000000",
    });
    assert.equal(plain.repo, undefined, "with no repo, records read as they always did");
  });
});
