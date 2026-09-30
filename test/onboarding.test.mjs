import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { bytesToBase64, fromBase58, privateKeyFromRandom, signNep413Message, toBase58 } from "@fastnear/utils";

import { RECIPIENT, canonicalNonce, checkJoinRequest, implicitlyBound, joinFields, joinIssue, joinMessage, joinRequest, newNonce } from "../lib/onboarding.mjs";

const issued = new Date("2026-09-28T12:00:00Z");
const fields = { github: "new-agent", near: "new-agent.testnet", name: "New agent", kind: "agent", skills: ["research", "writing"], operator: "someone" };

function signed(overrides = {}, key = privateKeyFromRandom(), callbackUrl = undefined) {
  const message = overrides.message ?? joinMessage(fields, issued);
  const nonce = newNonce();
  const { publicKey, signature } = signNep413Message({ message, nonce: Buffer.from(nonce, "base64"), recipient: RECIPIENT, callbackUrl }, key);
  return { message, nonce, recipient: RECIPIENT, accountId: fields.near, publicKey, signature: bytesToBase64(signature), ...overrides };
}

const at = { author: "new-agent", now: new Date("2026-09-28T12:10:00Z") };

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
    assert.match(checkJoinRequest(signed(), { ...at, now: new Date("2026-09-28T12:45:00Z") }).refusal, /more than 30 minutes/);
    assert.match(checkJoinRequest(signed(), { ...at, now: new Date("2026-09-28T11:55:00Z") }).refusal, /in the future/);
  });

  test("validates the fields it signs", () => {
    assert.match(joinFields({ ...fields, skills: ["juggling"] }).error, /skills must be some of/);
    assert.match(joinFields({ ...fields, kind: "robot" }).error, /kind must be one of/);
    assert.match(joinFields({ ...fields, name: "two\nlines" }).error, /name/);
    assert.match(joinFields({ ...fields, near: "Not An Account" }).error, /NEAR account/);
    assert.match(joinFields({ ...fields, operator: undefined }).error, /operator/);
    assert.equal(joinFields({ ...fields, kind: "human" }).fields.operator, undefined);
  });

  test("signs Nearly's claim envelope", () => {
    const claim = JSON.parse(joinMessage(fields, issued));
    assert.deepEqual(Object.keys(claim).slice(0, 5), ["action", "domain", "account_id", "version", "timestamp"]);
    assert.equal(claim.action, "join_roster");
    assert.equal(claim.domain, RECIPIENT);
    assert.equal(claim.timestamp, issued.getTime());
  });

  test("a nonce has one spelling, so a reused one cannot be disguised", () => {
    const nonce = newNonce();
    assert.equal(canonicalNonce(nonce), nonce);
    assert.equal(canonicalNonce(nonce.replace(/=$/, "")), null);
    assert.equal(canonicalNonce(Buffer.alloc(16).toString("base64")), null);
    assert.match(checkJoinRequest(signed({ nonce: nonce.replace(/=$/, "") }), at).refusal, /canonical/);
  });

  test("an implicit account is bound by construction to its own key only", () => {
    const hexOf = key => Buffer.from(fromBase58(key.slice(8))).toString("hex");
    const { publicKey } = signed();
    assert.equal(implicitlyBound(hexOf(publicKey), publicKey), true);
    assert.equal(implicitlyBound(hexOf(signed().publicKey), publicKey), false);
    assert.equal(implicitlyBound("new-agent.testnet", publicKey), false);
  });
});

describe("wallets and callbackUrl", () => {
  const page = "https://demo.multiagency.ai/#/join";
  const refusal = request => checkJoinRequest(request, at).refusal;

  test("accepts wallets that sign over the page's callbackUrl (Meteor) and wallets that ignore it", () => {
    assert.equal(refusal({ ...signed({}, undefined, page), callbackUrl: page }), undefined);
    assert.equal(refusal({ ...signed(), callbackUrl: page }), undefined);
  });

  test("refuses a signature over a callbackUrl it is not told, or told wrongly", () => {
    assert.match(refusal(signed({}, undefined, page)), /does not match/);
    assert.match(refusal({ ...signed({}, undefined, page), callbackUrl: "https://demo.multiagency.ai/#/status/x" }), /does not match/);
  });

  test("a null callbackUrl means none, as in a signing response passed along whole", () => {
    assert.equal(refusal({ ...signed(), callbackUrl: null }), undefined);
    assert.match(refusal({ ...signed(), callbackUrl: 42 }), /callbackUrl is not a string/);
  });

  test("reads the formats wallets return: prefixed base58, and secp256k1's 65 bytes", () => {
    const request = signed();
    assert.equal(refusal({ ...request, signature: `ed25519:${toBase58(Buffer.from(request.signature, "base64"))}` }), undefined);
    assert.equal(refusal(signed({}, privateKeyFromRandom("secp256k1"))), undefined);
  });

  test("names a missing public key instead of blaming the signature", () => {
    assert.match(refusal({ ...signed(), publicKey: undefined }), /no public key/);
  });
});
