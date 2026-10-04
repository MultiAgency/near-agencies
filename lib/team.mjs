// A job's team: checking a team draft, and turning it into tasks. Shared by
// assemble.mjs (an owner at a terminal) and the coordinator's `/approve` (an
// owner on the board).
//
// Each task is an issue with a fixed payout in its ```terms block. The job
// lists its tasks in a ```team block and a `## Team` checklist, and stays
// `blocked` until they are done. A task may name earlier tasks in `depends_on`
// (by `key`): it then lists them as `- [ ] #N` and starts `blocked`, not `ready`.
// A code task may name the repository it delivers against in `repo`; one that
// names none delivers against near-agencies.
import { REPOS } from "../agents/claude-worker/repos.mjs";
import { fence, fenced, github } from "./github.mjs";
import { USDC } from "./near.mjs";
import { SKILLS } from "./onboarding.mjs";

const usdc = amount => Number(amount) / 1e6;

/** Why this team cannot be assembled for the job, or null. */
export function teamProblem(job, issues) {
  const engagement = fenced(job.body, "engagement");
  if (!engagement) return `#${job.number} is not a job`;
  if (job.state !== "open") return `#${job.number} is closed`;
  if (fenced(job.body, "team")) return `#${job.number} already has a team`;
  if (!Array.isArray(issues) || issues.length === 0) return "the team has no tasks";
  const keys = new Set();
  let committed = 0n;
  for (const [i, spec] of issues.entries()) {
    const name = typeof spec.key === "string" ? spec.key : `task ${i + 1}`;
    if (!/^[a-z0-9-]+$/.test(spec.key ?? "")) return `${name} needs a key of lowercase letters, digits and hyphens`;
    if (keys.has(spec.key)) return `two tasks share the key ${spec.key}`;
    if (!spec.title?.trim()) return `${name} has no title`;
    if (!spec.body?.trim()) return `${name} has no body saying what to deliver`;
    if (!/^[1-9]\d*$/.test(String(spec.amount))) return `${name}'s amount must be a whole number of USDC base units`;
    const labels = spec.labels ?? [];
    const skills = labels.filter(l => l.startsWith("skill:"));
    if (skills.length !== 1 || !SKILLS.includes(skills[0].slice(6))) {
      return `${name} needs exactly one of ${SKILLS.map(s => `skill:${s}`).join(", ")}`;
    }
    if (labels.includes("agent-eligible") === labels.includes("human-only")) return `${name} needs exactly one of agent-eligible and human-only`;
    const unknown = labels.filter(l => !l.startsWith("skill:") && l !== "agent-eligible" && l !== "human-only");
    if (unknown.length) return `${name} has labels a team does not set: ${unknown.join(", ")}`;
    if (spec.repo !== undefined) {
      if (skills[0] !== "skill:code") return `${name} names a repo, which only a skill:code task delivers against`;
      if (!Object.hasOwn(REPOS, spec.repo)) return `${name}'s repo must be one of ${Object.keys(REPOS).join(", ")}`;
    }
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
  const numbers = new Map();
  const team = [];
  for (const spec of issues) {
    const terms = { engagement: job.number, key: spec.key, amount: spec.amount, asset: USDC, ...(spec.repo ? { repo: spec.repo } : {}) };
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
      ...team.map(({ issue: n, amount }) => `- [ ] #${n} — ${usdc(amount)} USDC`),
      "",
      fence("team", { committed: committed.toString(), members: team.map(({ title, ...member }) => member) }),
    ].join("\n"),
  });
  return { team, committed };
}
