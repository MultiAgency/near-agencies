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
//   ROSTER_URL      the coordinator serving GET /api/roster/:login — with
//                   roster.json at the base branch it answers who an author
//                   is beyond team `internal`: a rostered agent counts when
//                   their operator is in team `internal` (#109)
//
// The workflow starts from `workflow_run` after `ci` and `ai-review` finish,
// and checks out the base branch: it never checks out or runs the pull
// request's code, and the verdict comes from the ai-review run's own
// artifact, named for the pull request it reviewed, never from a comment,
// which a pull request can fake. Each pull request is judged on its own
// current head SHA, whatever run started this one. The decision lives in
// lib/staging-approval.mjs, pure. A check that fails is a hold, not an
// error: the job log says which one, nothing is approved, and no "changes
// requested" is ever posted. Only a read that breaks — no pull request
// answerable, a page that will not end — exits non-zero.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { github, orgApi } from "../lib/github.mjs";
import { combineRoster, rosterFromApi, rosterRecord } from "../lib/operator-approval.mjs";
import {
  BASE,
  REVIEWER,
  codeownersRules,
  newestVerdictArtifact,
  openCandidates,
  stagingApproval,
  testVerdict,
  verdictArtifactName,
  verdictArtifactNumbers,
  verdictFrom,
} from "../lib/staging-approval.mjs";

const FILE_PAGES = 50;
const FILE_MAX = 3000;
const CHECK_PAGES = 10;
const REVIEW_PAGES = 10;
const VERDICT_FILE = "verdict.json";
const TEST_CHECK = "test";
// The team behind CODEOWNERS' entry, as operator-approval reads it:
// membership in `internal` allows an author outright (#109 — agents are in
// no team; the roster, read beside it, says who they are).
const INTERNAL_TEAM = "internal";
// The workflow whose verdict artifacts name the pull requests they reviewed,
// and the only file that workflow may live at: an artifact's run counts only
// when it is that workflow's own.
const AI_REVIEW = "ai-review";
const AI_REVIEW_PATH = ".github/workflows/ai-review.yml";

