// The code approval for staging pull requests (issue #77): approve, as the
// reviewer account, when every check in the issue holds for the pull
// request's current head SHA — staging, a branch of this repository, an
// allowed author, a passed `test` check, @multai-builder owning every
// changed file, and an ai-review verdict counting 0 Important findings.
//
//   REVIEWER_TOKEN  the reviewer account's token; the workflow maps it to
//                   GITHUB_TOKEN and ORG_TOKEN for lib/github.mjs, so reads
//                   and the approving review all act as @multai-builder
//   SANDBOX_REPO    the repository, for lib/github.mjs
//
// The workflow starts from `workflow_run` after `ci` and `ai-review` finish,
// and checks out the base branch: it never checks out or runs the pull
// request's code, and the verdict comes from the ai-review run's own
// artifact, never from a comment, which a pull request can fake. The
// decision lives in lib/staging-approval.mjs, pure. A check that fails is a
// hold, not an error: the job log says which one, nothing is approved, and
// no "changes requested" is ever posted. Only a read that breaks — no pull
// request answerable, a page that will not end — exits non-zero.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { github, orgApi } from "../lib/github.mjs";
import {
  REVIEWER,
  codeownersRules,
  stagingApproval,
  testVerdict,
  verdictFrom,
} from "../lib/staging-approval.mjs";

const FILE_PAGES = 50;
const CHECK_PAGES = 10;
const RECENT_RUNS = 30;
const VERDICT_ARTIFACT = "ai-review-verdict";
const VERDICT_FILE = "verdict.json";
const TEST_CHECK = "test";
const AI_REVIEW_WORKFLOW = "ai-review.yml";
// The teams behind CODEOWNERS' entries, as operator-approval reads them:
// membership in `internal` allows the author outright, and membership in
// `internal-agents` allows the agency's own agents.
const INTERNAL_TEAM = "internal";
const INTERNAL_AGENTS_TEAM = "internal-agents";

try {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  const sha = event.workflow_run?.head_sha;
  if (!sha) throw new Error("the event carries no workflow run with a head SHA");
  const numbers = (await github("GET", `/commits/${sha}/pulls?per_page=100`))
    .filter(pull => pull.state === "open")
    .map(pull => pull.number);
  if (numbers.length === 0) {
    console.log(`staging-approval: no open pull request carries ${sha}`);
    process.exit(0);
  }
  let failed = false;
  for (const number of numbers) {
    try {
      await decide(number, sha);
    } catch (error) {
      console.error(`staging-approval: pull request #${number}: ${error.message}`);
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
} catch (error) {
  console.error(`staging-approval: ${error.message}`);
  process.exit(1);
}

// One pull request, all six checks, an approval only when all hold. The
// heavy reads run together; the artifact read stays last in the loop so a
// long scan never sits inside the per-pull-request fan-out.
async function decide(number, sha) {
  const pr = await github("GET", `/pulls/${number}`);
  const repo = String(process.env.SANDBOX_REPO ?? "").toLowerCase();
  const org = repo.split("/")[0];
  const [paths, internal, internalAgents, codeowners, test] = await Promise.all([
    changedFiles(number),
    readTeam(org, INTERNAL_TEAM),
    readTeam(org, INTERNAL_AGENTS_TEAM),
    textAtBase(".github/CODEOWNERS", pr.base.ref),
    latestTest(sha),
  ]);
  if (codeowners === null) {
    console.log(`staging-approval: CODEOWNERS could not be read at ${pr.base.ref}, so no file can be covered`);
  }
  // head.repo is GitHub's own word for where the branch lives; a null one
  // (a deleted fork) reads as a fork, which fails the same check.
  const fork = pr.head?.repo?.full_name?.toLowerCase() !== repo;
  const verdict = await verdictFor(sha);
  const { outcome, reason } = stagingApproval({
    base: pr.base.ref,
    fork,
    author: pr.user?.login,
    internal,
    internalAgents,
    paths,
    rules: codeownersRules(codeowners ?? ""),
    test: testVerdict(test),
    verdict,
    sha,
  });
  console.log(`staging-approval ${outcome} on #${number} at ${sha}: ${reason}`);
  console.log(`  author @${pr.user?.login}, head ${pr.head?.repo?.full_name ?? "unknown"}, files ${paths.length}, teams: internal ${describe(internal)}, internal-agents ${describe(internalAgents)}, test ${testVerdict(test) ?? "missing"}, verdict ${verdict ? `from an ai-review run (${verdict.important} Important)` : "none"}`);
  if (outcome !== "approve") return;
  if (await alreadyApproved(number, sha)) {
    console.log(`staging-approval: @${REVIEWER} has already approved #${number} at ${sha}`);
    return;
  }
  await github("POST", `/pulls/${number}/reviews`, {
    commit_id: sha,
    event: "APPROVE",
    body: [
      "**Approved in code** (issue #77), nobody's judgment involved at this step:",
      "",
      `- targets \`${pr.base.ref}\`;`,
      "- comes from a branch of this repository;",
      `- @${pr.user?.login} is allowed to be approved in code;`,
      "- the `test` check passed;",
      `- @${REVIEWER} is the last matching CODEOWNERS rule for every changed file;`,
      "- the ai-review run for this head counts 0 Important findings.",
      "",
      "A push dismisses this approval (staging ruleset) and the next run decides again.",
    ].join("\n"),
  });
  console.log(`staging-approval: approved #${number} as @${REVIEWER} at ${sha}`);
}

// The pull request's changed files, base against head, every page.
async function changedFiles(number) {
  const found = [];
  for (let page = 1; page <= FILE_PAGES; page++) {
    const batch = await github("GET", `/pulls/${number}/files?per_page=100&page=${page}`);
    found.push(...batch.map(file => file.filename).filter(Boolean));
    if (batch.length < 100) return found;
  }
  throw new Error(`more than ${FILE_PAGES * 100} changed files on pull request #${number}`);
}

// A team's members as GitHub answers for it. Team `internal` returning null
// fails the approval closed (lib/staging-approval.mjs). Team
// `internal-agents` does not exist yet: a 404 means nobody is in it, and any
// other failure after one retry reads as nobody too — an unreadable team can
// only ever keep an author out, never let one past.
async function readTeam(org, slug, tries = 2) {
  const path = slug => `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/members?per_page=100&page=`;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const found = [];
      for (let page = 1; page <= 10; page++) {
        const batch = await orgApi("GET", `${path(slug)}${page}`);
        found.push(...batch.map(user => user?.login ?? "").filter(Boolean));
        if (batch.length < 100) return found;
      }
      throw new Error("more than 1000 members");
    } catch (error) {
      if (String(error.message).includes(": 404 ")) {
        console.error(`team ${slug} does not exist, so nobody is in it`);
        return [];
      }
      if (attempt < tries) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        continue;
      }
      console.error(`team ${slug} could not be read: ${error.message}`);
      return slug === INTERNAL_TEAM ? null : [];
    }
  }
}

