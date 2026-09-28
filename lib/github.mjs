// Minimal GitHub REST client for the sandbox kanban repo. The token comes from
// GITHUB_TOKEN, GITHUB_TOKEN_FILE, or, failing both, the local `gh` login.
import { execFileSync } from "node:child_process";
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

/** The board repo's numeric id: stable across renames and transfers, unlike its URL. */
export const repoId = () => github("GET", "").then(r => r.id);

async function api(method, path, body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${authToken()}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${path}: ${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? null : response.json();
}

export const issue = number => github("GET", `/issues/${number}`);
export const comments = number => github("GET", `/issues/${number}/comments?per_page=100`);
export const comment = (number, body) => github("POST", `/issues/${number}/comments`, { body });

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
