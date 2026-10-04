import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { fenced } from "../lib/github.mjs";
import { createEpic } from "../lib/epic.mjs";

process.env.GITHUB_TOKEN ??= "test-token";

describe("the job's ```engagement block", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const deposit = { org: "acme.testnet", amount: "3000000", transaction: "tx" };

  // createEpic's one write: the epic issue it opens on the board.
  const epicBody = async record => {
    let body;
    globalThis.fetch = async (url, options = {}) => {
      body = JSON.parse(options.body).body;
      return new Response(JSON.stringify({ number: 28, html_url: "https://github.com/MultiAgency/kanban-sandbox/issues/28" }),
        { headers: { "content-type": "application/json" } });
    };
    await createEpic(record);
    return body;
  };

  test("carries the repository the job named", async () => {
    const engagement = fenced(await epicBody({ code: "ma-1", channel: "wallet", repo: "MultiAgency/legion-social", deposit }), "engagement");
    assert.equal(engagement.repo, "MultiAgency/legion-social");
  });

  test("names no repository when the job named none, as every job was before", async () => {
    const engagement = fenced(await epicBody({ code: "ma-1", channel: "wallet", deposit }), "engagement");
    assert.equal(engagement.repo, undefined);
  });
});
