import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

process.env.GITHUB_TOKEN = "test-token";
const { epicIssues, fence } = await import("../lib/github.mjs");
const { recoverStuck } = await import("../lib/recover.mjs");

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const minutesAgo = minutes => new Date(NOW - minutes * 60_000).toISOString();

const record = (code, fields) => ({
  code,
  title: "A job",
  brief: "What the organization wants done.",
  channel: "wallet",
  amount: "3000000",
  created_at: minutesAgo(60),
  deposit: { org: "org.testnet", amount: "3000000", transaction: "tx" },
  ...fields,
});

const memoryStore = records => ({
  all: async () => records,
  update: async mutate => mutate(records),
});

const epicFor = (code, number, extra = {}) => ({
  number,
  html_url: `https://github.com/x/y/issues/${number}`,
  body: `Job\n\n${fence("engagement", { engagement_id: code })}`,
  ...extra,
});

describe("recovering stuck engagements", () => {
  const run = (records, deps) => recoverStuck({ store: memoryStore(records), now: NOW, ...deps });

  test("an epic the first attempt already created is found, not duplicated", async () => {
    const records = { "ma-1": record("ma-1", { status: "opening", opening_at: minutesAgo(10) }) };
    let listedSince;
    const recovered = await run(records, {
      listEpics: async since => { listedSince = since; return [epicFor("ma-1", 7)]; },
      create: async () => assert.fail("must not create a second epic"),
    });
    assert.deepEqual(recovered, [{ code: "ma-1", issue: 7, created: false }]);
    assert.equal(records["ma-1"].status, "open");
    assert.equal(records["ma-1"].issue, 7);
    assert.equal(records["ma-1"].brief, undefined);
    // The lookup starts a minute before the quote was created, which no epic can predate.
    assert.equal(listedSince, minutesAgo(61));
  });

  test("a second recovery after a failed lookup finds the original epic", async () => {
    // The first attempt claimed at NOW-12, created epic #7, then died.
    const records = { "ma-1": record("ma-1", { status: "opening", opening_at: minutesAgo(12) }) };
    const epic = epicFor("ma-1", 7, { updated_at: minutesAgo(12) });
    const listEpics = async since => [epic].filter(i => i.updated_at >= since);
    const store = memoryStore(records);
    await recoverStuck({ store, now: NOW - 6 * 60_000, listEpics: async () => { throw new Error("502"); }, create: async () => assert.fail() });
    await recoverStuck({ store, now: NOW, listEpics, create: async () => assert.fail("created a duplicate epic") });
    assert.equal(records["ma-1"].issue, 7);
  });

  test("with no epic on the board it creates exactly one", async () => {
    const records = { "ma-2": record("ma-2", { status: "opening", opening_at: minutesAgo(10) }) };
    let created = 0;
    const recovered = await run(records, {
      listEpics: async () => [epicFor("ma-other", 3)],
      create: async r => { created++; assert.equal(r.code, "ma-2"); return epicFor("ma-2", 9); },
    });
    assert.equal(created, 1);
    assert.deepEqual(recovered, [{ code: "ma-2", issue: 9, created: true }]);
    assert.equal(records["ma-2"].status, "open");
  });

  test("a pull request that quotes the code is not an epic", async () => {
    const records = { "ma-3": record("ma-3", { status: "opening", opening_at: minutesAgo(10) }) };
    await run(records, {
      listEpics: async () => [epicFor("ma-3", 4, { pull_request: {} })],
      create: async () => epicFor("ma-3", 5),
    });
    assert.equal(records["ma-3"].issue, 5);
  });

  test("a record opened a moment ago is left alone", async () => {
    const records = { "ma-4": record("ma-4", { status: "opening", opening_at: minutesAgo(1) }) };
    const recovered = await run(records, {
      listEpics: async () => assert.fail("nothing is stuck"),
      create: async () => assert.fail("nothing is stuck"),
    });
    assert.deepEqual(recovered, []);
    assert.equal(records["ma-4"].status, "opening");
  });

  test("a failed epic creation is retried the same way", async () => {
    const records = {
      "ma-5": record("ma-5", { status: "deposit_settled_epic_failed", opening_at: minutesAgo(60), failed_at: minutesAgo(30), error: "GitHub POST /issues: 502" }),
    };
    await run(records, { listEpics: async () => [], create: async () => epicFor("ma-5", 11) });
    assert.equal(records["ma-5"].status, "open");
    assert.equal(records["ma-5"].error, undefined);
  });

  test("a failed recovery keeps the record failed, and waits before trying again", async () => {
    const records = { "ma-6": record("ma-6", { status: "opening", opening_at: minutesAgo(10) }) };
    const real = console.error;
    console.error = () => {};
    try {
      await run(records, { listEpics: async () => [], create: async () => { throw new Error("GitHub POST /issues: 403"); } });
      assert.equal(records["ma-6"].status, "deposit_settled_epic_failed");
      assert.match(records["ma-6"].error, /403/);
      assert.equal(records["ma-6"].failed_at, new Date(NOW).toISOString());
      assert.equal(records["ma-6"].brief, "What the organization wants done.");
      // The next tick finds it freshly failed and leaves it for later.
      await run(records, { listEpics: async () => assert.fail("too soon"), create: async () => assert.fail("too soon") });
    } finally {
      console.error = real;
    }
  });
});

describe("listing epics", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("asks for engagement issues of any state since a time, and reads every page", async () => {
    const urls = [];
    globalThis.fetch = async url => {
      urls.push(String(url));
      const page = Number(new URL(url).searchParams.get("page"));
      const items = page === 1 ? Array.from({ length: 100 }, (_, i) => ({ number: i + 1 })) : [{ number: 101 }];
      return new Response(JSON.stringify(items));
    };
    const issues = await epicIssues("2026-09-30T11:00:00.000Z");
    assert.equal(issues.length, 101);
    assert.equal(urls.length, 2);
    const first = new URL(urls[0]);
    assert.equal(first.searchParams.get("labels"), "engagement");
    assert.equal(first.searchParams.get("state"), "all");
    assert.equal(first.searchParams.get("since"), "2026-09-30T11:00:00.000Z");
  });
});
