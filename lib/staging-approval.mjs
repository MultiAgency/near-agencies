// Whether a pull request to staging may be approved in code, as the
// reviewer account, with nobody's judgment involved at that step (issue
// #77): the approval posts only when every check in the issue holds for
// the pull request's current head SHA.
//
// Pure logic — no GitHub calls. scripts/staging-approval.mjs reads GitHub
// (the pull request and its files, team `internal`, the roster, CODEOWNERS
// at the base branch, the `test` check, the ai-review verdict artifact
// named for the pull request) and resolves what it finds into the shapes
// decided on here. The decision
// never checks out or runs the pull request's code, and the verdict can
// only hold an approval back — the deterministic checks carry it.

const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/** The account the approval posts as, named by the CODEOWNERS allowlist. */
export const REVIEWER = "multai-builder";

/** The agency account whose authorship needs no team membership. */
export const AGENCY = "multi-agency";

/** The base branch approvals are for; nothing else qualifies. */
export const BASE = "staging";

/** The ai-review run artifact that carries a pull request's verdict, named for the pull request it reviewed. */
const VERDICT_ARTIFACT = "ai-review-verdict";

/** The verdict artifact's whole name for one pull request: `ai-review-verdict-<number>`. */
export const verdictArtifactName = number => `${VERDICT_ARTIFACT}-${number}`;

/**
 * CODEOWNERS as the base branch holds it, in file order: each rule's
 * pattern with the owners it names, comments aside, case-normalized. A
 * rule naming no owner selects nothing (GitHub ignores such lines), and a
 * team entry keeps its name — matching decides a rule, not who is on the
 * team, so a team's members are never resolved here.
 */
