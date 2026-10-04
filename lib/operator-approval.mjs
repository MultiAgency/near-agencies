// Whether a pull request's approvals stand on their own, or only on its
// author agent's operator: the one person who answers for an agent must not
// be the only reviewer of that agent's work (issue #76, plan item 7). The
// staging ruleset counts an operator's approval as code-owner review, so
// until this check an operator could ship their agent's work alone.
//
// Pure logic — no GitHub calls. scripts/operator-approval.mjs reads GitHub
// (the reviews, CODEOWNERS at the base branch, the org's two teams) and the
// roster, resolves what it finds into the shapes decided on here, and the
// workflow turns the verdict into the required check.

const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/**
 * The reviewers whose approvals count: each reviewer's latest verdict,
 * where a comment is transparent — it leaves an earlier approval standing,
 * as GitHub's review requirement does — while approving, requesting changes
 * or dismissing sets it. Never the PR author, whose approval GitHub does not
 * count either. Reviews arrive oldest first; on equal timestamps the later
 * one in the list wins.
 */
export function countedApprovals(reviews, author) {
  const verdict = new Map();
  for (const review of reviews ?? []) {
    const login = review?.user?.login;
    if (!login || (author && same(login, author))) continue;
    if (String(review.state ?? "").toUpperCase() === "COMMENTED") continue;
    const key = login.toLowerCase();
    const at = String(review.submitted_at ?? "");
    const prior = verdict.get(key);
    if (!prior || prior.at <= at) verdict.set(key, { login, at, state: review.state });
  }
  return [...verdict.values()].filter(review => review.state === "APPROVED").map(review => review.login);
}

/**
 * The logins CODEOWNERS (as the base branch has it) names directly. Team
 * entries like @MultiAgency/internal expand nowhere here — a bare file
 * cannot know a team's members — so a team's members count through
 * GitHub's team read instead (countableApprovals).
 */
