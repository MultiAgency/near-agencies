// Prepare a task's handoff for its claimant to post: the site pins the
// deliverable and fills in the payout account, then runs the coordinator's own
// checks, so nobody hand-types the JSON or learns of a mistake after posting.
import { commentAt, comments, digest, fence, fenced, issue, repoUrl } from "./github.mjs";
import { byGithub } from "./roster.mjs";
import { handoffProblem, seat as seatOf } from "./seats.mjs";

const PULL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const DELIVERABLE = /^\*\*Deliverable\*\*/;
const missing = error => {
  if (String(error.message).includes(": 404 ")) return null;
  throw error;
};
const lines = value => (Array.isArray(value) ? value : String(value ?? "").split("\n")).map(l => String(l).trim()).filter(Boolean);

/**
 * { comment, problem, deliverable: { url, created_at } } for a task in
 * progress, or { error } saying what to fix in the request. A review task's
 * handoff links the tasks it reviews; any other links and pins its
 * **Deliverable** comment — the claimant's latest since the last round of
 * changes when no link is given — and a code task's also its pull request.
 */
export async function prepareHandoff({ task, deliverable, summary, verification }) {
  const number = Number(task);
  if (!Number.isInteger(number) || number < 1) return { error: "Give the task's number." };
  const found = await issue(number).catch(missing);
  const s = found && seatOf(found);
  if (!s?.terms) return { error: `#${number} is not a task on the board.` };
  if (s.state !== "open" || !s.labels.includes("in-progress")) return { error: `#${number} is not in progress, so there is nothing to hand off.` };
  const login = s.assignees[0];
  const builder = byGithub(login);
  if (!builder) return { error: `#${number}'s claimant @${login} is not on the roster.` };

  const said = String(summary ?? "").trim();
  if (!said || said.includes("\n") || said.length > 200) return { error: "Say what you delivered in one sentence (up to 200 characters)." };
  const checks = lines(verification);
  if (checks.length === 0 || checks.length > 8 || checks.some(l => l.length > 300)) {
    return { error: "Say how a reviewer can check the work: one line per check, up to 8." };
  }

  let links;
  let pinned;
  let chosen;
  if (s.skills.includes("skill:review")) {
    links = s.dependsOn.map(n => `${repoUrl}/issues/${n}`);
  } else {
    const given = String(deliverable ?? "").trim();
    let url;
    let posted;
    if (given) {
      if (!new RegExp(`^${repoUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/issues/${number}#issuecomment-\\d+$`).test(given)) {
        return { error: `The deliverable link must be your **Deliverable** comment on #${number}: copy it from the comment's "…" menu, "Copy link".` };
      }
      posted = await commentAt(given).catch(missing);
      if (!posted) return { error: "That comment was not found." };
      if (posted.user.login !== login) return { error: `That comment is by @${posted.user.login}; the deliverable must be the claimant's, @${login}.` };
      url = given;
    } else {
      // No link: take the claimant's latest **Deliverable** comment since the
      // last ```changes comment, the way the coordinator counts rounds.
      const thread = await comments(number);
      const since = thread.findLastIndex(c => fenced(c.body, "changes"));
      posted = thread.slice(since + 1).findLast(c => c.user.login === login && DELIVERABLE.test(c.body.trimStart()));
      if (!posted) return { error: `Post your work on #${number} as a comment starting **Deliverable** first.` };
      url = posted.html_url;
    }
    if (!DELIVERABLE.test(posted.body.trimStart())) {
      const opening = posted.body.trimStart().split("\n", 1)[0].trim();
      const head = opening.length > 40 ? `${opening.slice(0, 40)}…` : opening;
      return { error: `That link is to your comment starting \`${head}\`. Use the one that starts with **Deliverable**.` };
    }
    const pulls = [...new Set(posted.body.match(PULL) ?? [])];
    if (s.skills.includes("skill:code") && pulls.length === 0) return { error: "A code task's deliverable must link its pull request." };
    links = [...pulls, url];
    pinned = { url, sha256: digest(posted.body) };
    chosen = { url, created_at: posted.created_at };
  }
  const handoff = { links, ...(pinned ? { deliverable: pinned } : {}), verification: checks, payout: { account_id: builder.nearAccount } };
  return {
    task: { number, url: s.url, claimant: login },
    comment: `**Handoff:** ${said}\n\n${fence("handoff", handoff)}`,
    problem: await handoffProblem(handoff, builder),
    ...(chosen ? { deliverable: chosen } : {}),
  };
}
