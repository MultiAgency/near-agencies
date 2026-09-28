import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { bytesToBase64, privateKeyFromRandom, signNep413Message } from "@fastnear/utils";

import { RECIPIENT, checkJoinRequest, joinFields, joinIssue, joinMessage, joinRequest, newNonce } from "../lib/onboarding.mjs";

const issued = new Date("2026-09-28T12:00:00Z");
const fields = { github: "new-agent", near: "new-agent.testnet", name: "New agent", kind: "agent", skills: ["research", "writing"], operator: "someone" };

function signed(overrides = {}, key = privateKeyFromRandom()) {
  const message = overrides.message ?? joinMessage(fields, issued);
  const nonce = newNonce();
  const { publicKey, signature } = signNep413Message({ message, nonce: Buffer.from(nonce, "base64"), recipient: RECIPIENT }, key);
  return { message, nonce, recipient: RECIPIENT, accountId: fields.near, publicKey, signature: bytesToBase64(signature), ...overrides };
}

const at = { author: "new-agent", now: new Date("2026-09-28T13:00:00Z") };

describe("join requests", () => {
  test("a signed request posted by its GitHub login becomes a roster record", () => {
    assert.deepEqual(checkJoinRequest(signed(), at).builder, {
      nearAccount: "new-agent.testnet",
      name: "New agent",
      skills: ["research", "writing"],
      links: { github: "https://github.com/new-agent" },
      kind: "agent",
      operator: "someone",
    });
  });

  test("survives the trip through the board issue", () => {
    assert.ok(checkJoinRequest(joinRequest(joinIssue(signed()).body), at).builder);
  });

  test("refuses a request posted by someone else", () => {
    assert.match(checkJoinRequest(signed(), { ...at, author: "impostor" }).refusal, /posted by @impostor/);
  });

  test("refuses an altered message, another account, or another recipient", () => {
    const request = signed();
    const altered = { ...request, message: request.message.replace("new-agent.testnet", "thief.testnet"), accountId: "thief.testnet" };
    assert.match(checkJoinRequest(altered, at).refusal, /signature does not match/);
    assert.match(checkJoinRequest({ ...request, accountId: "other.testnet" }, at).refusal, /signed by other.testnet/);
    assert.match(checkJoinRequest({ ...request, recipient: "elsewhere" }, at).refusal, /addressed to elsewhere/);
  });

  test("refuses a stale request", () => {
    assert.match(checkJoinRequest(signed(), { ...at, now: new Date("2026-10-15T00:00:00Z") }).refusal, /expired/);
  });

  test("validates the fields it signs", () => {
    assert.match(joinFields({ ...fields, skills: ["juggling"] }).error, /skills must be some of/);
    assert.match(joinFields({ ...fields, kind: "robot" }).error, /kind must be one of/);
    assert.match(joinFields({ ...fields, name: "two\nlines" }).error, /name/);
    assert.match(joinFields({ ...fields, near: "Not An Account" }).error, /NEAR account/);
    assert.match(joinFields({ ...fields, operator: undefined }).error, /operator/);
    assert.equal(joinFields({ ...fields, kind: "human" }).fields.operator, undefined);
  });
});
