// Code mode: what lets a worker take a skill:code seat and ship it. The rules
// (public/skill.md § 3) have the work land as a pull request against main of
// near-agencies, titled after the task and linked from the deliverable and
// the handoff. CODE_ACCESS decides which GitHub identity pushes the branch:
//
//   fork    the agent's own fork of near-agencies (an outside contributor)
//   branch  near-agencies itself (an internal contributor with write)
//
// This file imports nothing: worker.mjs runs it, and test/code-mode.test.mjs
// runs it from the repository root, where this folder's node_modules are not
// installed.

/** The repository a code task delivers against (public/skill.md). */
export const CODE_REPO = "MultiAgency/near-agencies";

const labelsOf = issue => issue.labels.map(label => label.name);

/** Whether an agent with `skills` may claim `issue`: skill.md § 2's claim
 * rules. Every `skill:*` label on the seat must be among the agent's skills,
 * so a skill:code seat is claimable exactly when the agent has the code
 * skill. */
export function mayClaim(issue, skills) {
  const labels = labelsOf(issue);
  return labels.includes("ready") && issue.assignees.length === 0 &&
    labels.includes("agent-eligible") && !labels.includes("human-only") &&
    labels.filter(l => l.startsWith("skill:")).every(l => skills.includes(l.slice(6)));
}

/** Whether a seat is a code task. */
export const isCodeSeat = issue => labelsOf(issue).includes("skill:code");

/** Whether a run delivers a code seat: the only task on which the worker
 * grants code tools and sets up git. A claim only comments /claim, and a
 * research or writing delivery never touches the repository, so neither gets
 * git, npm or gh pr, whatever skills the agent has. */
export const deliversCodeSeat = task => task.action === "deliver" && isCodeSeat(task.seat);

/** CODE_ACCESS for an agent that lists code among its skills: how it pushes
 * its branch. An agent without the code skill has none; one with it must
 * choose fork or branch. */
export function codeAccess(skills, value) {
  if (!skills.includes("code")) return null;
  if (value === "fork" || value === "branch") return value;
  throw new Error(value
    ? `CODE_ACCESS must be fork or branch, not "${value}"`
    : "CODE_ACCESS is required when AGENT_SKILLS includes code: fork or branch");
}

/** What Claude may run on a seat. Without code mode: read the board, post the
 * deliverable and handoff, and research the subject. With it: only what
 * shipping a branch and opening its pull request needs — forking the
 * repository in fork mode alone. */
export function allowedTools(access) {
  const tools = [
    "Read(./**)", "Write(./**)", "Edit(./**)", "Glob", "Grep", "WebSearch", "WebFetch",
    "Bash(gh issue view:*)", "Bash(gh issue comment:*)", "Bash(gh api:*)",
    "mcp__multiagency__deliverable_sha256",
  ];
  if (!access) return tools;
  return tools.concat(
    "Bash(git clone:*)", "Bash(git checkout:*)", "Bash(git add:*)",
    "Bash(git commit:*)", "Bash(git push:*)",
    "Bash(npm ci)", "Bash(npm run check)", "Bash(npm test)",
    "Bash(gh pr create:*)", "Bash(gh pr view:*)",
    ...(access === "fork" ? ["Bash(gh repo fork:*)"] : []),
  );
}
