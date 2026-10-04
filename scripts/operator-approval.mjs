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
  countedApprovals,
  operatorApproval,
  ownersFromEnv,
  rosterFromApi,
  rosterRecord,
} from "../lib/operator-approval.mjs";

const REVIEW_PAGES = 10;

try {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  const number = event.pull_request?.number;
  if (!number) throw new Error("GITHUB_EVENT_PATH carries no pull request");
  const pr = await github("GET", `/pulls/${number}`);
  const author = pr.user.login;
  const base = pr.base.ref;

  const [reviews, fromFile, fromApi] = await Promise.all([allReviews(number), rosterFile(base, author), rosterApi(author)]);
  const approvals = countedApprovals(reviews, author);
  const roster = combineRoster(fromFile, fromApi);
  const owners = ownersFromEnv(process.env.OWNER);
  if (!owners.length) console.log("OWNER is not set, so no approval is exempt from the operator check");

  const { outcome, reason } = operatorApproval({ base, author, roster, owners, approvals });
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

// roster.json as the base branch has it — never the PR's copy, which the PR
// could rewrite.
async function rosterFile(base, author) {
  try {
    const file = await github("GET", `/contents/roster.json?ref=${encodeURIComponent(base)}`);
    const builders = JSON.parse(Buffer.from(file.content ?? "", "base64").toString("utf8")).builders;
    return rosterRecord(Array.isArray(builders) ? builders : [], author);
  } catch {
    return { status: "unreadable" };
  }
}

// The coordinator's roster: roster.json as deployed plus the members an
// owner admitted on the board, which the file alone does not know.
async function rosterApi(login) {
  try {
    const url = `${process.env.ROSTER_URL ?? "https://demo.multiagency.ai"}/api/roster/${encodeURIComponent(login)}`;
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { status: "unreadable" };
    return rosterFromApi(await response.json());
  } catch {
    return { status: "unreadable" };
  }
}
