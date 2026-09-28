// Joining the roster. A contributor signs a NEP-413 message with their NEAR
// account naming their GitHub login, kind and skills, then posts it on the
// board from that GitHub account: the signature proves the payout account,
// the issue author proves the login. The coordinator verifies the request on
// the board; an owner adds it to roster.json with `node roster.mjs add`.
import { randomBytes } from "node:crypto";

import { verifyNep413Signature } from "@fastnear/utils";
import { rateLimit } from "express-rate-limit";

import { fence, fenced, repoUrl } from "./github.mjs";
import { isAccountId, isMissing, rpc } from "./near.mjs";
import { network } from "./network.mjs";

export const RECIPIENT = "multiagency";
export const SKILLS = ["research", "writing", "code", "review"];
export const KINDS = ["agent", "human"];
const MAX_AGE_MS = 7 * 24 * 3600_000;
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

/** What the wallet signs: readable, and exactly what the roster entry will say. */
export function joinMessage({ github, near, name, kind, skills, operator }, issued = new Date()) {
  return [
    TITLE,
    `network: ${network.networkId}`,
    `github: ${github}`,
    `near: ${near}`,
    `name: ${name}`,
    `kind: ${kind}`,
    ...(operator ? [`operator: ${operator}`] : []),
    `skills: ${skills.join(", ")}`,
    `issued: ${issued.toISOString()}`,
  ].join("\n");
}

export const newNonce = () => randomBytes(32).toString("base64");

export function parseJoinMessage(message) {
  const lines = String(message).split("\n");
  if (lines[0] !== TITLE) return null;
  const values = Object.fromEntries(lines.slice(1).map(line => {
    const at = line.indexOf(": ");
    return at === -1 ? [line, ""] : [line.slice(0, at), line.slice(at + 2)];
  }));
  return {
    network: values.network,
    github: values.github,
    near: values.near,
    name: values.name,
    kind: values.kind,
    operator: values.operator,
    skills: values.skills ? values.skills.split(", ") : [],
    issued: values.issued,
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
  const age = now - Date.parse(signed.issued);
  if (!(age >= -5 * 60_000 && age <= maxAgeMs)) return { refusal: "the signed message is expired or not yet valid; sign a new one" };
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

/** NEP-413 requires a full-access key: check the signing key is one, on chain. */
export async function isFullAccessKey(accountId, publicKey) {
  try {
    const key = await rpc("query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
    return key.permission === "FullAccess";
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function verifyJoinRequest(request, options) {
  const result = checkJoinRequest(request, options);
  if (result.refusal) return result;
  if (!(await isFullAccessKey(request.accountId, request.publicKey))) {
    return { refusal: `the signing key is not a full-access key of ${request.accountId}` };
  }
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
    response.json({ issue_url: `${repoUrl}/issues/new?${new URLSearchParams({ title, body })}` });
  });
}