// A file's text as the base branch has it — never the pull request's copy.
// Null when it cannot be read.
async function textAtBase(path, ref) {
  try {
    const file = await github("GET", `/contents/${path}?ref=${encodeURIComponent(ref)}`);
    return Buffer.from(file.content ?? "", "base64").toString("utf8");
  } catch {
    return null;
  }
}

// The `test` check's newest run for this exact head SHA, or null when none
// ran: check ids only grow, so the largest id is the newest.
async function latestTest(sha) {
  for (let page = 1; page <= CHECK_PAGES; page++) {
    const batch = await github("GET", `/commits/${sha}/check-runs?per_page=100&page=${page}`);
    const runs = (batch.check_runs ?? []).filter(run => run.name === TEST_CHECK);
    if (runs.length > 0) return runs.sort((a, b) => b.id - a.id)[0];
    if (batch.total_count <= page * 100) return null;
  }
  return null;
}

// The verdict for this head SHA, from the ai-review run's own artifact —
// never from a comment. Runs come newest first; the first run carrying an
// unexpired verdict artifact decides, and a verdict for an older SHA holds
// (a newer review is still running or never finished). Downloaded with
// `gh run download`, which unzips the artifact GitHub stores.
async function verdictFor(sha) {
  const runs = await github("GET", `/actions/workflows/${AI_REVIEW_WORKFLOW}/runs?event=pull_request_target&per_page=${RECENT_RUNS}`);
  for (const run of (runs.workflow_runs ?? []).filter(run => run.conclusion === "success")) {
    const listed = await github("GET", `/actions/runs/${run.id}/artifacts?per_page=100`);
    const artifact = (listed.artifacts ?? []).find(a => a.name === VERDICT_ARTIFACT && !a.expired);
    if (!artifact) continue;
    const dir = mkdtempSync(join(tmpdir(), "staging-approval-"));
    try {
      execFileSync("gh", ["run", "download", String(run.id), "--name", VERDICT_ARTIFACT, "--repo", process.env.SANDBOX_REPO, "--dir", dir], {
        stdio: "ignore",
        env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN },
      });
      const verdict = verdictFrom(readFileSync(join(dir, VERDICT_FILE), "utf8"));
      if (verdict) {
        console.log(`staging-approval: verdict from ai-review run ${run.id} (${run.created_at})`);
        return verdict;
      }
      console.log(`staging-approval: ai-review run ${run.id} uploaded a verdict that does not parse`);
      return null;
    } catch (error) {
      console.log(`staging-approval: the verdict artifact of ai-review run ${run.id} could not be read: ${error.message}`);
      continue;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log("staging-approval: no ai-review run left a verdict artifact");
  return null;
}

// Whether the reviewer's approval already stands at this exact SHA: the
// workflow fires once per completed run, so the second of two firings for
// one head sees the first's approval and leaves it.
async function alreadyApproved(number, sha) {
  const reviews = await github("GET", `/pulls/${number}/reviews?per_page=100`);
  return reviews.some(review => review.user?.login?.toLowerCase() === REVIEWER && review.state === "APPROVED" && review.commit_id === sha);
}

const describe = members => (members === null ? "unreadable" : `${members.length} member${members.length === 1 ? "" : "s"}`);
