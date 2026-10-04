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
// coordinator's network, read through a cache of a few minutes. The newest
// admission of a login wins: an owner's fresh `/admit` beats the registry's
// older copy of that login, and the registry beats the local files' records.
// The local files stay as the fallback, for logins the registry does not have,
// and are the whole roster when REGISTRY_URL is unset. A registry member is
// paid at the account they listed for this network (accounts[network].account),
// never their dashboard identity (nearAccount): the two can differ.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { network } from "./network.mjs";
import { ensureUsdcRegistration, KINDS } from "./onboarding.mjs";

// ROSTER_FILE points tests at a fixture, so the live roster can change freely.
const file = process.env.ROSTER_FILE ?? new URL("../roster.json", import.meta.url);
const admittedFile = process.env.ADMITTED_FILE ??
  join(dirname(fileURLToPath(import.meta.url)), "..", ".data", `roster-admitted.${network.networkId}.json`);
// Where the local records live — the backfill script (scripts/registry-backfill.mjs)
// reads the same two stores, with the same overrides.
export const rosterStoreFiles = { roster: file, admitted: admittedFile };
// The registry's last good read is kept beside the admitted store, so a
// restart starts with the members it had, however long the registry stays
// unreachable afterwards.
const registryFile = join(dirname(admittedFile), `roster-registry.${network.networkId}.json`);

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

// The last good read, already mapped to roster records, with when it landed,
// how many records it dropped, and the failure seen since (if any) for
// /api/health. An outage keeps the copy: members never drop because the
// registry is down.
let registryMembers = [];
let registrySuccessAt = null;
let registryError = null;
let registrySkipped = null;
let reading = null;

// The last good read survives a restart: saved to disk after every good read,
// loaded back when the process starts (with REGISTRY_URL set), so members are
// on the roster from the first cycle even while the registry is down — the
// coordinator's first claim checks run at 20 s, long before a re-read.
function loadRegistryRead() {
  try {
    const saved = JSON.parse(readFileSync(registryFile, "utf8"));
    if (!Array.isArray(saved?.members)) throw new Error("no member list");
    registryMembers = saved.members;
    registrySuccessAt = saved.at ?? null;
    registrySkipped = saved.skipped ?? null;
    rebuild();
    console.log(`roster: registry restored from disk: ${registryMembers.length} admitted on ${network.networkId}`);
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`roster: could not restore the registry's last good read: ${error.message}`);
  }
}

function saveRegistryRead() {
  try {
    mkdirSync(dirname(registryFile), { recursive: true });
    writeFileSync(`${registryFile}.tmp`, `${JSON.stringify({ at: registrySuccessAt, skipped: registrySkipped, members: registryMembers }, null, 2)}\n`);
    renameSync(`${registryFile}.tmp`, registryFile);
  } catch (error) {
    console.error(`roster: could not save the registry's last good read: ${error.message}`);
  }
}

/**
 * A registry Member as a roster record, or null when the registry does not
 * admit them on this coordinator's network, or names no account to pay them
 * at on this network — such a record could only claim work and be paid to
 * `undefined`. A record the registry does not vouch for the way a board
 * admission would is skipped too: an unchecked kind would pass eligibility's
 * gates both ways (kind "Agent" or "bot" could claim work meant for people),
 * and skills must stay an array of strings for the skill:* gates. `kind`,
 * `name`, `skills` and the operator come from the registry; the payout
 * account is the member's account for this network, and `proof` and
 * `admittedAt` the admission that put them on this roster.
 */
