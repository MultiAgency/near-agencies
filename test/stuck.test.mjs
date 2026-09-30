import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { engagementHealth, stuckRecords } = await import("../lib/stuck.mjs");

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const minutesAgo = minutes => new Date(NOW - minutes * 60_000).toISOString();

const record = (code, fields) => ({
  code,
  title: "A job",
  channel: "wallet",
  amount: "3000000",
  created_at: minutesAgo(60),
  ...fields,
});

describe("stuck engagements", () => {
  test("an opening record is stuck after five minutes, a failed one from when it failed", () => {
    const records = {
      fresh: record("fresh", { status: "opening", opening_at: minutesAgo(4) }),
      old: record("old", { status: "opening", opening_at: minutesAgo(6) }),
      failedNow: record("failedNow", { status: "deposit_settled_epic_failed", opening_at: minutesAgo(90), failed_at: minutesAgo(1) }),
      failedOld: record("failedOld", { status: "deposit_settled_epic_failed", opening_at: minutesAgo(90), failed_at: minutesAgo(30) }),
    };
    assert.deepEqual(stuckRecords(records, NOW).map(r => r.code).sort(), ["failedOld", "old"]);
  });

  test("records from before the timestamps fall back to when they were created", () => {
    const records = { legacy: record("legacy", { status: "opening" }) };
    assert.equal(stuckRecords(records, NOW).length, 1);
  });

  test("records that are open, awaiting a deposit, expired or underpaid are never stuck", () => {
    const records = Object.fromEntries(["open", "awaiting_deposit", "expired", "underpaid"].map(status => [status, record(status, { status })]));
    assert.deepEqual(stuckRecords(records, NOW), []);
  });

  test("the health report counts both states and names what is stuck", () => {
    const records = {
      a: record("a", { status: "opening", opening_at: minutesAgo(10) }),
      b: record("b", { status: "deposit_settled_epic_failed", failed_at: minutesAgo(1) }),
      c: record("c", { status: "open" }),
    };
    assert.deepEqual(engagementHealth(records, NOW), {
      opening: 1,
      epic_failed: 1,
      stuck: [{ code: "a", status: "opening", since: minutesAgo(10) }],
    });
  });
});
