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
// The GitHub org the board lives in ("MultiAgency" of MultiAgency/…), whose
// teams gate who may open a job from the board.
const org = repo.split("/")[0];

export function github(method, path, body) {
  return api(method, `/repos/${repo}${path}`, body);
}

// Org-level endpoints — a team's members, say — sit outside the /repos
// prefix github() adds, and reading them usually needs more than the
// repository-scoped GITHUB_TOKEN can be granted (workflow permissions have
// no org keys). When the caller provides ORG_TOKEN — a fine-grained token
// with the org's "Members: read" — it authenticates these calls instead.
export function orgApi(method, path, body) {
  return api(method, path, body, process.env.ORG_TOKEN || authToken());
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

/** Whether a pull request's body closes issue `source` (`owner/repo#n`), as
 * GitHub reads it: a closing keyword as a whole word (`prefix #1` closes
 * nothing), then the issue. The issue may be named with its repository, or
 * by its number alone when the pull request is in the issue's own
 * repository (`prRepo`): elsewhere, a bare `#n` names that repository's
 * issue. The issue's full URL (`https://github.com/owner/repo/issues/n`)
 * names it too. A pull request that only mentions the issue closes nothing. */
export function closesIssue(body, prRepo, source) {
  const [, repo, number] = /^(.+)#(\d+)$/.exec(source ?? "") ?? [];
  if (!number) return false;
  const named = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const issue = String(prRepo ?? "").toLowerCase() === repo.toLowerCase() ? `(?:${named})?#${number}` : `${named}#${number}`;
  const url = `https?://github\\.com/${named}/issues/${number}/?`;
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+(?:${issue}|${url})\\b`, "i").test(body ?? "");
}

/** The board repo's numeric id: stable across renames and transfers, unlike its URL. */
export const repoId = () => github("GET", "").then(r => r.id);

// Every GitHub request goes through here: a hung request fails after
// GITHUB_TIMEOUT_MS instead of stalling its caller (the coordinator's cycle
// waits on each one), and the rate-limit budget GitHub reports is kept.
const TIMEOUT_MS = Number(process.env.GITHUB_TIMEOUT_MS ?? "30000");
let budget = null;
export const githubBudget = () => budget;

async function send(method, path, body, token = authToken()) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
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

async function api(method, path, body, token) {
  const response = await send(method, path, body, token);
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
// wrote them; payout.mjs has written them as an owner. The bot is the
// deployment's (botLogin), not this token's own login. Answers are kept for
// the process's life; a failed lookup is not, so it is asked again.
const trusted = new Map();
let bot;
export function isTrusted(login) {
  if (!trusted.has(login)) {
    bot ??= botLogin();
    const answer = bot.then(async self => login === self || OWNER_ROLES.includes(await roleOf(login)));
    trusted.set(login, answer);
    answer.catch(() => {
      trusted.delete(login);
      bot = undefined;
    });
  }
  return trusted.get(login);
}

// Who the board's own writes come from. An ```engagement block counts only
// when its issue was opened by the bot (lib/epic.mjs opens every job), so a
// stranger's own block on an issue they wrote is never a job. The bot's login
// is a deployment fact, not the caller's identity: BOARD_BOT pins it for a
// process running on someone else's token (payout.mjs from an owner's
// terminal), and otherwise the token's own login answers — memoized the way
// isTrusted keeps its bot, a failed lookup asked again.
let selfLogin;
export function botLogin() {
  if (process.env.BOARD_BOT) return Promise.resolve(process.env.BOARD_BOT);
  selfLogin ??= me();
  selfLogin.catch(() => { selfLogin = undefined; });
  return selfLogin;
}

// Board jobs may be opened by an active member of one of the org's teams
// ("internal", say): GitHub answers the membership read 200 with the
// member's state — `active`, or `pending` while the invite stands — and 404
// when they are not a member at all. Only an active member counts: an
// invite nobody accepted grants nothing. A 404 says "not a member" only
// from ORG_TOKEN, the token the org granted its Members: read; another
// token's 404 cannot tell a non-member from a team it may not see, and
// fails closed. A read that fails for any other reason throws, so the
// caller can fail closed too.
export function orgTeamMember(team, login) {
  return orgApi("GET", `/orgs/${org}/teams/${team}/memberships/${encodeURIComponent(login)}`).then(
    member => member?.state === "active",
    error => {
      if (process.env.ORG_TOKEN && String(error.message).includes(": 404 ")) return false;
      throw error;
    },
  );
}

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

// Registry repositories (agents/claude-worker/repos.mjs) sit outside the board
// repo github() prefixes: their issues carry `ready-for-agent`, and the
// coordinator reads those issues, their events and threads, and answers them
// there. Same token, another repository's prefix.
export const repoIssues = (name, query) => api("GET", `/repos/${name}/issues?${query}`);
export const repoIssue = (name, number) => api("GET", `/repos/${name}/issues/${number}`);
export const repoComment = (name, number, body) => api("POST", `/repos/${name}/issues/${number}/comments`, { body });
export const repoRemoveLabel = (name, number, label) => api("DELETE", `/repos/${name}/issues/${number}/labels/${encodeURIComponent(label)}`);

// An issue's timeline on another repository, oldest first, every page of it:
// the latest application of a label sits on the last one, the way a board
// issue's events are read for its gate labels (lib/guard.mjs). The timeline,
// not the plain events list, is also where a pull request's cross-reference
// of the issue is recorded — the event the auto-job sweep reads.
const REPO_TIMELINE_PAGES = 50;

export async function repoIssueTimeline(name, number) {
  const found = [];
  for (let page = 1; page <= REPO_TIMELINE_PAGES; page++) {
    const batch = await api("GET", `/repos/${name}/issues/${number}/timeline?per_page=100&page=${page}`);
    found.push(...batch);
    if (batch.length < 100) return found;
  }
  throw new Error(`more than ${REPO_TIMELINE_PAGES * 100} timeline events on ${name}#${number}`);
}

// A registry issue's thread, for the answer said there once: same pagination,
// so a handled issue's mark past the first page is still seen.
const REPO_COMMENT_PAGES = 50;

export async function repoComments(name, number) {
  const found = [];
  for (let page = 1; page <= REPO_COMMENT_PAGES; page++) {
    const batch = await api("GET", `/repos/${name}/issues/${number}/comments?per_page=100&page=${page}`);
    found.push(...batch);
    if (batch.length < 100) return found;
  }
  throw new Error(`more than ${REPO_COMMENT_PAGES * 100} comments on ${name}#${number}`);
}

// When an issue's body or title was last edited, or null. GitHub's issue
// events do not record body edits, so this is the only read that sees one —
// the coordinator judges an edit after a label's application from it. GitHub
// answers a GraphQL error with HTTP 200 and an errors list, which is thrown,
// never read as never-edited.
export async function issueLastEditedAt(name, number) {
  const [owner, repo] = name.split("/");
  const data = await api("POST", "/graphql", {
    query: "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){lastEditedAt}}}",
    variables: { owner, repo, number },
  });
  if (data?.errors?.length || !data?.data?.repository) {
    throw new Error(`GitHub GraphQL: ${data?.errors?.[0]?.message ?? "the issue could not be read"}`);
  }
  return data.data.repository.issue?.lastEditedAt ?? null;
}

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
