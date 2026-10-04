// Whether a pull request's approvals stand on their own, or only on its
// author agent's operator: the one person who answers for an agent must not
// be the only reviewer of that agent's work (issue #76, plan item 7). The
// staging ruleset counts an operator's approval as code-owner review, so
// until this check an operator could ship their agent's work alone.
//
// Pure logic — no GitHub calls. scripts/operator-approval.mjs reads GitHub
// and the roster, resolves what it finds into the shapes decided on here,
// and the workflow turns the verdict into the required check.

const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/**
 * The reviewers whose approvals count: each reviewer's latest review only,
 * counted when that latest review approves — a later dismissal or comment
 * supersedes an earlier approval — and never the PR author, whose approval
 * GitHub does not count either. Reviews arrive oldest first; on equal
 * timestamps the later one in the list wins.
 */
export function countedApprovals(reviews, author) {
  const latest = new Map();
  for (const review of reviews ?? []) {
    const login = review?.user?.login;
    if (!login || (author && same(login, author))) continue;
    const key = login.toLowerCase();
    const at = String(review.submitted_at ?? "");
    const prior = latest.get(key);
    if (!prior || prior.at <= at) latest.set(key, { login, at, state: review.state });
  }
  return [...latest.values()].filter(review => review.state === "APPROVED").map(review => review.login);
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
 * What the roster's two homes say together. The coordinator's answer wins
 * when it has one: its admitted store holds the later records, and a later
 * record for the same login wins (lib/roster.mjs). When it could not be
 * read, roster.json answers only if it carries the login — an author it does
 * not name might be an admitted agent the store alone knows, and that must
 * fail closed.
 */
export function combineRoster(fromFile, fromApi) {
  if (fromApi && fromApi.status !== "unreadable") return fromApi;
  return fromFile?.status === "record" ? fromFile : { status: "unreadable" };
}

/** OWNER's value as the logins whose approval always counts. */
export const ownersFromEnv = value => String(value ?? "").split(",").map(s => s.trim()).filter(Boolean);

/**
 * The check's verdict. `roster` is what combineRoster resolved about the PR's
 * author, `approvals` the reviewers countedApprovals found, and `owners` the
 * logins whose approval always counts: the owner operates agents too —
 * @multi-agency and agency-builder — and their approval keeps counting as it
 * does today. Everything but a PR to staging passes; a roster that cannot be
 * read, or an agent recorded with no operator, fails closed.
 */
export function operatorApproval({ base = "staging", author, roster, owners = [], approvals = [] } = {}) {
  if (String(base ?? "").toLowerCase() !== "staging") {
    return { outcome: "pass", reason: `the pull request targets ${base}, not staging` };
  }
  if (!roster || roster.status === "unreadable") {
    return { outcome: "fail", reason: "the roster could not be read, so the author's operator cannot be checked; failing closed" };
  }
  if (roster.status !== "record") {
    return { outcome: "pass", reason: `@${author} is not on the roster, so no operator's approval is discounted` };
  }
  if (roster.kind === "human") {
    return { outcome: "pass", reason: `@${author} is a person on the roster, not an agent` };
  }
  if (roster.kind !== "agent") {
    return { outcome: "fail", reason: `the roster record for @${author} names no kind, so it cannot be checked; failing closed` };
  }
  if (!roster.operator) {
    return { outcome: "fail", reason: `the roster records @${author} as an agent with no operator, so it cannot be checked; failing closed` };
  }
  if (approvals.length === 0) {
    return { outcome: "pass", reason: "no approvals yet, so none of them is the operator's" };
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
