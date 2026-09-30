// Contributor roster: who may claim tasks, with which skills, paid where.
// Records use the MultiAgency dashboard's builder shape (nearAccount, name,
// skills, links.github) so they can move into its builders directory as-is,
// plus `kind` (agent | human), which gates agent-eligible and human-only tasks,
// `operator` (an agent's responsible person, by GitHub login),
// and `proof`: the board issue carrying the signed join request (lib/onboarding.mjs).
//
// The roster is roster.json plus the members an owner admitted on the board
// with `/admit` (lib/coordinator.mjs), kept on the server's volume until the
// roster moves to the dashboard. A later record for the same login wins.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { network } from "./network.mjs";

// ROSTER_FILE points tests at a fixture, so the live roster can change freely.
const file = process.env.ROSTER_FILE ?? new URL("../roster.json", import.meta.url);
const admittedFile = process.env.ADMITTED_FILE ??
  join(dirname(fileURLToPath(import.meta.url)), "..", ".data", `roster-admitted.${network.networkId}.json`);

const githubLogin = builder => builder.links?.github?.replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
const withLogin = builder => ({ ...builder, github: githubLogin(builder) });
const same = (a, b) => a.github?.toLowerCase() === b.github?.toLowerCase();

function readAdmitted() {
  try {
    return JSON.parse(readFileSync(admittedFile, "utf8")).builders;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export const roster = [];
for (const builder of [...JSON.parse(readFileSync(file, "utf8")).builders, ...readAdmitted()].map(withLogin)) {
  const at = roster.findIndex(b => same(b, builder));
  if (at === -1) roster.push(builder);
  else roster[at] = builder;
}

/** Add or replace a member's record, live at once and kept on disk. */
export function admit(record) {
  const entry = withLogin(record);
  const admitted = [...readAdmitted().filter(b => !same(withLogin(b), entry)), record];
  mkdirSync(dirname(admittedFile), { recursive: true });
  writeFileSync(`${admittedFile}.tmp`, `${JSON.stringify({ builders: admitted }, null, 2)}\n`);
  renameSync(`${admittedFile}.tmp`, admittedFile);
  const at = roster.findIndex(b => same(b, entry));
  if (at === -1) roster.push(entry);
  else roster[at] = entry;
  return entry;
}

export const byGithub = login => roster.find(builder => builder.github?.toLowerCase() === login.toLowerCase()) ?? null;

/** Whether a builder covers every `skill:*` label on a task. */
export const covers = (builder, skillLabels) =>
  skillLabels.every(label => builder.skills.includes(label.replace(/^skill:/, "")));
