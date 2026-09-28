import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_TIMEOUT_MS = "50";
const { coordinatorHealth, cycle } = await import("../lib/coordinator.mjs");
const { github } = await import("../lib/github.mjs");
const { withTimeout } = await import("../lib/near.mjs");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// A request GitHub never answers: settles only when its signal aborts. Like a
// real open socket, it keeps the event loop alive while it waits (the abort
// timer alone does not).
const hang = (url, { signal }) => new Promise((_, reject) => {
  const socket = setInterval(() => {}, 1000);
  signal.addEventListener("abort", () => {
    clearInterval(socket);
    reject(signal.reason);
  });
});

describe("hung requests", () => {
  test("a GitHub request that never answers fails after the timeout", async () => {
    globalThis.fetch = hang;
    await assert.rejects(github("GET", "/issues"), /timeout|aborted/i);
  });

  test("a NEAR read that never answers fails after the timeout", async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 50, "NEAR view x.y"), /NEAR view x\.y timed out after 50 ms/);
    assert.equal(await withTimeout(Promise.resolve(7), 50, "fast"), 7);
  });

  test("the coordinator recovers: a cycle stuck on GitHub ends, and the next one runs", async () => {
    globalThis.fetch = hang;
    assert.equal(await cycle(() => github("GET", "/issues")), true);
    assert.match(coordinatorHealth().last_error.message, /timeout|aborted/i);
    assert.equal(coordinatorHealth().running, false);
    const before = coordinatorHealth().cycles;
    assert.equal(await cycle(async () => {}), true);
    assert.equal(coordinatorHealth().cycles, before + 1);
    assert.ok(coordinatorHealth().last_completed_at);
  });

  test("only one cycle runs at a time", async () => {
    let release;
    const first = cycle(() => new Promise(resolve => { release = resolve; }));
    assert.equal(await cycle(async () => {}), false);
    release();
    assert.equal(await first, true);
  });
});