try {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  const sha = event.workflow_run?.head_sha;
  if (!sha) throw new Error("the event carries no workflow run with a head SHA");
  // The triggering run's SHA is the pull request's head only for some
  // events: a pull_request_target run carries the base branch's head, and
  // GitHub matches workflow_run.pull_requests against that SHA, so the run
  // that finished an AI review names its pull request only through the
  // verdict artifact it just uploaded. Candidates come from all three
  // places, and each pull request is judged on the head SHA it answers
  // with now, never on this run's.
  const commitPulls = await github("GET", `/commits/${sha}/pulls?per_page=100`);
  const artifactNumbers = event.workflow_run.name === AI_REVIEW
    ? verdictArtifactNumbers((await github("GET", `/actions/runs/${event.workflow_run.id}/artifacts?per_page=100`)).artifacts)
    : [];
  const numbers = openCandidates(event.workflow_run.pull_requests, commitPulls, artifactNumbers);
  if (numbers.length === 0) {
    console.log(`staging-approval: no pull request is associated with ${sha}`);
    process.exit(0);
  }
  let failed = false;
  for (const number of numbers) {
    try {
      const pr = await github("GET", `/pulls/${number}`);
      if (pr.state === "open") await decide(pr);
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
// heavy reads run together; the artifact read stays last so a long scan
// never sits inside the per-pull-request fan-out. The head SHA is this
// pull request's own, as it answers right now — a verdict, a test check or
// an approval pinned to any other SHA decides nothing here.
async function decide(pr) {
  const number = pr.number;
  const sha = pr.head.sha;
  const author = pr.user?.login;
  const repo = String(process.env.SANDBOX_REPO ?? "").toLowerCase();
  const org = repo.split("/")[0];
  const [paths, internal, codeowners, test, builders, fromApi] = await Promise.all([
    changedFiles(pr),
    readTeam(org, INTERNAL_TEAM),
    textAtBase(".github/CODEOWNERS", pr.base.ref),
    latestTest(sha),
    rosterAtBase(pr.base.ref),
    rosterApi(author),
  ]);
  if (codeowners === null) {
    console.log(`staging-approval: CODEOWNERS could not be read at ${pr.base.ref}, so no file can be covered`);
  }
  // The roster's two homes resolved as operator-approval resolves them: the
  // coordinator's record wins when it has one, roster.json answers when the
  // coordinator does not know the login, and neither readable fails closed
  // in the verdict (lib/staging-approval.mjs).
  const roster = combineRoster(builders ? rosterRecord(builders, author) : { status: "unreadable" }, fromApi);
  // head.repo is GitHub's own word for where the branch lives; a null one
  // (a deleted fork) reads as a fork, which fails the same check.
  const fork = pr.head?.repo?.full_name?.toLowerCase() !== repo;
  const verdict = await verdictFor(number);
  const { outcome, reason } = stagingApproval({
    base: pr.base.ref,
    fork,
    author,
    internal,
    roster,
    paths,
    rules: codeownersRules(codeowners ?? ""),
    test: testVerdict(test),
    verdict,
    sha,
  });
  console.log(`staging-approval ${outcome} on #${number} at ${sha}: ${reason}`);
  console.log(`  author @${author}, head ${pr.head?.repo?.full_name ?? "unknown"}, files ${paths.length}, teams: internal ${describe(internal)}, roster ${roster.status}, test ${testVerdict(test) ?? "missing"}, verdict ${verdict ? `from an ai-review run (${verdict.important} Important)` : "none"}`);
  if (outcome !== "approve") return;
  // The reads above take time, and a push in between moves the head the
  // checks were judged on. The approval names one SHA: re-read the pull
  // request and hold when it moved — the push's own run decides the new
  // head, and staging's ruleset dismisses whatever was posted for the old.
  const now = await github("GET", `/pulls/${number}`);
  if (now.head?.sha !== sha) {
    console.log(`staging-approval: #${number} moved to ${now.head?.sha} while it was judged, so the next run decides`);
    return;
  }
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

// The pull request's changed files, base against head, every page. A rename
// lists both its paths: the old one leaves its owner's protection and the
// new one enters the allowlist, so both must be covered. GitHub lists at
// most 3000 files and answers nothing for the pages past that, so a change
// set that large, or one where the pages read do not add up to the pull
// request's own count, is a read that cannot be completed — it throws, and
// nothing is approved on a change set nobody saw whole.
async function changedFiles(pr) {
  const found = [];
  const names = new Set();
  for (let page = 1; page <= FILE_PAGES; page++) {
    const batch = await github("GET", `/pulls/${pr.number}/files?per_page=100&page=${page}`);
    found.push(...batch.flatMap(file => [file.filename, file.previous_filename]).filter(Boolean));
    for (const file of batch) if (file.filename) names.add(file.filename);
    if (batch.length < 100) {
      if ((pr.changed_files ?? 0) >= FILE_MAX || names.size !== pr.changed_files) {
        throw new Error(`pull request #${pr.number} lists ${pr.changed_files} changed files but only ${names.size} were read, so the change set cannot be judged whole`);
      }
      return found;
    }
  }
  throw new Error(`more than ${FILE_PAGES * 100} changed files on pull request #${pr.number}`);
}

// Team `internal`'s members, as GitHub answers for it. Null when it cannot
// be read — a failed read or a team that does not exist — which fails the
// approval closed (lib/staging-approval.mjs): an unreadable team can only
// ever keep an author out, never let one past. One retry, as the roster
// read gets: runners share their egress with the rest of GitHub.
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
      if (attempt < tries) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        continue;
      }
      console.error(`team ${slug} could not be read: ${error.message}`);
      return null;
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

// The roster as the base branch holds it — never the pull request's copy.
// Null builders when the file cannot be read as one; combineRoster then
// lets the coordinator's answer stand alone (lib/operator-approval.mjs).
async function rosterAtBase(ref) {
  try {
    const parsed = JSON.parse(await textAtBase("roster.json", ref));
    return Array.isArray(parsed?.builders) ? parsed.builders : null;
  } catch {
    return null;
  }
}

// The coordinator's roster record for one login: roster.json as deployed,
// plus members an owner admitted on the board, which the file alone does
// not know. One retry on a rejected or throttled answer, as operator-approval's
// read gets: a required decision should not turn on one 429.
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

// The verdict for this pull request, from the ai-review run's own artifact
// — never from a comment, which a pull request can fake. Nothing a
// workflow run reports names the pull request the run reviewed: a
// `pull_request_target` run answers with the base branch as its head_branch
// and head_sha, so the run is found through its verdict artifact, whose
// name carries the pull request's number (ai-review-verdict-<number>) and
// whose verdict.json carries the head SHA the review judged — compared
// against the head SHA the pull request answers with now, in the verdict
// (stagingApproval). The newest verdict artifact still held decides,
// whatever run left it: a run still going holds (its verdict is coming),
// one that failed, was cancelled, or succeeded without a verdict artifact
// leaves nothing newer to trust, and only a succeeded run's artifact
// decides — through a download with `gh run download`, which unzips the
// artifact GitHub stores. The run's own head_sha is still read for one
// check, the one about the run and not the pull request: its verdict
// counts only when the base branch carries that commit, so a run from a
// side branch's modified copy of the workflow — even one a pull request to
// the base branch carries on its head — decides nothing.
async function verdictFor(number) {
  const name = verdictArtifactName(number);
  let artifact = null;
  try {
    const listed = await github("GET", `/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`);
    artifact = newestVerdictArtifact(listed.artifacts, number);
  } catch (error) {
    console.log(`staging-approval: the verdict artifacts for #${number} could not be read: ${error.message}`);
    return null;
  }
  if (!artifact) {
    console.log(`staging-approval: no ai-review run has left a verdict artifact for #${number}, so nothing is approved`);
    return null;
  }
  let run = null;
  try {
    run = await github("GET", `/actions/runs/${artifact.workflow_run.id}`);
  } catch (error) {
    console.log(`staging-approval: the run behind #${number}'s verdict artifact could not be read: ${error.message}`);
    return null;
  }
  if (run.path !== AI_REVIEW_PATH) {
    // Any run can upload a file under any name; only the owner-committed
    // workflow's own run decides.
    console.log(`staging-approval: the run ${run.id} behind #${number}'s verdict artifact is ${run.path ?? "of no workflow"}, not ${AI_REVIEW_PATH}, so its verdict counts for nothing`);
    return null;
  }
  if (run.conclusion == null) {
    console.log(`staging-approval: the ai-review run ${run.id} behind #${number}'s verdict is still running, so #${number} waits for it`);
    return null;
  }
  if (run.conclusion !== "success") {
    console.log(`staging-approval: the newest ai-review run ${run.id} with a verdict for #${number} ended ${run.conclusion}, so nothing is approved`);
    return null;
  }
  let offBase = `${BASE} does not carry ${run.head_sha}`;
  try {
    const compare = await github("GET", `/compare/${BASE}...${run.head_sha}`);
    if (["behind", "identical"].includes(String(compare?.status ?? ""))) offBase = null;
  } catch (error) {
    offBase = `comparing ${run.head_sha} with ${BASE} failed: ${error.message}`;
  }
  if (offBase) {
    console.log(`staging-approval: ai-review run ${run.id} ran from a commit ${offBase}, so its verdict counts for nothing`);
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "staging-approval-"));
  try {
    execFileSync("gh", ["run", "download", String(run.id), "--name", name, "--repo", process.env.SANDBOX_REPO, "--dir", dir], {
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
    // The newest verdict for this pull request that cannot be read is a
    // hold, never a fallback to an older run's verdict.
    console.log(`staging-approval: the verdict artifact of ai-review run ${run.id} could not be read: ${error.message}`);
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Whether the reviewer's approval already stands at this exact SHA: the
// workflow fires once per completed run, so the second of two firings for
// one head sees the first's approval and leaves it.
async function alreadyApproved(number, sha) {
  for (let page = 1; page <= REVIEW_PAGES; page++) {
    const batch = await github("GET", `/pulls/${number}/reviews?per_page=100&page=${page}`);
    if (batch.some(review => review.user?.login?.toLowerCase() === REVIEWER && review.state === "APPROVED" && review.commit_id === sha)) return true;
    if (batch.length < 100) return false;
  }
  return false;
}

const describe = members => (members === null ? "unreadable" : `${members.length} member${members.length === 1 ? "" : "s"}`);
