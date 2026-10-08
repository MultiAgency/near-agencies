// Seats are the kanban issues of an engagement: each carries a ```terms block
// (engagement, amount, and the repository a code task delivers to) and may
// depend on earlier seats via `- [ ] #N` lines.
import { closeVerified } from "./guard.mjs";
import { commentAt, comments, digest, fenced, github, isTrusted, issue } from "./github.mjs";

export async function openSeats() {
  const issues = await github("GET", "/issues?state=open&per_page=100");
  return issues.filter(i => !i.pull_request && fenced(i.body, "terms")).map(seat);
}

export function seat(issue) {
  const labels = issue.labels.map(label => label.name);
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.html_url,
    state: issue.state,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    labels,
    skills: labels.filter(name => name.startsWith("skill:")),
    assignees: issue.assignees.map(a => a.login),
    terms: fenced(issue.body, "terms"),
    dependsOn: [...issue.body.matchAll(/^- \[[ x]\] #(\d+)/gm)].map(m => Number(m[1])),
  };
}

/**
 * Whether a roster builder may take this seat. Returns a reason when not.
 * Skills are declared, not checked, so they suggest work rather than gate it;
 * what gates is membership and who a task is for (people, or also agents).
 * A task whose terms carry a `source` (an auto job's, always volunteer) is
 * never `human-only`, so the roster itself is not required for it: a
 * claimant off the roster reads as passing agent-eligible and failing
 * human-only, same as every check below once it is on the roster.
 */
export function eligibility(seat, builder) {
  if (!builder) return seat.terms?.source ? null : "not on the MultiAgency roster";
  if (seat.labels.includes("human-only") && builder.kind !== "human") return "this task is human-only";
  if (builder.kind === "agent" && !seat.labels.includes("agent-eligible")) return "this task is not agent-eligible";
  return null;
}

/**
 * Why a task cannot be claimed yet, or null: a dependency of it is still
 * open. `promote` readies a task only once its dependencies are done, but
 * `ready` is no guarded label (GATE_LABELS), so anyone with triage can put it
 * on a task that is still blocked; the claim settlers ask here instead of
 * trusting the label (#166).
 *
 * A dependency that cannot be read (deleted, or GitHub answering 5xx) refuses
 * the claim at hand instead of throwing: a throw here would abort the whole
 * coordinator cycle (#181), and a dependency deleted for good would do that
 * on every cycle forever. The claim stays refused until the dependency reads
 * again, or a trusted edit drops it from `dependsOn`.
 */
export async function dependencyProblem(seat) {
  const open = [];
  for (const n of seat.dependsOn) {
    let dependency;
    try {
      dependency = await issue(n);
    } catch {
      return `dependency #${n} could not be read`;
    }
    // A close counts only as promote counts it: a stranger's is undone
    // (closeVerified reopens it), so someone with triage cannot clear a
    // dependency by closing it as well as relabelling the task.
    if (dependency.state !== "closed" || !await closeVerified(n, dependency.closed_at)) open.push(`#${n}`);
  }
  return open.length ? `its dependencies ${open.join(", ")} aren't done yet` : null;
}

/**
 * Why a claimant cannot take this seat because they delivered one of the
 * seats it reviews, or null: a sign-off means someone else checked the work.
 * Only a review seat gates the deliverers of its dependencies — building on
 * earlier work is what tasks are for. A dependency's deliverer is whoever is
 * assigned to it, its claimant at close — the latest "Claimed by @…" record
 * from the bot or an owner, so a claimant with triage access cannot clear it
 * by unassigning themselves, and nobody can forge one against somebody else —
 * or the author of the handoff that closed it. An earlier claim does not
 * count: one the stale sweep released was not a delivery.
 */
export async function selfReviewProblem(seat, login) {
  if (!seat.skills.includes("skill:review")) return null;
  for (const n of seat.dependsOn) {
    let claimedBy;
    try {
      claimedBy = await delivered(n, login);
    } catch {
      return `dependency #${n} could not be read`;
    }
    if (claimedBy) {
      return `this task reviews #${n}, which you delivered — a sign-off means someone else checked the work`;
    }
  }
  return null;
}

/** Whether this login delivered seat #n: assigned to it, its claimant at
 * close — the latest trusted "Claimed by" record — or the author of the
 * handoff that closed it. Only the latest trusted record counts, so a claim
 * released by the stale sweep and redelivered by somebody else gates nobody. */
async function delivered(number, login) {
  const [parent, thread] = await Promise.all([issue(number), comments(number)]);
  const same = other => other?.toLowerCase() === login.toLowerCase();
  if (parent.assignees.some(a => same(a.login))) return true;
  const closer = closingHandoff(thread, parent.closed_at);
  for (const c of [...thread].reverse()) {
    const claimed = /^Claimed by @([\w-]+)\./.exec(c.body.trim());
    if (claimed && await isTrusted(c.user.login)) return same(claimed[1]) || same(closer);
  }
  return same(closer);
}

/** The author of the handoff that closed the seat: the latest readable
 * ```handoff posted no later than the close, since an unreadable one closes
 * nothing. Both timestamps are GitHub's Zulu ISO, which compares as a string. */
function closingHandoff(thread, closedAt) {
  const handoffs = thread.filter(c => fenced(c.body, "handoff") && (!closedAt || c.created_at <= closedAt));
  return handoffs.at(-1)?.user.login;
}

/** A handoff that links a deliverable comment must pin it: an optional pin protects nothing. */
export const pinProblem = handoff => !handoff.deliverable && (handoff.links ?? []).some(url => url.includes("#issuecomment-"))
  ? "it links a deliverable comment without pinning its sha256"
  : null;

/**
 * Why a handoff cannot close its seat, or null: the checks payouts make, paid
 * to its author's roster account, with any deliverable pinned and unedited.
 * An auto job's task (`source` true) needs no roster, same as eligibility():
 * a claimant off the roster still passes, and with none to pay, its payout
 * account is not checked against one.
 */
export async function handoffProblem(handoff, builder, { source = false } = {}) {
  if (!builder && !source) return "its author is not on the roster";
  if (builder && handoff.payout?.account_id !== builder.nearAccount) {
    return `its payout account is not ${builder.nearAccount}, its author's roster account`;
  }
  const unpinned = pinProblem(handoff);
  if (unpinned) return unpinned;
  if (handoff.deliverable) {
    // A link that is no comment's, or a comment since deleted, can never be
    // read: it refuses the handoff like any other problem, where a throw would
    // abort the whole coordinator cycle on one claimant's comment. A read that
    // fails for any other reason still throws, to be tried again.
    if (!/#issuecomment-\d+$/.test(String(handoff.deliverable.url ?? ""))) return "the deliverable it pins is not a link to a comment";
    let pinned;
    try {
      pinned = await commentAt(handoff.deliverable.url);
    } catch (error) {
      if (String(error.message).includes(": 404 ")) return "the deliverable comment it pins no longer exists";
      throw error;
    }
    if (digest(pinned.body) !== handoff.deliverable.sha256) return "the deliverable it pins was edited after the handoff";
  }
  return null;
}

/**
 * Why a comment meant as a handoff (a line opens a ```handoff block, or it
 * starts with **Handoff:**) cannot be read, or null when it reads or is not
 * one. GitHub displays an unclosed block anyway, so the author sees nothing
 * wrong. A ```handoff mentioned in prose, or indented as code, opens no block.
 */
export function unreadableHandoff(body) {
  if (fenced(body, "handoff")) return null;
  const opening = /^ {0,3}```handoff/m.exec(body);
  if (!opening) return /^\*\*Handoff:\*\*/m.test(body) ? "it has no ```` ```handoff ```` block" : null;
  const start = opening.index;
  const firstLine = body.indexOf("\n", start);
  const close = firstLine === -1 ? -1 : body.indexOf("\n```", firstLine);
  if (close === -1) return "its handoff block is never closed: add a line with just ```` ``` ```` after the final `}`";
  try {
    JSON.parse(body.slice(firstLine + 1, close));
  } catch (error) {
    return `its handoff block is not valid JSON (${error.message})`;
  }
  return "its handoff block needs ```` ```handoff ```` alone on its first line and ```` ``` ```` alone on its last";
}

export const isClaim = comment => /^\/claim\b/i.test(comment.body.trim());

export async function swapLabel(number, from, to) {
  await github("POST", `/issues/${number}/labels`, { labels: [to] });
  await github("DELETE", `/issues/${number}/labels/${encodeURIComponent(from)}`).catch(error => {
    if (!String(error.message).includes(": 404")) throw error;
  });
}

export { comments };