export function codeownersRules(text) {
  const rules = [];
  for (const line of String(text ?? "").split("\n")) {
    const entry = line.replace(/#.*/, "").trim();
    if (!entry) continue;
    const [pattern, ...owners] = entry.split(/\s+/);
    if (!pattern || owners.length === 0) continue;
    rules.push({ pattern, owners: owners.map(owner => owner.replace(/^@/, "").toLowerCase()).filter(Boolean) });
  }
  return rules;
}

/**
 * Whether a CODEOWNERS pattern selects `path`, as GitHub's CODEOWNERS
 * matches: most of gitignore's rules, with GitHub's own documented
 * examples deciding the edges — a trailing slash owns the directory's
 * contents at any depth, a trailing wildcard owns that one level alone
 * ("files like `docs/getting-started.md` but not further nested files
 * like `docs/build-app/troubleshooting.md`"), and a leading double-star
 * before `logs` owns every file in a logs directory anywhere. So: a
 * separator at the start or middle anchors the pattern at the root, an
 * unanchored one matches at any depth; a trailing slash marks a
 * directory and never a file that happens to share its name; a star and
 * a question mark stand for wildcards within one segment and a
 * double-star crosses them; a literal last segment may name a directory,
 * whose contents the pattern then owns, while a wildcard last segment
 * owns files at that level and nothing below it. Under-matching a later
 * rule would let an earlier, wider one decide, so a pattern that matches
 * a path only part of the way owns nothing past its own depth.
 */
export function codeownersMatches(pattern, path) {
  const file = String(path ?? "").replace(/^\//, "");
  const pattern1 = String(pattern ?? "").trim();
  if (!file || !pattern1) return false;
  const dirOnly = pattern1.endsWith("/");
  const parts = pattern1.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length === 0) return false;
  const anchored = pattern1.replace(/\/+$/, "").includes("/");
  const last = parts[parts.length - 1];
  const contentsAllowed = dirOnly || last === "**" || !/[*?]/.test(last);
  const components = file.split("/");
  const segment = part => new RegExp(`^${part.split("*").map(s => s.split("?").map(s2 => s2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]")).join("[^/]*")}$`);
  // Where the pattern's run of segments ends in the file's path decides
  // what it owns: exactly at the path's end, the file itself; earlier, the
  // directory it names, when the pattern may own contents.
  const walk = (pi, ci) => {
    if (pi === parts.length) return ci;
    const part = parts[pi];
    if (part === "**") {
      for (let end = ci; end <= components.length; end++) {
        const done = walk(pi + 1, end);
        if (done >= 0) return done;
      }
      return -1;
    }
    return ci < components.length && segment(part).test(components[ci]) ? walk(pi + 1, ci + 1) : -1;
  };
  for (const start of anchored ? [0] : components.keys()) {
    const end = walk(0, start);
    if (end < 0) continue;
    if (end === components.length) return !dirOnly;
    if (contentsAllowed) return true;
  }
  return false;
}

/** The owners of the last rule matching `path`, or none: GitHub counts the last match only. */
export function ownersForPath(rules, path) {
  for (const rule of [...(rules ?? [])].reverse()) {
    if (codeownersMatches(rule.pattern, path)) return rule.owners;
  }
  return [];
}

/** The first changed file whose last matching CODEOWNERS rule does not name the reviewer, or null. */
export function uncoveredPath(rules, paths) {
  for (const path of paths ?? []) {
    if (!ownersForPath(rules, path).includes(REVIEWER)) return path;
  }
  return null;
}

/**
 * The verdict an ai-review run uploaded: `{"sha": "...", "important": 0}`,
 * or null when it is missing, not JSON, or carries no head SHA and a
 * non-negative count of Important findings. The head SHA comes from the
 * workflow, not from the model, and an integer is the only shape a count
 * can take.
 */
export function verdictFrom(text) {
  try {
    const verdict = JSON.parse(String(text ?? ""));
    if (typeof verdict?.sha !== "string" || verdict.sha === "") return null;
    if (!Number.isInteger(verdict?.important) || verdict.important < 0) return null;
    return { sha: verdict.sha, important: verdict.important };
  } catch {
    return null;
  }
}

/**
 * Whether the pull request's author is one the issue lets the code approve:
 * the agency account, a member of team `internal`, or a rostered agent
 * whose operator is in team `internal` (#109 — agents are in no team of
 * their own; the roster says who they are and who answers for them). A
 * team that cannot be read holds nobody in, and no roster record reads as
 * no agent.
 */
export function authorAllowed({ author, internal = [], roster = null } = {}) {
  return (
    same(author, AGENCY) ||
    (internal ?? []).some(member => same(member, author)) ||
    (roster?.status === "record" &&
      roster.kind === "agent" &&
      Boolean(roster.operator) &&
      (internal ?? []).some(member => same(member, roster.operator)))
  );
}

/** How the `test` check for the head SHA stands: "passed", "pending", or the conclusion it ended with; null when none ran. */
export const testVerdict = check =>
  check == null ? null : check.status !== "completed" ? "pending" : check.conclusion === "success" ? "passed" : check.conclusion ?? "completed";

/**
 * The open pull requests a completed run could be deciding: the ones the
 * event names for its triggering run — a pull_request_target run carries
 * the pull request there, while its head SHA is the base branch's, useless
 * for finding the pull request — together with the ones GitHub associates
 * with the run's head commit. Deduplicated; the caller reads each pull
 * request itself and judges it on its own current head SHA.
 */
export function openCandidates(eventPullRequests = [], commitPulls = [], artifactNumbers = []) {
  const numbers = new Set([
    ...(eventPullRequests ?? []).map(pull => pull?.number),
    ...(commitPulls ?? []).map(pull => pull?.number),
    ...(artifactNumbers ?? []),
  ]);
  return [...numbers].filter(number => Number.isInteger(number));
}

/**
 * The pull request an `edited` pull_request_target event names, or null for
 * any other event. A title or body edited after the approval fires neither
 * `ci` nor `ai-review`, so the decision starts from the edit itself (#168).
 */
export function editedPullNumber(event) {
  const number = event?.pull_request?.number;
  return event?.action === "edited" && Number.isInteger(number) ? number : null;
}

/**
 * Why a pull request read again just before its approval is not the one the
 * decision judged, or null: its head SHA, its base branch and its body must
 * all stand. The approval names one head SHA, and the attribution check read
 * one body, so an approval posted over a body edited meanwhile would stand
 * over text the gate had not read (#168). A pull request that cannot be read
 * again is not the one judged.
 */
export function movedWhileJudged(judged, now) {
  if (!now) return "it could not be read again";
  if (now.head?.sha !== judged.head?.sha) return `its head moved to ${now.head?.sha}`;
  if ((now.base?.ref ?? "") !== (judged.base?.ref ?? "")) return `its base moved to ${now.base?.ref}`;
  if ((now.body ?? "") !== (judged.body ?? "")) return "its body changed";
  return null;
}

/**
 * The ids of the reviewer's approvals that stand at this exact head SHA: the
 * ones an edit that no longer earns the approval must dismiss. A dismissed or
 * commented review, another account's, and one for another SHA stand for
 * nothing here.
 */
export function standingApprovals(reviews, sha) {
  return (reviews ?? [])
    .filter(review => same(review?.user?.login, REVIEWER) && review.state === "APPROVED" && review.commit_id === sha)
    .map(review => review.id);
}

/** The artifacts GitHub answered with: the array itself, or the response object's own array. */
const artifactsOf = artifacts => (Array.isArray(artifacts) ? artifacts : artifacts?.artifacts ?? []);

/** The pull request numbers in artifacts named for the pull request they reviewed: `ai-review-verdict-<number>`. */
export function verdictArtifactNumbers(artifacts) {
  const named = new RegExp(`^${VERDICT_ARTIFACT}-(\\d+)$`);
  return artifactsOf(artifacts)
    .map(artifact => named.exec(artifact?.name ?? "")?.[1])
    .filter(Boolean)
    .map(Number);
}

/**
 * The verdict artifact that decides a pull request's approval: the newest
 * one still held whose name carries the pull request's number and that
 * knows the run which uploaded it. The artifact's name ties a verdict to
 * its pull request, the verdict.json inside it names the head SHA the
 * review judged, and verdictRunProblem decides whether the run behind it
 * may decide at all. Expired artifacts and artifacts with no run behind
 * them decide nothing.
 */
export function newestVerdictArtifact(artifacts, number) {
  const name = verdictArtifactName(number);
  return (
    artifactsOf(artifacts)
      .filter(artifact => artifact?.name === name && !artifact.expired && Number.isInteger(artifact?.workflow_run?.id))
      .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0] ?? null
  );
}

