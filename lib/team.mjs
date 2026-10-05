// A job's team: checking a team draft, and turning it into tasks. Shared by
// assemble.mjs (an owner at a terminal) and the coordinator's `/approve` (an
// owner on the board).
//
// Each task is an issue with a fixed payout in its ```terms block; an amount
// of zero makes it a volunteer task, which is coordinated but never paid. The
// job lists its tasks in a ```team block and a `## Team` checklist, and stays
// `blocked` until they are done. A task may name earlier tasks in `depends_on`
// (by `key`): it then lists them as `- [ ] #N` and starts `blocked`, not `ready`.
import { fence, fenced, github } from "./github.mjs";
import { REPOS } from "../agents/claude-worker/repos.mjs";
import { USDC } from "./near.mjs";
import { SKILLS } from "./onboarding.mjs";

const usdc = amount => Number(amount) / 1e6;

/** Whether a task carries no payout: a volunteer task's amount is zero. */
export const isVolunteer = task => BigInt(task.amount) === 0n;

/** Why this team cannot be assembled for the job, or null. */
export function teamProblem(job, issues) {
  const engagement = fenced(job.body, "engagement");
  if (!engagement) return `#${job.number} is not a job`;
  if (job.state !== "open") return `#${job.number} is closed`;
  if (fenced(job.body, "team")) return `#${job.number} already has a team`;
  // The repository a job names must be a registry name, exactly
  // (agents/claude-worker/repos.mjs); absent, every task defaults to near-agencies.
  if (engagement.repo !== undefined && (typeof engagement.repo !== "string" || !Object.hasOwn(REPOS, engagement.repo))) {
    return `the job names ${engagement.repo}, which is not a repository code tasks deliver against`;
  }
  if (!Array.isArray(issues) || issues.length === 0) return "the team has no tasks";
  const keys = new Set();
  let committed = 0n;
  for (const [i, spec] of issues.entries()) {
    const name = typeof spec.key === "string" ? spec.key : `task ${i + 1}`;
    if (!/^[a-z0-9-]+$/.test(spec.key ?? "")) return `${name} needs a key of lowercase letters, digits and hyphens`;
    if (keys.has(spec.key)) return `two tasks share the key ${spec.key}`;
    if (!spec.title?.trim()) return `${name} has no title`;
    if (!spec.body?.trim()) return `${name} has no body saying what to deliver`;
    // Zero is a volunteer task; anything else pays and must be a whole number of base units.
    if (!/^(?:0|[1-9]\d*)$/.test(String(spec.amount))) return `${name}'s amount must be a whole number of USDC base units`;
    const labels = spec.labels ?? [];
    const skills = labels.filter(l => l.startsWith("skill:"));
    if (skills.length !== 1 || !SKILLS.includes(skills[0].slice(6))) {
      return `${name} needs exactly one of ${SKILLS.map(s => `skill:${s}`).join(", ")}`;
    }
    if (labels.includes("agent-eligible") === labels.includes("human-only")) return `${name} needs exactly one of agent-eligible and human-only`;
    const unknown = labels.filter(l => !l.startsWith("skill:") && l !== "agent-eligible" && l !== "human-only");
    if (unknown.length) return `${name} has labels a team does not set: ${unknown.join(", ")}`;
    const later = (spec.depends_on ?? []).find(key => !keys.has(key));
    if (later) return `${name} depends on ${later}, which is not an earlier task`;
    keys.add(spec.key);
    committed += BigInt(spec.amount);
  }
  const deposit = BigInt(engagement.deposit.amount);
  if (committed > deposit) return `the tasks pay ${usdc(committed)} USDC, more than the ${usdc(deposit)} USDC deposit`;
  return null;
}

/** Tasks already made for this job, by key: an interrupted run's, so a rerun makes only the rest. */
export function tasksMade(issues, jobNumber) {
  const made = new Map();
  for (const i of issues) {
    const terms = !i.pull_request && fenced(i.body ?? "", "terms");
    if (terms?.engagement === jobNumber && terms.key) made.set(terms.key, i.number);
  }
  return made;
}

/** Create the job's tasks and record the team on the job. Check teamProblem first. */
export async function assembleTeam(job, issues) {
  // Every task is created after the job, so it was updated since then too.
  const made = tasksMade(await github("GET", `/issues?state=all&since=${job.created_at}&per_page=100`), job.number);
  // The repository the job names: it goes into the ```terms of every skill:code
  // task, and nowhere else. A job that named none writes no repo, and those
  // tasks behave as they always did — near-agencies' (agents/claude-worker/repos.mjs).
  const engagement = fenced(job.body, "engagement");
  const repo = engagement?.repo;
  // The registry issue an auto job builds rides along the same way, so the
  // cycle can tell its tasks apart from every other seat without reading the
  // epic: such a task's handoff alone closes nothing (lib/coordinator.mjs).
  const source = engagement?.source;
  const numbers = new Map();
  const team = [];
  for (const spec of issues) {
    const terms = {
      engagement: job.number,
      key: spec.key,
      amount: spec.amount,
      asset: USDC,
      ...(repo && spec.labels.includes("skill:code") ? { repo } : {}),
      ...(source && spec.labels.includes("skill:code") ? { source } : {}),
    };
    const dependsOn = (spec.depends_on ?? []).map(key => numbers.get(key));
    const number = made.get(spec.key) ?? (await github("POST", "/issues", {
      title: spec.title,
      labels: [dependsOn.length ? "blocked" : "ready", ...spec.labels],
      body: [
        `Part of job #${job.number}.`,
        "",
        spec.body,
        ...(dependsOn.length ? ["", "Depends on:", ...dependsOn.map(n => `- [ ] #${n}`)] : []),
        "",
        fence("terms", terms),
      ].join("\n"),
    })).number;
    numbers.set(spec.key, number);
    team.push({ issue: number, title: spec.title, ...terms });
  }
  const committed = team.reduce((sum, { amount }) => sum + BigInt(amount), 0n);
  await github("PATCH", `/issues/${job.number}`, {
    labels: [...job.labels.map(label => label.name), "blocked"],
    body: [
      job.body,
      "",
      "## Team",
      "",
      ...team.map(m => `- [ ] #${m.issue} — ${isVolunteer(m) ? "volunteer" : `${usdc(m.amount)} USDC`}`),
      "",
      fence("team", { committed: committed.toString(), members: team.map(({ title, ...member }) => member) }),
    ].join("\n"),
  });
  return { team, committed };
}
