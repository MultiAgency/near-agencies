// Joining the roster. A contributor signs a NEP-413 claim with their NEAR
// account naming their GitHub login, kind and skills, then posts it on the
// board from that GitHub account: the signature proves the payout account,
// the issue author proves the login. The coordinator verifies the request on
// the board; an owner adds it to roster.json with `node roster.mjs add`.
//
// The claim is a JSON message with action, domain, account_id, version and a
// millisecond timestamp, pinned to the recipient `multiagency` (the envelope
// is modelled on Nearly's verifiable claims). The key must be a full-access
// key of the account, as NEP-413 requires, except that an implicit account
// not yet on chain is bound by construction. Nonces are single-use against
// every join request ever posted on the board.
import { randomBytes } from "node:crypto";

import { fromBase58, verifyNep413Signature } from "@fastnear/utils";
import { rateLimit } from "express-rate-limit";

import { fence, fenced, repoUrl, searchIssues } from "./github.mjs";
import { call, isAccountId, isMissing, rpc, view } from "./near.mjs";
import { network } from "./network.mjs";

export const RECIPIENT = "multiagency";
export const SKILLS = ["research", "writing", "code", "review"];
export const KINDS = ["agent", "human"];
const ACTION = "join_roster";
const VERSION = 1;
// Long enough for a person to sign here, then submit the issue on GitHub.
const MAX_AGE_MS = 30 * 60_000;
const FUTURE_SKEW_MS = 60_000;
const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const TITLE = "Join the MultiAgency roster";

/** The fields a join request names, or a reason they are not acceptable. */
export function joinFields({ github, near, name, kind, skills, operator }) {
  if (!GITHUB_LOGIN.test(github ?? "")) return { error: "a GitHub login is required" };
  if (!isAccountId(near)) return { error: "a NEAR account id is required" };
  name = String(name ?? "").trim();
  if (!name || name.length > 80 || /[\r\n]/.test(name)) return { error: "a name of at most 80 characters is required" };
  if (!KINDS.includes(kind)) return { error: `kind must be one of ${KINDS.join(", ")}` };
  // Every agent names the person who answers for it.
  if (kind === "agent" && !GITHUB_LOGIN.test(operator ?? "")) return { error: "an agent must name its operator's GitHub login" };
  if (kind === "human") operator = undefined;
  if (!Array.isArray(skills) || skills.length === 0 || skills.some(s => !SKILLS.includes(s))) {
    return { error: `skills must be some of ${SKILLS.join(", ")}` };
  }
  return { fields: { github, near, name, kind, skills: [...new Set(skills)], ...(operator ? { operator } : {}) } };
}

/** What the wallet signs: the claim envelope, carrying exactly what the roster entry will say. */
export function joinMessage({ github, near, name, kind, skills, operator }, issued = new Date()) {
  return JSON.stringify({
    action: ACTION,
    domain: RECIPIENT,
    account_id: near,
    version: VERSION,
    timestamp: issued.getTime(),
    network: network.networkId,
    github,
    name,
    kind,
    ...(operator ? { operator } : {}),
    skills,
  });
}

export const newNonce = () => randomBytes(32).toString("base64");

export function parseJoinMessage(message) {
  let claim;
  try {
    claim = JSON.parse(message);
  } catch {
    return null;
  }
  if (!claim || typeof claim !== "object" || claim.action !== ACTION || claim.domain !== RECIPIENT || claim.version !== VERSION) return null;
  return {
    network: claim.network,
    github: claim.github,
    near: claim.account_id,
    name: claim.name,
    kind: claim.kind,
    operator: claim.operator,
    skills: Array.isArray(claim.skills) ? claim.skills : [],
    timestamp: claim.timestamp,
  };
}

/** The issue a contributor opens on the board, carrying the signed request. */
export function joinIssue(request) {
  const { github, near, kind, skills, operator } = parseJoinMessage(request.message);
  return {
    title: `${TITLE}: @${github}`,
    body: [
      `@${github} asks to join the MultiAgency roster as ${kind === "agent" ? `an agent operated by @${operator}` : "a human"} with ${skills.join(", ")}, paid to \`${near}\`.`,
      "",
      "The request below is signed by the NEAR account; posting it from the GitHub account proves the login. The coordinator verifies both.",
      "",
      fence("roster-request", request),
    ].join("\n"),
  };
}

export const joinRequest = body => fenced(body, "roster-request");

/**
 * Make sure a member's payout account can receive testnet USDC, paying its
 * registration from REGISTRAR_ACCOUNT (a small account whose key the server
 * holds) when it has none: without it, every payout to it would fail.
 */
export async function ensureUsdcRegistration(accountId) {
  if (await view(network.usdc, "storage_balance_of", { account_id: accountId })) return { registered: false };
  const registrar = process.env.REGISTRAR_ACCOUNT;
  if (!registrar) return { problem: `\`${accountId}\` is not registered for testnet USDC yet, so payouts to it would fail; register it with USDC's \`storage_deposit\` (the Join page shows how)` };
  const { min } = await view(network.usdc, "storage_balance_bounds", {});
  const { hash } = await call(registrar, network.usdc, "storage_deposit", { account_id: accountId, registration_only: true }, { deposit: min, gas: "30000000000000" });
  return { registered: true, hash };
}

