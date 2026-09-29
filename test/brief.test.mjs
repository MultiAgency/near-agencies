import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

process.env.FASTNEAR_TIMEOUT_MS = "50";
const { accountBrief } = await import("../lib/brief.mjs");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Never answers: settles only when its signal aborts, and keeps the event loop
// alive while it waits, like a real open socket.
const hang = (url, { signal }) => new Promise((_, reject) => {
  const socket = setInterval(() => {}, 1000);
  signal.addEventListener("abort", () => {
    clearInterval(socket);
    reject(signal.reason);
  });
});

const answer = (body, init) => async () => new Response(JSON.stringify(body), init);

describe("account brief", () => {
  test("rejects anything that is not a NEAR account ID, without calling upstream", async () => {
    globalThis.fetch = () => assert.fail("upstream must not be called");
    for (const bad of ["", "..", ".a", "a.", "a..b", "a--b", "Alice.near", "a/b", "a?b=1", "x", "a".repeat(65)]) {
      const { status } = await accountBrief(bad);
      assert.equal(status, 400, JSON.stringify(bad));
    }
  });

  test("a FastNear request that never answers becomes a 504", async () => {
    globalThis.fetch = hang;
    const { status, body } = await accountBrief("alice.near");
    assert.equal(status, 504);
    assert.match(body.error, /timed out after 50 ms/);
  });

  test("an unreachable FastNear becomes a 502", async () => {
    globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
    const { status } = await accountBrief("alice.near");
    assert.equal(status, 502);
  });

  test("a FastNear error status and an unreadable body are both 502", async () => {
    globalThis.fetch = answer({}, { status: 500 });
    assert.equal((await accountBrief("alice.near")).status, 502);
    globalThis.fetch = async () => new Response("<html>", { status: 200 });
    assert.equal((await accountBrief("alice.near")).status, 502);
  });

  test("shapes the brief: zero balances dropped, pools listed, source named", async () => {
    let requested;
    globalThis.fetch = async url => {
      requested = String(url);
      return answer({
        account_id: "alice.near",
        state: { balance: "1" },
        tokens: [{ contract_id: "usdc.near", balance: "5", extra: 1 }, { contract_id: "dust.near", balance: "0" }],
        pools: [{ pool_id: "pool.near" }],
      })();
    };
    const { status, body } = await accountBrief("alice.near");
    assert.equal(status, 200);
    assert.match(requested, /\/v1\/account\/alice\.near\/full$/);
    assert.deepEqual(body.tokens, [{ contract_id: "usdc.near", balance: "5" }]);
    assert.deepEqual(body.staking_pools, ["pool.near"]);
    assert.equal(body.source, requested);
  });
});