export function ownersFromCodeowners(text) {
  const users = new Set();
  for (const line of String(text ?? "").split("\n")) {
    const entry = line.replace(/#.*/, "").trim();
    if (!entry) continue;
    for (const token of entry.split(/\s+/).slice(1)) {
      if (!token.startsWith("@") || token.includes("/")) continue;
      users.add(token.slice(1).toLowerCase());
    }
  }
  return [...users];
}

/**
 * The approvals the staging ruleset can act on: a login CODEOWNERS (as the
 * base branch has it) names directly — the owner's among them — or a member
 * of team `internal`, the team entry CODEOWNERS names and GitHub confirms by
 * membership. Nothing declared decides an approver: the roster's and the
 * coordinator's `kind: "human"` are claims the board never verifies, so an
 * outside contributor claiming to be a person counts no more than an agent's
 * approval does — agents sit in internal-agents, which can merge but never
 * count as reviewers — and neither does a stranger's or an alt's, so "someone
 * else approved" always means someone CODEOWNERS itself covers.
 */
export function countableApprovals(approvals, codeownerUsers = [], owners = [], internal = []) {
  const named = new Set([...codeownerUsers, ...owners, ...internal].map(login => String(login).toLowerCase()));
  return (approvals ?? []).filter(login => named.has(String(login).toLowerCase()));
}

/**
 * The approvals nothing here vouches for. CODEOWNERS, OWNER and team
 * `internal` are the only sources for a reviewer — the roster's and
 * coordinator's declared kinds answer for the PR's author, never for its
 * reviewers — and an approval dropped as uncheckable must not read as "no
 * approvals yet", which is the bypass this check exists to close.
 */
export function unrecognizedApprovals(approvals, codeownerUsers = [], owners = [], internal = []) {
  const countable = new Set(countableApprovals(approvals, codeownerUsers, owners, internal).map(login => String(login).toLowerCase()));
  return (approvals ?? []).filter(login => !countable.has(String(login).toLowerCase()));
}

/** The record `roster.json` holds for `login`, or none. */
export function rosterRecord(builders, login) {
  const githubLogin = builder => builder?.links?.github?.replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
  const found = (builders ?? []).find(builder => same(githubLogin(builder), login));
  if (!found) return { status: "absent" };
  return { status: "record", kind: found.kind ?? null, operator: found.operator ?? null };
}

/** The record the coordinator's `GET /api/roster/:login` answered with. */
export function rosterFromApi(body) {
  if (typeof body?.stage !== "string") return { status: "unreadable" };
  if (body.stage !== "member" || typeof body.member !== "object" || body.member === null) return { status: "absent" };
  return { status: "record", kind: body.member.kind ?? null, operator: body.member.operator ?? null };
}

/**
 * What the roster's two homes say together. The coordinator's record wins
 * when it has one: its admitted store holds the later records, and a later
 * record for the same login wins (lib/roster.mjs). Its "not a member"
 * answer defers to roster.json, though — the coordinator's deployed copy
 * can lag staging, and a record the base branch names must still be judged.
 * When it could not be read at all, roster.json answers only if it carries
 * the login — an author it does not name might be an admitted agent the
 * store alone knows, and that must fail closed.
 */
export function combineRoster(fromFile, fromApi) {
  if (fromApi && fromApi.status === "record") return fromApi;
  if (fromFile?.status === "record") return fromFile;
  return fromApi && fromApi.status === "absent" ? { status: "absent" } : { status: "unreadable" };
}

/** OWNER's value as the logins whose approval always counts. */
export const ownersFromEnv = value => String(value ?? "").split(",").map(s => s.trim()).filter(Boolean);

/**
 * The check's verdict. `roster` is what combineRoster resolved about the PR's
 * author, `internal` and `internalAgents` the members GitHub answers for the
 * org's two teams (null when a team cannot be read), `approvals` the
 * countable approvals, `unvouched` the raw approvals no source could vouch
 * for, and `owners` the logins whose approval always counts: the owner
 * operates agents too — @multi-agency and agency-builder (`roster.json`) —
 * and the owner's approval keeps counting as it does today. The author is an
 * agent when team `internal-agents` names them or the roster records them as
 * one; a declared `kind: "human"` never decides it, and a member of
 * `internal-agents` whose operator no roster source names fails closed.
 * Everything but a PR to staging passes; a roster or a team that cannot be
 * read, an agent recorded with no operator, and an approval nobody can
 * vouch for all fail closed — an approval dropped for being uncheckable
 * must not read as "no approvals yet".
 */
export function operatorApproval({ base = "staging", author, roster, owners = [], approvals = [], unvouched = [], internal = [], internalAgents = [] } = {}) {
  if (String(base ?? "").toLowerCase() !== "staging") {
    return { outcome: "pass", reason: `the pull request targets ${base}, not staging` };
  }
  if (!roster || roster.status === "unreadable") {
    return { outcome: "fail", reason: "the roster could not be read, so the author's operator cannot be checked; failing closed" };
  }
  if (!Array.isArray(internal) || !Array.isArray(internalAgents)) {
    return { outcome: "fail", reason: "a team could not be read from GitHub, so who counts as a reviewer cannot be checked; failing closed" };
  }
  const teamAgent = internalAgents.some(member => same(member, author));
  if (roster.status !== "record") {
    return teamAgent
      ? { outcome: "fail", reason: `@${author} is in team internal-agents, but no roster source names their operator, so it cannot be checked; failing closed` }
      : { outcome: "pass", reason: `@${author} is not on the roster, so no operator's approval is discounted` };
  }
  if (!teamAgent && roster.kind === "human") {
    return { outcome: "pass", reason: `@${author} is a person on the roster, not an agent` };
  }
  if (!teamAgent && roster.kind !== "agent") {
    return { outcome: "fail", reason: `the roster record for @${author} names no kind, so it cannot be checked; failing closed` };
  }
  if (!roster.operator) {
    return {
      outcome: "fail",
      reason: teamAgent
        ? `@${author} is in team internal-agents, but no roster source names their operator, so it cannot be checked; failing closed`
        : `the roster records @${author} as an agent with no operator, so it cannot be checked; failing closed`,
    };
  }
  if (approvals.length === 0 && unvouched.length === 0) {
    return { outcome: "pass", reason: "no approvals yet, so none of them is the operator's" };
  }
  if (approvals.length === 0) {
    return {
      outcome: "fail",
      reason: `the approval${unvouched.length > 1 ? "s" : ""} from @${unvouched.join(", @")} cannot be vouched for by CODEOWNERS, OWNER or team internal; failing closed`,
    };
  }
  const operator = roster.operator;
  if (owners.some(owner => same(owner, operator))) {
    return { outcome: "pass", reason: `@${operator} operates @${author} as the owner, whose approval counts as it does today` };
  }
  const others = approvals.filter(login => !same(login, operator));
  if (others.length === 0) {
    return {
      outcome: "fail",
      reason: `the only approval${approvals.length > 1 ? "s are" : " is"} @${approvals.join(", @")}, @${author}'s operator; an operator's approval alone does not approve their agent's PR`,
    };
  }
  return { outcome: "pass", reason: `the approval from @${others.join(", @")} counts alongside @${operator}'s` };
}
