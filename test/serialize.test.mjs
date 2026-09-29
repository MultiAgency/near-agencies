import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

process.env.TX_API_TIMEOUT_MS = "50";
const { serialized } = await import("../lib/serialize.mjs");
const { findDeposit, txBlockHeight } = await import("../lib/history.mjs");

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

describe("serialized background tasks", () => {
  test("a run that starts while the previous one is going is skipped", async () => {
    let started = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const task = serialized(async () => { started++; await gate; return "done"; });

    const first = task();
    assert.equal(await task(), undefined);
    assert.equal(await task(), undefined);
    assert.equal(started, 1);

    release();
    assert.equal(await first, "done");
    assert.equal(await task(), "done");
    assert.equal(started, 2);
  });

  test("a failed run rejects to its caller and does not block later runs", async () => {
    let calls = 0;
    const task = serialized(async () => {
      if (++calls === 1) throw new Error("boom");
      return "ok";
    });
    await assert.rejects(task(), /boom/);
    assert.equal(await task(), "ok");
  });

  test("passes its arguments through", async () => {
    assert.equal(await serialized(async (a, b) => a + b)(2, 3), 5);
  });
});

describe("Transactions API timeout", () => {
  test("a request that never answers fails after the timeout", async () => {
    globalThis.fetch = hang;
    await assert.rejects(txBlockHeight("abc"), /timeout|aborted/i);
    await assert.rejects(findDeposit("ma-0000000000", 1), /timeout|aborted/i);
  });
});
