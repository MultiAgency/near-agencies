// The board's open tasks across every job, for the site's task list. Which
// tasks a roster member can claim comes from the same eligibility() and skills
// match their status page uses (lib/status.mjs).
import { byGithub, covers } from "./roster.mjs";
import { eligibility } from "./seats.mjs";
import { isGithubLogin } from "./status.mjs";

// What a task is waiting on: someone has claimed it, it can be claimed now, or
// it is blocked behind earlier tasks.
const stateOf = s => s.assignees.length ? "in-progress" : s.labels.includes("ready") ? "ready" : "blocked";

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

/** The open tasks from `seats`, each with its job, state and who it is for. */
export const taskList = seats => seats.map(entry);

/**
 * The same list for one login: each task also says whether they can claim it
 * now (`claimable`), whether their declared skills cover it (`matches`), and
 * when they cannot, why (`reason`). A login that is not on the roster claims
 * nothing.
 */
export function taskListFor(seats, login) {
  const member = byGithub(login);
  return seats.map(s => {
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