function fromRegistry(member) {
  if (typeof member?.githubLogin !== "string" || member.githubLogin === "") {
    console.error("roster: registry member without a githubLogin skipped");
    return null;
  }
  if (!KINDS.includes(member.kind) || !Array.isArray(member.skills) || member.skills.some(s => typeof s !== "string")) {
    console.error(`roster: registry member ${member.githubLogin} has an unknown kind or malformed skills; skipped`);
    return null;
  }
  const admitted = (member.admissions ?? [])
    .filter(a => a?.network === network.networkId && a?.status === "admitted")
    .sort((a, b) => String(a.admittedAt ?? "").localeCompare(String(b.admittedAt ?? "")));
  if (admitted.length === 0) return null;
  const nearAccount = (member.accounts ?? []).find(a => a?.network === network.networkId)?.account;
  if (!nearAccount) {
    console.error(`roster: registry member ${member.githubLogin} names no ${network.networkId} account to be paid at; skipped`);
    return null;
  }
  return {
    github: member.githubLogin,
    name: member.name,
    skills: [...member.skills],
    kind: member.kind,
    operator: member.operatorGithubLogin ?? null,
    nearAccount,
    proof: admitted.at(-1)?.proofUrl,
    admittedAt: admitted.at(-1)?.admittedAt,
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

// Registry payees are registered for USDC the way a board /admit registers a
// new member's account (lib/coordinator.mjs): without the storage
// registration a payout to the account would fail when it is sent.
// ensureUsdcRegistration is idempotent, an account confirmed here is not
// re-checked until the process restarts, and a failed or unconfigurable check
// is tried again on the next read — it never fails the read that queued it.
const usdcChecked = new Set();
let paying = false;
async function registerPayees() {
  if (paying || registryMembers.length === 0) return;
  paying = true;
  try {
    for (const { nearAccount } of registryMembers) {
      if (usdcChecked.has(nearAccount)) continue;
      try {
        const usdc = await ensureUsdcRegistration(nearAccount);
        if (!usdc.problem) usdcChecked.add(nearAccount);
        if (usdc.registered) console.log(`roster: registered ${nearAccount} for testnet USDC`);
        if (usdc.problem) console.error(`roster: ${usdc.problem}`);
      } catch (error) {
        console.error(`roster: USDC registration for ${nearAccount} failed, trying again on the next read: ${error.message}`);
      }
    }
  } finally {
    paying = false;
  }
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
      const records = await readRegistry(url);
      const mapped = records.map(fromRegistry).filter(Boolean);
      registryMembers = mapped;
      registrySkipped = records.length - mapped.length;
      registrySuccessAt = new Date().toISOString();
      registryError = null;
      rebuild();
      saveRegistryRead();
      console.log(`roster: registry read: ${registryMembers.length} admitted on ${network.networkId}${registrySkipped ? `, ${registrySkipped} skipped` : ""}`);
    } catch (error) {
      registryError = { at: new Date().toISOString(), message: error.message };
      console.error(`roster: registry read failed, keeping the last good copy: ${error.message}`);
    } finally {
      reading = null;
    }
    await registerPayees();
  })();
  return reading;
}

// Registry writes retry like reads time out: an unreachable or 5xx-answering
// registry is tried again twice before the write reports as failed. A
// refusal (401, 403, 409) is the registry's answer, not an outage: no retry.
const REGISTRY_WRITE_ATTEMPTS = 3;
const REGISTRY_WRITE_BACKOFF_MS = [500, 1000];

/**
 * The registry's putMember body for an admitted member. Logins go lowercase;
 * `operatorGithubLogin` rides along exactly when the member is an agent (the
 * registry requires it then and refuses it otherwise). `proof` — the join
 * issue's URL — is both the account's proof and the admission's.
 */
export function putMemberBody(builder, { proof, admittedAt }) {
  return { json: {
    githubLogin: githubLogin(builder)?.toLowerCase(),
    network: network.networkId,
    kind: builder.kind,
    ...(builder.kind === "agent" && builder.operator ? { operatorGithubLogin: String(builder.operator).toLowerCase() } : {}),
    ...(builder.name ? { name: builder.name } : {}),
    ...(Array.isArray(builder.skills) ? { skills: [...builder.skills] } : {}),
    account: { account: builder.nearAccount, proof },
    admission: { status: "admitted", proofUrl: proof, admittedAt },
  } };
}

// The write's outcome, for /api/health: the last write that failed (the
// admission always stays on the board's roster) and every overwrite the
// registry reported — name and skills don't lock after a mainnet admission,
// so a write that renames a member there must not go unnoticed.
let registryWriteError = null;
let registryOverwrites = [];

/**
 * Write an admitted member to the shared registry: POST <REGISTRY_URL>/putMember
 * with the registry token. A no-op returning null unless both REGISTRY_URL and
 * REGISTRY_TOKEN are set — a coordinator without a token admits exactly as it
 * did before the registry existed, and reports nothing. Writes are idempotent,
 * so a 5xx (or an unreachable registry) is retried; 401, 403 and 409 are the
 * registry's verdict and stand. Resolves {ok: true, overwritten} with the
 * field names the registry let this write replace, or {ok: false, problem}
 * with its message — never with the token in it. The token is sent only in
 * the request's header; it appears in no log, error or health output.
 */
