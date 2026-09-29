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

export const issue = number => github("GET", `/issues/${number}`);
export const comments = number => github("GET", `/issues/${number}/comments?per_page=100`);
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
