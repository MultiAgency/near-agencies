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

// The bot and an owner may open an epic; anyone else's issue is not one.
const trusted = async login => ["multi-agency", "jlwaugh"].includes(login);

const memoryStore = records => ({
  all: async () => records,
  update: async mutate => mutate(records),
});

const epicFor = (code, number, extra = {}) => ({
  number,
  html_url: `https://github.com/x/y/issues/${number}`,
  body: `Job\n\n${fence("engagement", { engagement_id: code })}`,
  user: { login: "multi-agency" },
  ...extra,
});

describe("recovering stuck engagements", () => {
  const run = (records, deps) => recoverStuck({ store: memoryStore(records), now: NOW, trusted, ...deps });

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
    await recoverStuck({ store, now: NOW - 6 * 60_000, trusted, listEpics: async () => { throw new Error("502"); }, create: async () => assert.fail() });
    // failed_at is the real failure time, so the retry tick is ten minutes after it.
    await recoverStuck({ store, now: Date.now() + 10 * 60_000, trusted, listEpics, create: async () => assert.fail("created a duplicate epic") });
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

  test("an issue someone else opened with the code is ignored, and the epic is created", async () => {
    // The code is the deposit memo, public on chain, so anyone who can label an issue can copy it.
    const records = { "ma-5": record("ma-5", { status: "opening", opening_at: minutesAgo(10) }) };
    const recovered = await run(records, {
      listEpics: async () => [epicFor("ma-5", 4, { user: { login: "someone-else" } })],
      create: async () => epicFor("ma-5", 6),
    });
    assert.deepEqual(recovered, [{ code: "ma-5", issue: 6, created: true }]);
  });

  test("an epic an owner opened by hand is reused", async () => {
    const records = { "ma-6": record("ma-6", { status: "deposit_settled_epic_failed", failed_at: minutesAgo(10) }) };
    const recovered = await run(records, {
      listEpics: async () => [epicFor("ma-6", 8, { user: { login: "jlwaugh" } })],
      create: async () => assert.fail("must not duplicate the owner's epic"),
    });
    assert.deepEqual(recovered, [{ code: "ma-6", issue: 8, created: false }]);
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
      assert.equal(records["ma-6"].attempts, 1);
      assert.ok(Date.now() - Date.parse(records["ma-6"].failed_at) < 5_000, "failed_at is when it failed");
      assert.equal(records["ma-6"].brief, "What the organization wants done.");
      // The next tick finds it freshly failed and leaves it for later.
      await run(records, { listEpics: async () => assert.fail("too soon"), create: async () => assert.fail("too soon") });
    } finally {
      console.error = real;
    }
  });

  test("a failure that never clears is retried a limited number of times, then left for a person", async () => {
    const { MAX_RECOVERY_ATTEMPTS, engagementHealth } = await import("../lib/stuck.mjs");
    const records = { "ma-7": record("ma-7", { status: "opening", opening_at: minutesAgo(10) }) };
    const real = console.error;
    console.error = () => {};
    let creates = 0;
    const deps = { listEpics: async () => [], create: async () => { creates++; throw new Error("GitHub POST /issues: 422"); } };
    try {
      for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS + 3; attempt++) {
        // Each tick is ten minutes later, so the previous failure is old enough to retry.
        await recoverStuck({ store: memoryStore(records), now: Date.now() + attempt * 10 * 60_000, trusted, ...deps });
      }
    } finally {
      console.error = real;
    }
    assert.equal(creates, MAX_RECOVERY_ATTEMPTS, "no attempt past the limit");
    assert.equal(records["ma-7"].status, "deposit_settled_epic_failed");
    assert.equal(records["ma-7"].attempts, MAX_RECOVERY_ATTEMPTS);
    // It stays visible to an operator, marked as given up.
    const later = Date.now() + 24 * 60 * 60_000;
    assert.deepEqual(engagementHealth(records, later).stuck.map(r => [r.code, r.gave_up]), [["ma-7", true]]);
  });

  test("a record that succeeds before the limit is opened", async () => {
    const records = { "ma-8": record("ma-8", { status: "deposit_settled_epic_failed", attempts: 2, failed_at: minutesAgo(10) }) };
    await run(records, { listEpics: async () => [], create: async () => epicFor("ma-8", 12) });
    assert.equal(records["ma-8"].status, "open");
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

  test("throws rather than dropping epics when there are more pages than it reads", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ number: i }))));
    await assert.rejects(() => epicIssues("2026-09-30T11:00:00.000Z"), /more than 2000 engagement epics/);
  });
});
