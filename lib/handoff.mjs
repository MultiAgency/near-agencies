// Prepare a task's handoff for its claimant to post: the site pins the
// deliverable and fills in the payout account, then runs the coordinator's own
// checks, so nobody hand-types the JSON or learns of a mistake after posting.
import { commentAt, digest, fence, issue, repoUrl } from "./github.mjs";
import { byGithub } from "./roster.mjs";
import { handoffProblem, seat as seatOf } from "./seats.mjs";

const PULL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const missing = error => {
  if (String(error.message).includes(": 404 ")) return null;
  throw error;
};
const lines = value => (Array.isArray(value) ? value : String(value ?? "").split("\n")).map(l => String(l).trim()).filter(Boolean);

/**
 * { comment, problem } for a task in progress, or { error } saying what to fix
 * in the request. A review task's handoff links the tasks it reviews; any other
 * links and pins its **Deliverable** comment, and a code task's also its pull request.
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
  if (s.skills.includes("skill:review")) {
    links = s.dependsOn.map(n => `${repoUrl}/issues/${n}`);
  } else {
    const url = String(deliverable ?? "").trim();
    if (!new RegExp(`^${repoUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/issues/${number}#issuecomment-\\d+$`).test(url)) {
      return { error: `The deliverable link must be your **Deliverable** comment on #${number}: copy it from the comment's "…" menu, "Copy link".` };
    }
    const posted = await commentAt(url).catch(missing);
    if (!posted) return { error: "That comment was not found." };
    if (posted.user.login !== login) return { error: `That comment is by @${posted.user.login}; the deliverable must be the claimant's, @${login}.` };
    if (!/^\*\*Deliverable\*\*/.test(posted.body.trimStart())) return { error: "That comment does not start with **Deliverable**." };
    const pulls = [...new Set(posted.body.match(PULL) ?? [])];
    if (s.skills.includes("skill:code") && pulls.length === 0) return { error: "A code task's deliverable must link its pull request." };
    links = [...pulls, url];
    pinned = { url, sha256: digest(posted.body) };
  }
  const handoff = { links, ...(pinned ? { deliverable: pinned } : {}), verification: checks, payout: { account_id: builder.nearAccount } };
  return {
    task: { number, url: s.url, claimant: login },
    comment: `**Handoff:** ${said}\n\n${fence("handoff", handoff)}`,
    problem: await handoffProblem(handoff, builder),
  };
}
