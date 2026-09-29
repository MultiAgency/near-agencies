// Operator step: turn an engagement epic into seats (kanban issues) for a
// human-AI team. Each seat carries its payout amount; whoever claims it from the
// roster is paid. The epic lists the seats as `- [ ] #N` dependencies, so it
// stays blocked until the work is done.
// A team entry may name earlier entries in `depends_on` (by `key`): its issue
// then lists them as `- [ ] #N` and starts `blocked` instead of `ready`.
//
//   node assemble.mjs <epic-number> <team.json>
import { readFile } from "node:fs/promises";

import { fence, fenced, github, issue } from "./lib/github.mjs";
import { USDC } from "./lib/near.mjs";

const [epicNumber, teamFile] = process.argv.slice(2);
if (!epicNumber || !teamFile) {
  console.error("usage: node assemble.mjs <epic-number> <team.json>");
  process.exit(64);
}

const epic = await issue(epicNumber);
const engagement = fenced(epic.body, "engagement");
if (!engagement) throw new Error(`#${epicNumber} has no engagement block`);
if (fenced(epic.body, "team")) throw new Error(`#${epicNumber} already has a team`);

const { issues } = JSON.parse(await readFile(teamFile, "utf8"));
const committed = issues.reduce((sum, { amount }) => sum + BigInt(amount), 0n);
if (committed > BigInt(engagement.deposit.amount)) {
  throw new Error(`team payouts ${committed} exceed the ${engagement.deposit.amount} deposit`);
}

const team = [];
const numbers = new Map();
for (const spec of issues) {
  const terms = { engagement: Number(epicNumber), amount: spec.amount, asset: USDC };
  const dependsOn = (spec.depends_on ?? []).map(key => {
    if (!numbers.has(key)) throw new Error(`${spec.key ?? spec.title} depends on unknown or later entry ${key}`);
    return numbers.get(key);
  });
  const child = await github("POST", "/issues", {
    title: spec.title,
    labels: [dependsOn.length ? "blocked" : "ready", ...spec.labels],
    body: [
      `Part of job #${epicNumber}.`,
      "",
      spec.body,
      ...(dependsOn.length ? ["", "Depends on:", ...dependsOn.map(n => `- [ ] #${n}`)] : []),
      "",
      fence("terms", terms),
    ].join("\n"),
  });
  if (spec.key) numbers.set(spec.key, child.number);
  team.push({ issue: child.number, ...terms });
  console.log(`#${child.number} ${spec.title} (${Number(spec.amount) / 1e6} USDC)`);
}

await github("PATCH", `/issues/${epicNumber}`, {
  labels: [...epic.labels.map(label => label.name), "blocked"],
  body: [
    epic.body,
    "",
    "## Team",
    "",
    ...team.map(({ issue: n, amount }) => `- [ ] #${n} — ${Number(amount) / 1e6} USDC`),
    "",
    fence("team", { committed: committed.toString(), members: team }),
  ].join("\n"),
});
console.log(`#${epicNumber}: ${committed} of ${engagement.deposit.amount} committed; epic blocked on ${team.length} issues`);
