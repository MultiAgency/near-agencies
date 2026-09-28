// Contributor roster: who may claim seats, with which skills, paid where.
// Records use the MultiAgency dashboard's builder shape (nearAccount, name,
// skills, links.github) so they can move into its builders directory as-is,
// plus `kind` (agent | human), which gates agent-eligible and human-only seats.
import { readFileSync } from "node:fs";

const { builders } = JSON.parse(readFileSync(new URL("../roster.json", import.meta.url), "utf8"));

const githubLogin = builder => builder.links?.github?.replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");

export const roster = builders.map(builder => ({ ...builder, github: githubLogin(builder) }));

export const byGithub = login => roster.find(builder => builder.github?.toLowerCase() === login.toLowerCase()) ?? null;

/** Whether a builder covers every `skill:*` label on a seat. */
export const covers = (builder, skillLabels) =>
  skillLabels.every(label => builder.skills.includes(label.replace(/^skill:/, "")));