// The only file the ai-review workflow may live at.
export const AI_REVIEW_PATH = ".github/workflows/ai-review.yml";

/**
 * Why the workflow run behind a verdict artifact cannot decide pull request
 * `number`, or null when it can. A `pull_request_target` run always runs
 * the workflow file of its pull request's base branch, so a run of
 * ai-review.yml on that event, listing this pull request into staging, ran
 * the owner-committed workflow. Any other event (`pull_request`, `push`,
 * `workflow_dispatch`) can run a branch's own copy, and a pull request into
 * another branch runs that branch's copy, which could name its artifact for
 * any pull request. The run's head_sha is the pull request's head, not the
 * base's, so it says nothing about where the workflow came from.
 */
export function verdictRunProblem(run, number) {
  if (run?.path !== AI_REVIEW_PATH) return `it is ${run?.path || "of no workflow"}, not ${AI_REVIEW_PATH}`;
  if (run.event !== "pull_request_target") return `it ran on ${run.event || "no event"}, not pull_request_target, so it may have run a branch's copy of the workflow`;
  if (!(run.pull_requests ?? []).some(pr => pr?.number === number && pr?.base?.ref === BASE)) {
    return `it lists no pull request #${number} into ${BASE}, so it may have run another branch's copy of the workflow`;
  }
  return null;
}

// AGENTS.md: PR bodies and commit messages carry the change's own description
// only, with no tool attribution lines. A line naming an AI tool as the
// author or co-author: a Co-Authored-By trailer, or a footer line that starts
// "Generated with" or "Generated by" and names the tool.
const TOOLS = "claude|anthropic|codex|copilot|cursor|chatgpt|openai|gemini";
const ATTRIBUTION = new RegExp(`^\\s*co-authored-by:.*\\b(?:${TOOLS})\\b|^[^\\p{L}\\p{N}]*(?:generated|created|written)\\s+(?:with|by)\\s+\\W*(?:${TOOLS})\\b`, "imu");

/**
 * The first tool attribution line in a pull request's body or its commit
 * messages, or null: which of them, for the hold's reason.
 */
export function attributionIn({ body = "", messages = [] } = {}) {
  if (ATTRIBUTION.test(body ?? "")) return "the pull request body";
  const at = (messages ?? []).findIndex(message => ATTRIBUTION.test(message ?? ""));
  return at === -1 ? null : `commit message ${at + 1} of ${messages.length}`;
}

