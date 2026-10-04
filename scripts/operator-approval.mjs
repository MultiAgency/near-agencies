// The operator-approval check the staging ruleset requires (issue #76): a
// pull request authored by a rostered agent must not stand on approvals from
// that agent's operator alone. The job running this is the required check,
// so a non-zero exit fails the PR.
//
//   OWNER       logins whose approval always counts, comma-separated
//   ROSTER_URL  the coordinator serving GET /api/roster/:login
//
// GITHUB_EVENT_PATH carries the pull_request or pull_request_review event
// that started the run. Everything uncertain fails the check: a roster that
// cannot be read, a request that errors, an event with no pull request.
// The decision itself lives in lib/operator-approval.mjs, pure, and runs
// from the base branch's own checkout (the workflow checks out `staging`),
// never from the PR's copy of it.
import { readFileSync } from "node:fs";

import { github } from "../lib/github.mjs";
import {
  combineRoster,
  countableApprovals,
  countedApprovals,
  operatorApproval,
  ownersFromCodeowners,
  ownersFromEnv,
  rosterFromApi,
  rosterRecord,
  unrecognizedApprovals,
} from "../lib/operator-approval.mjs";

const REVIEW_PAGES = 10;

try {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  const number = event.pull_request?.number;
  if (!number) throw new Error("GITHUB_EVENT_PATH carries no pull request");
  const pr = await github("GET", `/pulls/${number}`);
  const author = pr.user.login;
  const base = pr.base.ref;

  const [reviews, codeowners, builders, fromApi] = await Promise.all([
    allReviews(number),
    textAtBase(".github/CODEOWNERS", base),
    buildersAtBase(base),
    rosterApi(author),
  ]);
  if (codeowners === null) {
    console.log("CODEOWNERS could not be read at the base branch, so only the owner's and rostered people's approvals count");
  }
  const standing = countedApprovals(reviews, author);
  const owners = ownersFromEnv(process.env.OWNER);
  const codeownerUsers = ownersFromCodeowners(codeowners ?? "");
  const known = countableApprovals(standing, codeownerUsers, owners, builders ?? []);
  // An approver neither CODEOWNERS nor roster.json knows may still be a
  // person the coordinator has admitted; ask before discounting them, since
  // a hidden operator reads as "no approvals", the bypass this check closes.
  // One the coordinator cannot vouch either stays unvouched, and the verdict
  // fails closed rather than reading it as no approval at all.
  const vouched = [];
  const unvouched = [];
  await Promise.all(
    unrecognizedApprovals(standing, codeownerUsers, owners, builders ?? []).map(async login => {
      const record = await rosterApi(login);
      (record.status === "record" && record.kind === "human" ? vouched : unvouched).push(login);
    }),
  );
  const approvals = [...known, ...vouched];
  const roster = combineRoster(builders ? rosterRecord(builders, author) : { status: "unreadable" }, fromApi);

  const { outcome, reason } = operatorApproval({ base, author, roster, owners, approvals, unvouched });
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

// The coordinator's roster: roster.json as deployed plus the members an
// owner admitted on the board, which the file alone does not know. One
// retry on a rejected or throttled answer: runners share their egress with
// the rest of GitHub, and a required check should not fail on one 429.
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
