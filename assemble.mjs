// Owner step, from a terminal: turn a job into its team's tasks. On the board,
// an owner does the same by commenting `/approve` under a team draft
// (lib/team.mjs has the rules; lib/coordinator.mjs runs it).
//
//   node assemble.mjs <job-number> <team.json>
import { readFile } from "node:fs/promises";

import { issue } from "./lib/github.mjs";
import { assembleTeam, teamProblem } from "./lib/team.mjs";

const [jobNumber, teamFile] = process.argv.slice(2);
if (!jobNumber || !teamFile) {
  console.error("usage: node assemble.mjs <job-number> <team.json>");
  process.exit(64);
}

const job = await issue(jobNumber);
const { issues } = JSON.parse(await readFile(teamFile, "utf8"));
const problem = teamProblem(job, issues);
if (problem) throw new Error(problem);

const { team, committed } = await assembleTeam(job, issues);
for (const { issue: n, title, amount } of team) console.log(`#${n} ${title} (${Number(amount) / 1e6} USDC)`);
console.log(`#${job.number}: ${committed} committed; job blocked on ${team.length} tasks`);