/**
 * The code approval's verdict. `paths` are the pull request's changed
 * files, `rules` the CODEOWNERS rules read from the base branch (null when
 * CODEOWNERS itself could not be read), `test` what testVerdict resolved
 * for the head SHA, `verdict` what the ai-review
 * run uploaded for it, and `roster` the author's roster record as
 * lib/operator-approval.mjs resolves it (`{status: "record"|"absent"|
 * "unreadable", kind, operator}`). Everything but a pull request to
 * staging from this repository holds; so does an author outside team
 * `internal`, the agency account, and the roster's agents whose operator
 * is in team `internal` — a team `internal` that cannot be read fails
 * closed for every author, and a roster that cannot be read fails closed
 * for every author the team read alone cannot allow. A `test` check that
 * has not passed, any file off the allowlist, and a verdict that is
 * missing, malformed, for another SHA, or counting any Important finding
 * hold too. The verdict can only hold an approval back: it never stands in
 * for the others. A hold the edit itself can cause carries `edited`, and a
 * hold from a read that failed without throwing carries `readFailed`; an
 * edited pull request's run takes the approval down on either marker (#168).
 */
export function stagingApproval({ base, fork = false, author, internal = [], roster = null, paths = [], rules = [], test = null, verdict = null, sha, body = null, messages = null } = {}) {
  if (String(base ?? "").toLowerCase() !== BASE) {
    return hold(`the pull request targets ${base || "no branch"}, not ${BASE}`, { edited: true });
  }
  if (fork) {
    return hold("the pull request comes from a fork, not a branch of this repository");
  }
  if (!Array.isArray(internal)) {
    return hold("team internal could not be read, so the author cannot be checked; failing closed", { readFailed: true });
  }
  if (roster?.status === "unreadable" && !authorAllowed({ author, internal })) {
    return hold("the roster could not be read, so the author cannot be checked against it; failing closed", { readFailed: true });
  }
  if (!authorAllowed({ author, internal, roster })) {
    return hold(`@${author} is not in team internal, @${AGENCY}, or a rostered agent whose operator is in team internal`);
  }
  if (test === null) {
    return hold("no test check ran for this head SHA");
  }
  if (test !== "passed") {
    return hold(test === "pending" ? "the test check has not finished for this head SHA" : `the test check ended ${test}`);
  }
  if ((paths ?? []).length === 0) {
    return hold("the pull request changes no file, so the allowlist approves nothing");
  }
  const uncovered = uncoveredPath(rules, paths);
  if (uncovered !== null) {
    // No rules at all is also how CODEOWNERS unreadable arrives: that hold
    // is the read failing (#168), not a file off the allowlist.
    return hold(`${uncovered}'s last matching CODEOWNERS rule does not name @${REVIEWER}`, rules === null ? { readFailed: true } : undefined);
  }
  // Checked in code, not left to the review: ai-review once passed a pull
  // request whose body and commit carried a Claude attribution (#117). A body
  // or commit list that could not be read fails closed, as the others do.
  if (body === null || messages === null) {
    return hold("the pull request body or its commit messages could not be read, so attribution cannot be checked; failing closed", { readFailed: true });
  }
  const attributed = attributionIn({ body, messages });
  if (attributed) {
    return hold(`${attributed} carries a tool attribution line, which AGENTS.md forbids`, { edited: true });
  }
  if (!verdict) {
    return hold("the ai-review run left no verdict for this head SHA, or one that does not parse");
  }
  if (!same(verdict.sha, sha)) {
    return hold(`the ai-review verdict is for ${verdict.sha}, not this head SHA`);
  }
  if (verdict.important !== 0) {
    return hold(`the ai-review verdict counts ${verdict.important} Important finding${verdict.important === 1 ? "" : "s"}`);
  }
  return {
    outcome: "approve",
    reason: `${BASE}, this repository, @${author} allowed, test passed, @${REVIEWER} owns every changed file, no tool attribution, ai-review counts 0 Important findings`,
  };
}

// The markers an edited pull request's run reads on a hold (#168):
// `edited` marks one the pull request's own edit can cause — its base branch
// or a tool attribution line in its body — and `readFailed` marks one from a
// read that failed without throwing (the team, the roster, CODEOWNERS, or a
// body or commit list that could not be read). On an edit either kind takes
// the approval down, so none stands over a body the gate has not fully read;
// every other hold — a check that has not run, or one that ran and answered
// for itself — carries no marker and leaves the approval where it is.
const hold = (reason, markers) => ({ outcome: "hold", reason, ...(markers ?? {}) });
