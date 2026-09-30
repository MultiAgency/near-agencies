import assert from "node:assert/strict";
import { test } from "node:test";

import { cached } from "../lib/cache.mjs";

test("concurrent misses for one key share a single load", async () => {
  let calls = 0;
  const get = cached(1000, async n => { calls++; await new Promise(r => setTimeout(r, 10)); return n * 2; });
  assert.deepEqual(await Promise.all([get(1), get(1), get(1)]), [2, 2, 2]);
  assert.equal(calls, 1);
});

test("a failed load is not cached or left in flight", async () => {
  let calls = 0;
  const get = cached(1000, async () => { if (++calls === 1) throw new Error("boom"); return "ok"; });
  await assert.rejects(get(), /boom/);
  assert.equal(await get(), "ok");
});

test("expired entries are reloaded and dropped", async () => {
  let calls = 0;
  const get = cached(5, async () => ++calls);
  assert.equal(await get(), 1);
  assert.equal(await get(), 1);
  await new Promise(r => setTimeout(r, 15));
  assert.equal(await get(), 2);
});

test("the cache never holds more than max entries", async () => {
  let calls = 0;
  const get = cached(60_000, async n => { calls++; return n; }, { max: 3 });
  for (let i = 0; i < 10; i++) await get(i);
  calls = 0;
  await get(9);
  assert.equal(calls, 0, "recent entry kept");
  await get(0);
  assert.equal(calls, 1, "oldest entry evicted");
});
