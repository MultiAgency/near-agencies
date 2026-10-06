// Decide-only report for the ai-review revision sweep (#159): which open
// auto-job tasks are due a round, decided exactly as the coordinator's sweep
// decides it (lib/coordinator.mjs planAutoJobRounds) — from each task's
// handoff, the pull request it links, and the ai-review ledger that pull
// request carries. Reads the board and the pull requests; writes nothing:
// the coordinator alone posts the rounds and the caps.
//
//   node scripts/review-rounds.mjs [--help]
//
// Run it as the token you would run the coordinator with; BOARD_BOT names
// the coordinator's login when that is not the token's own account.
import { planAutoJobRounds } from "../lib/coordinator.mjs";
import { repoUrl } from "../lib/github.mjs";

const usage = `usage: node scripts/review-rounds.mjs

Reports, for every open auto-job task on the board (${repoUrl}), whether
ai-review's ledger on its pull request still holds an Important finding open
at the delivered head — the revision round the coordinator's sweep would
post, or the cap that ends the rounds. Decides only: nothing is written.
BOARD_BOT names the coordinator's login when the token acts as someone else.`;

if (process.argv.includes("--help")) {
  console.log(usage);
  process.exit(0);
}

const board = repoUrl.replace("https://github.com/", "");
const decisions = await planAutoJobRounds();
const due = decisions.filter(d => d.action === "round");
const capped = decisions.filter(d => d.action === "cap");
console.log(`review-rounds: ${decisions.length} open auto-job task(s) on ${board}, deciding only — nothing was written`);
for (const d of decisions) {
  if (d.action === "none") {
    console.log(`${board}#${d.task} — waiting: ${d.why}`);
    continue;
  }
  console.log(`${board}#${d.task} — ${d.action === "cap" ? `AT THE CAP after ${d.rounds} ai-review rounds; a person decides` : `DUE ai-review round ${d.round} of at most 3`} (${d.source}${d.assignees.length ? `, @${d.assignees.join(", @")}` : ""})`);
  console.log(`  pull request ${d.pr} at ${d.head.slice(0, 7)}, ai-review's ledger is for this head${d.action === "cap" ? "" : `, ${d.rounds} round(s) posted already`}`);
  for (const line of d.findings ?? []) console.log(`  ${line}`);
}
console.log(`${due.length} task(s) due a round, ${capped.length} at the cap`);
