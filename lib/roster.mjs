// Contributor roster: who may claim tasks, with which skills, paid where.
// Records use the MultiAgency dashboard's builder shape (nearAccount, name,
// skills, links.github) so they can move into its builders directory as-is,
// plus `kind` (agent | human), which gates agent-eligible and human-only tasks,
// `operator` (an agent's responsible person, by GitHub login),
// and `proof`: the board issue carrying the signed join request (lib/onboarding.mjs).
//
// The roster is roster.json plus the members an owner admitted on the board
// with `/admit` (lib/coordinator.mjs), kept on the server's volume — and, when
// REGISTRY_URL is set, the shared member registry's members admitted on this
// coordinator's network, read through a cache of a few minutes. A later record
// for the same login wins, and the registry wins over the local files: it is
// the one copy every environment shares. The local files stay as the fallback,
// for logins the registry does not have, and are the whole roster when
// REGISTRY_URL is unset. A registry member is paid at the account they listed
// for this network (accounts[network].account), never their dashboard identity
// (nearAccount): the two can differ.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { network } from "./network.mjs";

// ROSTER_FILE points tests at a fixture, so the live roster can change freely.
const file = process.env.ROSTER_FILE ?? new URL("../roster.json", import.meta.url);
const admittedFile = process.env.ADMITTED_FILE ??
  join(dirname(fileURLToPath(import.meta.url)), "..", ".data", `roster-admitted.${network.networkId}.json`);

// The registry is read now and then again every few minutes; a read that
// outlasts its timeout counts as an outage, like any failed read.
const REGISTRY_TTL_MS = 5 * 60_000;
const REGISTRY_TIMEOUT_MS = 10_000;

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

// roster.json, read once as the module loads — the same as it always was, so
// a later problem with the file cannot start failing admit() at runtime.
const base = JSON.parse(readFileSync(file, "utf8")).builders;

// --- the shared member registry ---------------------------------------------

// The last good read, already mapped to roster records, with when it landed
// and the failure seen since (if any) for /api/health. An outage keeps the
// copy: members never drop because the registry is down.
let registryMembers = [];
let registrySuccessAt = null;
let registryError = null;
let reading = null;

/**
 * A registry Member as a roster record, or null when the registry does not
 * admit them on this coordinator's network. `kind`, `name`, `skills` and the
 * operator come from the registry; the payout account is the member's account
 * for this network, and `proof` the admission that put them on this roster.
 */
function fromRegistry(member) {
  if (typeof member?.githubLogin !== "string" || member.githubLogin === "") {
    console.error("roster: registry member without a githubLogin skipped");
    return null;
  }
  const admitted = (member.admissions ?? [])
    .filter(a => a?.network === network.networkId && a?.status === "admitted")
    .sort((a, b) => String(a.admittedAt ?? "").localeCompare(String(b.admittedAt ?? "")));
  if (admitted.length === 0) return null;
  return {
    github: member.githubLogin,
    name: member.name,
    skills: Array.isArray(member.skills) ? [...member.skills] : [],
    kind: member.kind,
    operator: member.operatorGithubLogin ?? null,
    nearAccount: (member.accounts ?? []).find(a => a?.network === network.networkId)?.account,
    proof: admitted.at(-1)?.proofUrl,
  };
}

// One oRPC call: POST <REGISTRY_URL>/<procedure> with {"json": <input>},
// answered {"json": <output>}; an error arrives with its HTTP status as
// {"json": {code, status, message}}. Reads need no token.
async function readRegistry(url) {
  const response = await fetch(`${url.replace(/\/+$/, "")}/listMembers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ json: { network: network.networkId, status: "admitted" } }),
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  const reply = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = reply?.json?.message ?? reply?.message ?? response.statusText;
    throw new Error(`registry listMembers failed: HTTP ${response.status}${problem ? ` — ${problem}` : ""}`);
  }
  const members = reply?.json?.data;
  if (!Array.isArray(members)) throw new Error("registry listMembers returned no member list");
  return members;
}

/**
 * Read the registry once and merge its members into the roster. Unreachable,
 * slow, or answering with an error, the last good copy stays and the failure
 * is recorded for /api/health. A no-op when REGISTRY_URL is unset; calls that
 * overlap share the read in flight.
 */
export function refreshRegistry() {
  const url = process.env.REGISTRY_URL;
  if (!url) return Promise.resolve();
  if (reading) return reading;
  reading = (async () => {
    try {
      registryMembers = (await readRegistry(url)).map(fromRegistry).filter(Boolean);
      registrySuccessAt = new Date().toISOString();
      registryError = null;
      rebuild();
      console.log(`roster: registry read: ${registryMembers.length} admitted on ${network.networkId}`);
    } catch (error) {
      registryError = { at: new Date().toISOString(), message: error.message };
      console.error(`roster: registry read failed, keeping the last good copy: ${error.message}`);
    } finally {
      reading = null;
    }
  })();
  return reading;
}

/** What /api/health reports about the registry, or null with none configured. */
export const registryHealth = () => process.env.REGISTRY_URL ? {
  url: process.env.REGISTRY_URL,
  members: registryMembers.length,
  last_success_at: registrySuccessAt,
  last_error: registryError,
} : null;

let syncing = false;

/**
 * Keep the registry merged in: one read now, then one every few minutes, the
 * timer unref'd so it never keeps a process alive on its own. Resolves after
 * the first read (at once with REGISTRY_URL unset), so a caller starting work
 * can await a populated roster. Calling it again changes nothing.
 */
export async function startRegistrySync() {
  if (syncing || !process.env.REGISTRY_URL) return;
  syncing = true;
  await refreshRegistry();
  setInterval(() => void refreshRegistry(), REGISTRY_TTL_MS).unref();
}

// --- the merged roster ------------------------------------------------------

export const roster = [];

/** The roster as it stands: roster.json, then the admitted store, then the
 * registry — a later copy of a login wins over an earlier one. */
function rebuild() {
  const merged = new Map();
  for (const builder of [...base, ...readAdmitted()].map(withLogin)) {
    merged.set(builder.github?.toLowerCase(), builder);
  }
  for (const record of registryMembers) merged.set(record.github.toLowerCase(), record);
  roster.length = 0;
  roster.push(...merged.values());
}
rebuild();

/** Add or replace a member's record, live at once and kept on disk. */
export function admit(record) {
  const entry = withLogin(record);
  const admitted = [...readAdmitted().filter(b => !same(withLogin(b), entry)), record];
  mkdirSync(dirname(admittedFile), { recursive: true });
  writeFileSync(`${admittedFile}.tmp`, `${JSON.stringify({ builders: admitted }, null, 2)}\n`);
  renameSync(`${admittedFile}.tmp`, admittedFile);
  rebuild();
  return entry;
}

export const byGithub = login => roster.find(builder => builder.github?.toLowerCase() === login.toLowerCase()) ?? null;

/**
 * Whether a verified join request from a member only changes what they declare
 * about themselves (name, skills): same payout account, same kind and operator.
 * That needs no owner; the account's signature already proves it is them.
 */
export const isProfileUpdate = (current, next) =>
  Boolean(current) && current.nearAccount === next.nearAccount && current.kind === next.kind &&
  (current.operator ?? null) === (next.operator ?? null);

/** Whether a builder covers every `skill:*` label on a task. */
export const covers = (builder, skillLabels) =>
  skillLabels.every(label => builder.skills.includes(label.replace(/^skill:/, "")));
