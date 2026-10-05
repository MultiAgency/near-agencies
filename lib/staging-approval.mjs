// Whether a pull request to staging may be approved in code, as the
// reviewer account, with nobody's judgment involved at that step (issue
// #77): the approval posts only when every check in the issue holds for
// the pull request's current head SHA.
//
// Pure logic — no GitHub calls. scripts/staging-approval.mjs reads GitHub
// (the pull request and its files, the two teams, CODEOWNERS at the base
// branch, the `test` check, the ai-review run's verdict artifact) and
// resolves what it finds into the shapes decided on here. The decision
// never checks out or runs the pull request's code, and the verdict can
// only hold an approval back — the deterministic checks carry it.

const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/** The account the approval posts as, named by the CODEOWNERS allowlist. */
export const REVIEWER = "multai-builder";

/** The agency account whose authorship needs no team membership. */
export const AGENCY = "multi-agency";

/** The base branch approvals are for; nothing else qualifies. */
export const BASE = "staging";

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
 * Whether a CODEOWNERS pattern selects `path`: gitignore rules, as
 * CODEOWNERS matches. A trailing / selects the directory's contents; a
 * leading / anchors at the root, and so does any other slash in the
 * pattern; a pattern with no slash matches the name at any depth; * and ?
 * stand for wildcards within one segment.
 */
export function codeownersMatches(pattern, path) {
  const file = String(path ?? "").replace(/^\//, "");
  let pattern1 = String(pattern ?? "").trim().replace(/\/+$/, "");
  if (!file || !pattern1) return false;
  const anchored = pattern1.startsWith("/") || pattern1.includes("/");
  const parts = pattern1.replace(/^\//, "").split("/");
  const names = file.split("/");
  const segment = part => new RegExp(`^${part.split("*").map(s => s.split("?").map(s2 => s2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]")).join("[^/]*")}$`);
  const here = (ps, ns) => ps.length <= ns.length && ps.every((part, at) => segment(part).test(ns[at]));
  if (!anchored && parts.length === 1) return names.some(name => segment(parts[0]).test(name));
  return here(parts, names);
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
 * Whether every changed file sits on the reviewer's allowlist: its last
 * matching rule names @multai-builder. Any file outside it — including
 * every new module — fails closed, and a pull request changing no file at
 * all approves nothing.
 */
export function reviewerCovers(rules, paths) {
  return (paths ?? []).length > 0 && uncoveredPath(rules, paths) === null;
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

/** Whether the pull request's author is one the issue lets the code approve: team internal, team internal-agents, or the agency account. A team that cannot be read holds nobody in. */
export function authorAllowed({ author, internal = [], internalAgents = [] } = {}) {
  return (
    same(author, AGENCY) ||
    (internal ?? []).some(member => same(member, author)) ||
    (internalAgents ?? []).some(member => same(member, author))
  );
}

/** How the `test` check for the head SHA stands: "passed", "pending", or the conclusion it ended with; null when none ran. */
export const testVerdict = check =>
  check == null ? null : check.status !== "completed" ? "pending" : check.conclusion === "success" ? "passed" : check.conclusion ?? "completed";

/**
 * The code approval's verdict. `paths` are the pull request's changed
 * files, `rules` the CODEOWNERS rules read from the base branch, `test`
 * what testVerdict resolved for the head SHA, and `verdict` what the
 * ai-review run uploaded for it. Everything but a pull request to staging
 * from this repository holds; so does an author outside the three names,
 * a team `internal` that cannot be read, a `test` check that has not
 * passed, any file off the allowlist, and a verdict that is missing,
 * malformed, for another SHA, or counts any Important finding. The verdict
 * can only hold an approval back: it never stands in for the others.
 */
export function stagingApproval({ base, fork = false, author, internal = [], internalAgents = [], paths = [], rules = [], test, verdict = null, sha } = {}) {
  if (String(base ?? "").toLowerCase() !== BASE) {
    return hold(`the pull request targets ${base || "no branch"}, not ${BASE}`);
  }
  if (fork) {
    return hold("the pull request comes from a fork, not a branch of this repository");
  }
  if (!Array.isArray(internal)) {
    return hold("team internal could not be read, so the author cannot be checked; failing closed");
  }
  if (!authorAllowed({ author, internal, internalAgents })) {
    return hold(`@${author} is not in team internal, in team internal-agents, or @${AGENCY}`);
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
    return hold(`${uncovered}'s last matching CODEOWNERS rule does not name @${REVIEWER}`);
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
    reason: `${BASE}, this repository, @${author} allowed, test passed, @${REVIEWER} owns every changed file, ai-review counts 0 Important findings`,
  };
}

const hold = reason => ({ outcome: "hold", reason });