/**
 * Everything checkable without the network. `author` is the GitHub login that
 * posted the request, when there is one. Returns the roster record or a refusal.
 */
export function checkJoinRequest(request, { author, now = new Date(), maxAgeMs = MAX_AGE_MS } = {}) {
  const { message, nonce, recipient, accountId, publicKey, signature } = request ?? {};
  const signed = parseJoinMessage(message);
  if (!signed) return { refusal: "the request carries no MultiAgency join message" };
  const { fields, error } = joinFields(signed);
  if (error) return { refusal: `the signed message is incomplete: ${error}` };
  if (signed.network !== network.networkId) return { refusal: `the request is for ${signed.network}, not ${network.networkId}` };
  if (recipient !== RECIPIENT) return { refusal: `the request is addressed to ${recipient}, not ${RECIPIENT}` };
  if (accountId !== fields.near) return { refusal: `the request was signed by ${accountId}, not the ${fields.near} it names` };
  if (author !== undefined && author.toLowerCase() !== fields.github.toLowerCase()) {
    return { refusal: `the request names @${fields.github} but was posted by @${author}` };
  }
  const age = now - signed.timestamp;
  if (!(Number.isFinite(age) && age >= -FUTURE_SKEW_MS && age <= maxAgeMs)) {
    return { refusal: `the claim was signed more than ${maxAgeMs / 60_000} minutes before it was posted, or in the future; sign a new one` };
  }
  if (canonicalNonce(nonce) === null) return { refusal: "the nonce is not 32 bytes of canonical base64" };
  let valid = false;
  try {
    valid = verifyNep413Signature({ publicKey, signature, message, nonce: Buffer.from(nonce ?? "", "base64"), recipient });
  } catch {
    valid = false;
  }
  if (!valid) return { refusal: "the signature does not match the message" };
  return {
    builder: {
      nearAccount: fields.near,
      name: fields.name,
      skills: fields.skills,
      links: { github: `https://github.com/${fields.github}` },
      kind: fields.kind,
      ...(fields.operator ? { operator: fields.operator } : {}),
    },
  };
}

/**
 * One canonical spelling per nonce, so a reused nonce cannot be disguised by
 * re-encoding it (base64 decoders accept padding and alphabet variants).
 */
export function canonicalNonce(nonce) {
  const bytes = Buffer.from(String(nonce ?? ""), "base64");
  return bytes.length === 32 && bytes.toString("base64") === nonce ? nonce : null;
}

/**
 * Whether the signing key controls the account. An implicit account (64 hex)
 * not yet on chain is bound by construction: its id is its key. Any account
 * on chain must hold the key as a full-access key.
 */
export async function keyBinding(accountId, publicKey) {
  try {
    const key = await rpc("query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
    return key.permission === "FullAccess" ? null : `the signing key is not a full-access key of ${accountId}`;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (implicitlyBound(accountId, publicKey) && !(await onChain(accountId))) return null;
  return `the signing key is not a full-access key of ${accountId}`;
}

/** An implicit account's id is the hex of its key. */
export function implicitlyBound(accountId, publicKey) {
  if (!IMPLICIT_ACCOUNT.test(accountId) || !String(publicKey).startsWith("ed25519:")) return false;
  try {
    return Buffer.from(fromBase58(publicKey.slice(8))).toString("hex") === accountId;
  } catch {
    return false;
  }
}

async function onChain(accountId) {
  try {
    await rpc("query", { request_type: "view_account", finality: "final", account_id: accountId });
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** Whether a join request other than issue `number` already used this nonce. Durable, unlike an in-memory store. */
export async function nonceUsed(nonce, number) {
  const requests = await searchIssues(`in:title "${TITLE}"`);
  return requests.some(i => i.number !== number && joinRequest(i.body)?.nonce === nonce);
}

export async function verifyJoinRequest(request, options = {}) {
  const result = checkJoinRequest(request, options);
  if (result.refusal) return result;
  if (await nonceUsed(request.nonce, options.issue)) return { refusal: "its nonce was already used by another join request; sign a new one" };
  const unbound = await keyBinding(request.accountId, request.publicKey);
  if (unbound) return { refusal: unbound };
  return result;
}

// The join page: the server words the message (so the page, the CLI and the
// verifier agree on it) and checks the signature before the contributor
// posts it, then hands back a prefilled issue for them to open on the board.
export function mountOnboarding(app) {
  const limit = rateLimit({ windowMs: 3600_000, limit: 20, message: { error: "Too many join attempts from this address. Try again in an hour." } });
  app.post("/api/join/message", limit, (request, response) => {
    const { fields, error } = joinFields(request.body ?? {});
    if (error) return response.status(400).json({ error });
    response.json({ message: joinMessage(fields), nonce: newNonce(), recipient: RECIPIENT });
  });

  app.post("/api/join/request", limit, async (request, response) => {
    const { message, nonce, recipient, accountId, publicKey, signature } = request.body ?? {};
    const signed = { message, nonce, recipient, accountId, publicKey, signature };
    const { refusal } = await verifyJoinRequest(signed);
    if (refusal) return response.status(400).json({ error: refusal });
    const { title, body } = joinIssue(signed);
    // A browser opens the link; an agent working over HTTP posts title and body itself.
    response.json({ issue_url: `${repoUrl}/issues/new?${new URLSearchParams({ title, body })}`, title, body });
  });
}
