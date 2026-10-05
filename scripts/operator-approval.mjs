// The operator-approval check the staging ruleset requires (issue #76): a
// pull request authored by a rostered agent must not stand on approvals from
// that agent's operator alone. The job running this is the required check,
// so a non-zero exit fails the PR.
//
//   OWNER       logins whose approval always counts, comma-separated
//   ORG_TOKEN   a token with the org's "Members: read", for the team read
//   ROSTER_URL  the coordinator serving GET /api/roster/:login
//
// GITHUB_EVENT_PATH carries the pull_request or pull_request_review event
// that started the run. Everything uncertain fails the check: a roster or a
// team that cannot be read, a request that errors, an event with no pull
// request.
// The decision itself lives in lib/operator-approval.mjs, pure, and runs
// from the base branch's own checkout (the workflow checks out `staging`),
// never from the PR's copy of it.
import { readFileSync } from "node:fs";

import { github, orgApi } from "../lib/github.mjs";
import {
  combineRoster,
  countableApprovals,
  countedApprovals,
  judgedTeamMembers,
  operatorApproval,
  ownersFromCodeowners,
  ownersFromEnv,
  REVIEWED_TEAMS,
  rosterFromApi,
  rosterRecord,
  unrecognizedApprovals,
} from "../lib/operator-approval.mjs";

const REVIEW_PAGES = 10;
const TEAM_PAGES = 10;
// The teams whose members the check reads come from lib's REVIEWED_TEAMS —
// one team, `internal`, the entry CODEOWNERS names. Agents are in no team
// (#109); the roster says who they are. The list is pinned by test, so a
// second team cannot creep back into these reads unjudged.

try {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  const number = event.pull_request?.number;
  if (!number) throw new Error("GITHUB_EVENT_PATH carries no pull request");
  const pr = await github("GET", `/pulls/${number}`);
  const author = pr.user.login;
  const base = pr.base.ref;
  const org = event.repository?.owner?.login ?? String(process.env.GITHUB_REPOSITORY ?? "").split("/")[0];
  // A fork's run gets no repository secrets, so its team read cannot
  // succeed — GitHub's design, not a read that failed. The unread team
  // passes through and the verdict judges the fork on what needs no org
  // token (lib/operator-approval.mjs); a same-repo PR fails closed when
  // team internal cannot be read.
  const fork = event.pull_request.head.repo?.full_name !== event.repository?.full_name;

  // The team reads start alongside the others and land keyed by slug;
  // judgedTeamMembers picks the one team the verdict consumes and throws if
  // the pinned list drifted from it, failing closed.
  const teamReads = new Map(REVIEWED_TEAMS.map(slug => [slug, teamMembers(org, slug)]));
  const [reviews, codeowners, builders, fromApi] = await Promise.all([
    allReviews(number),
    textAtBase(".github/CODEOWNERS", base),
    buildersAtBase(base),
    rosterApi(author),
  ]);
  const teams = {};
  for (const [slug, read] of teamReads) teams[slug] = await read;
  const internal = judgedTeamMembers(teams);
  if (codeowners === null) {
    console.log("CODEOWNERS could not be read at the base branch, so only the owner's and the internal team's approvals count");
  }
  const standing = countedApprovals(reviews, author);
  const owners = ownersFromEnv(process.env.OWNER);
  const codeownerUsers = ownersFromCodeowners(codeowners ?? "");
  // Only what CODEOWNERS itself covers counts: the file's own logins, OWNER,
  // and team `internal`'s members. An approval outside them is unvouched,
  // and the verdict fails closed rather than reading it as no approval at
  // all — a dropped approval must not hide the operator's.
  const approvals = countableApprovals(standing, codeownerUsers, owners, internal ?? []);
  const unvouched = unrecognizedApprovals(standing, codeownerUsers, owners, internal ?? []);
  const roster = combineRoster(builders ? rosterRecord(builders, author) : { status: "unreadable" }, fromApi);

  const { outcome, reason } = operatorApproval({ base, author, roster, owners, approvals, unvouched, internal, fork });
  console.log(`operator-approval ${outcome}: ${reason}`);
  console.log(`  author @${author}, base ${base}, approvals counted: ${approvals.length ? approvals.map(login => `@${login}`).join(", ") : "none"}, roster: ${roster.status}`);
  process.exit(outcome === "pass" ? 0 : 1);
} catch (error) {
  console.error(`operator-approval: ${error.message}; failing closed`);
  process.exit(1);
}

// Every page of reviews: a dismissal of an old approval sits on its page.
async function allReviews(number) {
  const found = [];
  for (let page = 1; page <= REVIEW_PAGES; page++) {
    const batch = await github("GET", `/pulls/${number}/reviews?per_page=100&page=${page}`);
    found.push(...batch);
    if (batch.length < 100) return found;
  }
  throw new Error(`more than ${REVIEW_PAGES * 100} reviews on pull request ${number}`);
}

// A file's text as the base branch has it — never the PR's copy, which the
// PR could rewrite. Null when it cannot be read.
async function textAtBase(path, base) {
  try {
    const file = await github("GET", `/contents/${path}?ref=${encodeURIComponent(base)}`);
    return Buffer.from(file.content ?? "", "base64").toString("utf8");
  } catch {
    return null;
  }
}

async function buildersAtBase(base) {
  try {
    const parsed = JSON.parse(await textAtBase("roster.json", base));
    return Array.isArray(parsed?.builders) ? parsed.builders : null;
  } catch {
    return null;
  }
}

// A team's members, as GitHub answers for it — the CODEOWNERS team entry
// made concrete. Null when the team cannot be read, which fails the check:
// who counts as a reviewer must not hang on a read that silently answered
// nothing. One retry, as the roster read gets: runners share their egress
// with the rest of GitHub, and a required check should not fail on one 429.
async function teamMembers(org, slug, tries = 2) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const found = [];
      for (let page = 1; page <= TEAM_PAGES; page++) {
        const batch = await orgApi("GET", `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/members?per_page=100&page=${page}`);
        found.push(...batch.map(user => user?.login ?? "").filter(Boolean));
        if (batch.length < 100) return found;
      }
      throw new Error(`more than ${TEAM_PAGES * 100} members`);
    } catch (error) {
      if (attempt < tries) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        continue;
      }
      console.error(`team ${slug} could not be read: ${error.message}`);
      return null;
    }
  }
}

// The coordinator's roster record for one login: roster.json as deployed,
// plus members an owner admitted on the board, which the file alone does
// not know. One retry on a rejected or throttled answer: runners share
// their egress with the rest of GitHub, and a required check should not
// fail on one 429.
async function rosterApi(login, tries = 2) {
  const url = `${process.env.ROSTER_URL ?? "https://demo.multiagency.ai"}/api/roster/${encodeURIComponent(login)}`;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (response.ok) return rosterFromApi(await response.json());
      if (attempt < tries) {
        const wait = Math.min(Number(response.headers.get("retry-after")) * 1000 || 3000, 10_000);
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    } catch {
      if (attempt < tries) await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  return { status: "unreadable" };
}
