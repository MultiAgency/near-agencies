// The board's open tasks across every job, for the site's task list. Which
// tasks a roster member can claim comes from the same eligibility() and skills
// match their status page uses (lib/status.mjs).
import { byGithub, covers } from "./roster.mjs";
import { eligibility } from "./seats.mjs";
import { isGithubLogin } from "./status.mjs";

// What a task is waiting on: the status label it wears (#71), which only the
// bot and owners can set — `blocked` behind earlier tasks, `ready` to claim,
// or `in-progress` under a claimant. An assignee beats a stale `ready`:
// settling a claim assigns first and swaps the label in the same pass, so a
// seat wearing both is mid-claim, and no second claim may be invited (this is
// the guard the status page keeps too). And a seat with no status label is not
// a task — the board is public, anyone can open an issue with a ```terms block
// in it. When a swap leaves two labels on a seat for a moment, `in-progress`
// wins — it never invites a claim the seat cannot take.
const STATUS_LABELS = ["in-progress", "ready", "blocked"];
const stateOf = s => {
  const label = STATUS_LABELS.find(label => s.labels.includes(label));
  return label === "ready" && s.assignees.length ? "in-progress" : label;
};
const isTask = s => stateOf(s) !== undefined;

const forWhom = s => s.labels.includes("human-only") ? "people" : s.labels.includes("agent-eligible") ? "people and agents" : "people";

const entry = s => ({
  number: s.number,
  title: s.title,
  url: s.url,
  job: s.terms?.engagement ?? null,
  skills: s.skills,
  state: stateOf(s),
  for: forWhom(s),
  assignee: s.assignees[0] ?? null,
  amount: s.terms?.amount ?? null,
});

/** The open tasks from `seats` — only the status-labelled ones — each with its
 * job, state and who it is for. */
export const taskList = seats => seats.filter(isTask).map(entry);

/**
 * The same list for one login: each task also says whether they can claim it
 * now (`claimable`), whether their declared skills cover it (`matches`), and
 * when they cannot, why (`reason`). A login that is not on the roster claims
 * nothing.
 */
export function taskListFor(seats, login) {
  const member = byGithub(login);
  return seats.filter(isTask).map(s => {
    const reason = eligibility(s, member) ?? (stateOf(s) === "ready" ? null : stateOf(s) === "blocked" ? "this task is waiting on earlier tasks" : "this task is already claimed");
    return { ...entry(s), claimable: reason === null, matches: member ? covers(member, s.skills) : false, ...(reason && { reason }) };
  });
}

/**
 * GET /api/tasks: the open tasks, from `seats` (the cached board read). With
 * `?login=`, the list for that login behind the same login check and `limit`
 * as /api/roster/:login.
 */
export const tasksHandler = (seats, limit) => (request, response, next) => {
  const { login } = request.query;
  if (login === undefined) return seats().then(all => response.json({ tasks: taskList(all) }), next);
  limit(request, response, error => {
    if (error) return next(error);
    if (typeof login !== "string" || !isGithubLogin(login)) return response.status(400).json({ error: "That is not a GitHub login." });
    seats().then(all => response.json({ tasks: taskListFor(all, login) }), next);
  });
};
