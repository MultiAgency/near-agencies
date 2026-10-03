import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

process.env.GITHUB_TOKEN = "test-token";
const { comments } = await import("../lib/github.mjs");

describe("reading comments", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("follows pagination across a thread longer than one page", async () => {
    const urls = [];
    globalThis.fetch = async url => {
      urls.push(String(url));
      const page = Number(new URL(url).searchParams.get("page"));
      const body = page === 1
        ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }))
        : Array.from({ length: 50 }, (_, i) => ({ id: i + 101 }));
      return new Response(JSON.stringify(body));
    };
    const thread = await comments(11);
    assert.equal(thread.length, 150);
    assert.deepEqual(thread.map(c => c.id), Array.from({ length: 150 }, (_, i) => i + 1));
    assert.equal(urls.length, 2);
    const first = new URL(urls[0]);
    assert.equal(first.pathname, "/repos/MultiAgency/kanban-sandbox/issues/11/comments");
    assert.equal(first.searchParams.get("per_page"), "100");
    assert.equal(first.searchParams.get("page"), "1");
    assert.equal(new URL(urls[1]).searchParams.get("page"), "2");
  });

  test("throws rather than dropping comments when there are more pages than it reads", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i }))));
    await assert.rejects(() => comments(11), /more than 5000 comments on issue 11/);
  });
});