export async function putMember(builder, { proof, admittedAt = new Date().toISOString(), token = process.env.REGISTRY_TOKEN } = {}) {
  const url = process.env.REGISTRY_URL;
  if (!url || !token) return null;
  const body = putMemberBody(builder, { proof, admittedAt });
  const login = body.json.githubLogin;
  let problem = null;
  for (let attempt = 0; attempt < REGISTRY_WRITE_ATTEMPTS; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, REGISTRY_WRITE_BACKOFF_MS[Math.min(attempt - 1, REGISTRY_WRITE_BACKOFF_MS.length - 1)]));
    try {
      const response = await fetch(`${url.replace(/\/+$/, "")}/putMember`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-registry-token": token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      });
      const reply = await response.json().catch(() => null);
      if (response.ok) {
        // A write retires the last failure of the login it wrote — another
        // member's success says nothing about this one's missing write.
        if (registryWriteError?.login === login) registryWriteError = null;
        const data = reply?.json?.data ?? reply?.json ?? {};
        const overwritten = Array.isArray(data.overwritten) ? data.overwritten.filter(f => typeof f === "string") : [];
        if (overwritten.length) {
          registryOverwrites = [{ at: new Date().toISOString(), login, network: network.networkId, fields: overwritten }, ...registryOverwrites].slice(0, 20);
          console.log(`roster: registry write for ${login} (${network.networkId}) overwrote ${overwritten.join(", ")}`);
        } else {
          console.log(`roster: registry write for ${login}: admitted on ${network.networkId}`);
        }
        return { ok: true, overwritten };
      }
      const message = reply?.json?.message ?? reply?.message ?? response.statusText;
      problem = `registry putMember failed: HTTP ${response.status}${message ? ` — ${message}` : ""}`;
      if (response.status < 500) break;
    } catch (error) {
      problem = `registry putMember failed: ${error.message}`;
    }
  }
  registryWriteError = { at: new Date().toISOString(), login, message: problem };
  console.error(`roster: ${problem} (writing ${login} to ${network.networkId}; the admission stays on the board's roster)`);
  return { ok: false, problem };
}

/** What /api/health reports about the registry, or null with none configured.
 * `skipped` counts the records the last read dropped before the roster — an
 * unknown kind, malformed skills, no account to pay them at here, or an
 * admission that is not this network's; each record problem is logged as it
 * is seen. `last_write_error` is the last putMember that failed after its
 * retries; `overwritten` lists the writes a registry accepted while replacing
 * fields another network's admission had set. */
export const registryHealth = () => process.env.REGISTRY_URL ? {
  url: process.env.REGISTRY_URL,
  members: registryMembers.length,
  skipped: registrySkipped,
  last_success_at: registrySuccessAt,
  last_error: registryError,
  last_write_error: registryWriteError,
  overwritten: registryOverwrites,
} : null;

let syncing = false;

/**
 * Keep the registry merged in: one read now, then one every few minutes, the
 * timer unref'd so it never keeps a process alive on its own. Resolves after
 * the first read (at once with REGISTRY_URL unset), so a caller starting work
 * can await a populated roster. Calling it again changes nothing, and the
 * setting is decided once, at startup: every read still re-checks it, so an
 * unset registry stays a no-op however long the process runs.
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
  for (const record of registryMembers) {
    const key = record.github.toLowerCase();
    merged.set(key, newerAdmission(merged.get(key), record));
  }
  roster.length = 0;
  roster.push(...merged.values());
}

// Which copy of a login stands: the one admitted more recently. Records from
// roster.json, and admitted-store records from before this stamp existed,
// carry no admission time, so the registry's copy stands for them; a board
// admission keeps its place until the registry carries a newer admission of
// its own — an owner's fresh `/admit` is not reverted by a registry read
// that predates it. The registry wins a tie: it is the shared copy.
const admittedAtOf = record => Date.parse(record?.admittedAt ?? "") || 0;
const newerAdmission = (current, registry) =>
  !current || admittedAtOf(current) <= admittedAtOf(registry) ? registry : current;

rebuild();

// With REGISTRY_URL set, the last good read a previous process saved takes
// the roster's registry section before the first live read answers.
if (process.env.REGISTRY_URL) loadRegistryRead();

/** Add or replace a member's record, live at once and kept on disk. The
 * admission time is stamped here, so a later registry read cannot silently
 * revert this admission to the registry's older copy of the login. */
export function admit(record) {
  const stamped = { ...record, admittedAt: new Date().toISOString() };
  const entry = withLogin(stamped);
  const admitted = [...readAdmitted().filter(b => !same(withLogin(b), entry)), stamped];
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
