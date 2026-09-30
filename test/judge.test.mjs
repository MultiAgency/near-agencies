import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

process.env.TYPESAFE_API_KEY = "test-key";
const { judgeHealth, shadowJudge } = await import("../lib/judge.mjs");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const say = (id, body, updated_at = "2026-09-30T20:00:00Z") =>
  ({ id, body, updated_at, html_url: `https://github.com/MultiAgency/kanban-sandbox/issues/31#issuecomment-${id}` });
function jev(choice, confidence = 0.97) {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ answers: { intent: { type: "choice", choice, confidence, probabilities: {} } } }));
  };
  return requests;
}

describe("judging reviewer comments in shadow", () => {
  test("asks the pinned model about the comment, and keeps a disagreement with the regex", async () => {
    const requests = jev("change_request");
    await shadowJudge(say(1, "Requesting changes: section 2 cites a blog post."), false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(requests[0].body.model, "jev-1.13.0");
    assert.equal(requests[0].body.state.comment, "Requesting changes: section 2 cites a blog post.");
    const health = judgeHealth();
    assert.equal(health.disagreements, 1);
    assert.deepEqual({ ...health.recent[0], at: undefined }, { url: say(1).html_url, jev: "change_request", confidence: 0.97, regex: false, at: undefined });
  });

  test("an agreement is counted but not kept", async () => {
    jev("sign_off");
    const before = judgeHealth();
    await shadowJudge(say(2, "Approved. Great work on the sources."), false);
    assert.equal(judgeHealth().judged, before.judged + 1);
    assert.equal(judgeHealth().disagreements, before.disagreements);
  });

  test("each version of a comment is judged once; an edit is judged again", async () => {
    const requests = jev("change_request");
    const comment = say(3, "Changes requested before acceptance: fix step 4.");
    await shadowJudge(comment, true);
    await shadowJudge(comment, true);
    assert.equal(requests.length, 1);
    await shadowJudge({ ...comment, body: "Changes requested: fix step 4 and section 2.", updated_at: "2026-09-30T21:00:00Z" }, true);
    assert.equal(requests.length, 2);
  });

  test("a failed call is counted, never thrown, and not retried every cycle", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return new Response("rate limited", { status: 429 }); };
    const before = judgeHealth().errors;
    await shadowJudge(say(4, "LGTM"), false);
    await shadowJudge(say(4, "LGTM"), false);
    assert.equal(calls, 1);
    assert.equal(judgeHealth().errors, before + 1);
  });
});
