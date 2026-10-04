// Minimal GitHub REST client for the sandbox kanban repo. The token comes from
// GITHUB_TOKEN, GITHUB_TOKEN_FILE, or, failing both, the local `gh` login.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const repo = process.env.SANDBOX_REPO ?? "MultiAgency/kanban-sandbox";

// Resolved on first use, so modules can be imported (and tested) without one.
let token;
function authToken() {
  token ??=
    process.env.GITHUB_TOKEN ??
    (process.env.GITHUB_TOKEN_FILE ? readFileSync(process.env.GITHUB_TOKEN_FILE, "utf8").trim() : localGhToken());
  return token;
}

function localGhToken() {
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("GITHUB_TOKEN is not set and no local gh login is available");
  }
}

export const repoUrl = `https://github.com/${repo}`;

export function github(method, path, body) {
  return api(method, `/repos/${repo}${path}`, body);
}

/** The account the token acts as. */
export const me = () => api("GET", "/user").then(user => user.login);

/** A pull request by URL, from any repository the token can read. */
export function pullRequest(url) {
  const [, owner, name, number] = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return api("GET", `/repos/${owner}/${name}/pulls/${number}`);
}

/** The repository ("owner/name", lowercase) a pull-request URL points at. */
export const pullRepo = url => url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/)?.slice(1, 3).join("/").toLowerCase();

/** The board repo's numeric id: stable across renames and transfers, unlike its URL. */
export const repoId = () => github("GET", "").then(r => r.id);

// Every GitHub request goes through here: a hung request fails after
// GITHUB_TIMEOUT_MS instead of stalling its caller (the coordinator's cycle
// waits on each one), and the rate-limit budget GitHub reports is kept.
const TIMEOUT_MS = Number(process.env.GITHUB_TIMEOUT_MS ?? "30000");
let budget = null;
export const githubBudget = () => budget;

async function send(method, path, body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${authToken()}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const remaining = response.headers.get("x-ratelimit-remaining");
  if (remaining !== null) {
    budget = {
      remaining: Number(remaining),
      limit: Number(response.headers.get("x-ratelimit-limit")),
      resets_at: new Date(Number(response.headers.get("x-ratelimit-reset")) * 1000).toISOString(),
    };
  }
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${path}: ${response.status} ${await response.text()}`);
  }
  return response;
}

async function api(method, path, body) {
  const response = await send(method, path, body);
  return response.status === 204 ? null : response.json();
}

/** GitHub-flavoured markdown rendered (and sanitized) by GitHub, as HTML. */
export async function markdownHtml(text) {
  return (await send("POST", "/markdown", { text, mode: "gfm", context: repo })).text();
}

/** Issues on the board matching a search (GitHub's search syntax), bodies included. */
export async function searchIssues(query) {
  const q = encodeURIComponent(`repo:${repo} is:issue ${query}`);
  return (await api("GET", `/search/issues?q=${q}&per_page=100`)).items;
}

const OWNER_ROLES = ["admin", "maintain"];
// Anyone with a GitHub account reads as `read`; a login that is not a user has no role.
const roleOf = login => github("GET", `/collaborators/${encodeURIComponent(login)}/permission`).then(
  p => p.role_name,
  error => {
    if (String(error.message).includes(": 404 ")) return null;
    throw error;
  },
);

/** Whether a login owns the board: admin or maintain permission. Commands check this each time. */
export const isOwner = login => roleOf(login).then(role => OWNER_ROLES.includes(role), () => false);

// Anyone can comment on the board, so the records the coordinator acts on
// (payouts, payments, change requests) count only when the bot or an owner
// wrote them; payout.mjs has written them as an owner. Answers are kept for
// the process's life; a failed lookup is not, so it is asked again.
const trusted = new Map();
let bot;
export function isTrusted(login) {
  if (!trusted.has(login)) {
    bot ??= me();
    const answer = bot.then(async self => login === self || OWNER_ROLES.includes(await roleOf(login)));
    trusted.set(login, answer);
    answer.catch(() => {
      trusted.delete(login);
      bot = undefined;
    });
  }
  return trusted.get(login);
}

/** Engagement epics, open or closed, updated since `since` (an ISO time), bodies included. */
const EPIC_PAGES = 20;

export async function epicIssues(since) {
  const found = [];
  for (let page = 1; page <= EPIC_PAGES; page++) {
    const batch = await github("GET", `/issues?labels=engagement&state=all&since=${encodeURIComponent(since)}&per_page=100&page=${page}`);
    found.push(...batch);
    if (batch.length < 100) return found;
  }
  // Dropping the oldest silently would hide the epic a recovery looks for and create a duplicate.
  throw new Error(`more than ${EPIC_PAGES * 100} engagement epics since ${since}`);
}

export const issue = number => github("GET", `/issues/${number}`);

// A claim, handoff or /admit posted past the first 100 comments must still
// be seen, so this follows pagination the way epicIssues does.
const COMMENT_PAGES = 50;

export async function comments(number) {
  const found = [];
  for (let page = 1; page <= COMMENT_PAGES; page++) {
    const batch = await github("GET", `/issues/${number}/comments?per_page=100&page=${page}`);
    found.push(...batch);
    if (batch.length < 100) return found;
  }
  // Dropping the oldest silently would hide the claim or handoff it was looking for.
  throw new Error(`more than ${COMMENT_PAGES * 100} comments on issue ${number}`);
}

export const comment = (number, body) => github("POST", `/issues/${number}/comments`, { body });
export const commentAt = url => github("GET", `/issues/comments/${url.match(/#issuecomment-(\d+)$/)[1]}`);

/** The sha256 a handoff pins a deliverable comment's body with. */
export const digest = text => createHash("sha256").update(text).digest("hex");

// Parse the first fenced block with the given info string, e.g. ```handoff.
// Mirrors the kanban convention's parseHandoff: malformed or missing -> null.
export function fenced(text, info) {
  const match = new RegExp("```" + info + "\\n([\\s\\S]*?)\\n```").exec(text ?? "");
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export const fence = (info, value) => "```" + info + "\n" + JSON.stringify(value, null, 2) + "\n```";
