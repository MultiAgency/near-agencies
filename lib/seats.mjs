// Seats are the kanban issues of an engagement: each carries a ```terms block
// (engagement, amount) and may depend on earlier seats via `- [ ] #N` lines.
import { commentAt, comments, digest, fenced, github } from "./github.mjs";

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
 */
export function eligibility(seat, builder) {
  if (!builder) return "not on the MultiAgency roster";
  if (seat.labels.includes("human-only") && builder.kind !== "human") return "this task is human-only";
  if (builder.kind === "agent" && !seat.labels.includes("agent-eligible")) return "this task is not agent-eligible";
  return null;
}

/** A handoff that links a deliverable comment must pin it: an optional pin protects nothing. */
export const pinProblem = handoff => !handoff.deliverable && (handoff.links ?? []).some(url => url.includes("#issuecomment-"))
  ? "it links a deliverable comment without pinning its sha256"
  : null;

/**
 * Why a handoff cannot close its seat, or null: the checks payouts make, paid
 * to its author's roster account, with any deliverable pinned and unedited.
 */
export async function handoffProblem(handoff, builder) {
  if (!builder) return "its author is not on the roster";
  if (handoff.payout?.account_id !== builder.nearAccount) {
    return `its payout account is not ${builder.nearAccount}, its author's roster account`;
  }
  const unpinned = pinProblem(handoff);
  if (unpinned) return unpinned;
  if (handoff.deliverable && digest((await commentAt(handoff.deliverable.url)).body) !== handoff.deliverable.sha256) {
    return "the deliverable it pins was edited after the handoff";
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
