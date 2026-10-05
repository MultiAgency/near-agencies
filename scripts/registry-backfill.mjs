// One-off backfill: write the members this coordinator already knows — the
// records in roster.json and the admitted store (lib/roster.mjs) — to the
// shared member registry, for this coordinator's network. An owner runs it
// with the registry token in the environment:
//
//   REGISTRY_URL=... REGISTRY_TOKEN=... node scripts/registry-backfill.mjs --dry-run
//   REGISTRY_URL=... REGISTRY_TOKEN=... node scripts/registry-backfill.mjs
//
// Beside the coordinator, both stores are read from its volume. From
// elsewhere — a full clone of this repository, which has what the deployed
// image lacks: roster.json's git history — the run carries a copy of the
// admitted store and names it with --admitted-store <path>, so the commit
// fallback below works for roster.json's entries too. Such a run reads the
// board as its owner rather than as the coordinator, so it names the
// coordinator's login with COORDINATOR_LOGIN: the board's own comments count
// from that account (or, under the coordinator's token, from anyone the
// board trusts).
//
// roster.json holds admissions made on testnet — the network the board has
// run on — so a run for another network writes only that network's admitted
// store (roster-admitted.<network>.json) and names roster.json's records as
// left out. The admitted store lives on the coordinator's volume, not in the
// repository: a run off-host stops until it is given --no-admitted-store to
// go on with roster.json's records only.
//
// What it writes, per the registry's rules:
// - people first — starting with the operators the agents name — then agents;
//   an agent's operator must already be a human member admitted on this network;
// - `kind` on every write, `operatorGithubLogin` exactly when kind is `agent`,
//   logins lowercased;
// - `status: "admitted"` needs a proof and a date: a record with a join issue
//   keeps its join issue URL, and takes its admission date from that issue —
//   the board's own `**Admitted**` comment there, which the coordinator posts
//   as it admits the member and which the roster record it stamps carries —
//   when the record carries no stamp of its own; an older roster.json entry
//   with no join issue uses the GitHub URL of the commit that added it to
//   roster.json as both proofUrl and the account proof, and that commit's
//   date as admittedAt. No signature is ever invented: an entry nothing can
//   prove is reported and skipped, named by the half it lacks — its proof,
//   its admission date, or both;
// - writes carry each record's own admission stamp, so re-running the script
//   produces the same writes — and the registry's putMember is idempotent;
// - a record older than the registry's own admission of that login stays
//   unwritten — writing it would overwrite the newer account, name and
//   skills, and every coordinator reading the registry would pay the old
//   account. The registry must answer a read to know: a real run that
//   cannot read it writes nothing.
//
// The dry run prints every write and checks all of the above before anything
// is written; it needs no token. Nothing here reads or prints the token.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { comments, isTrusted, issue, repoUrl } from "../lib/github.mjs";
import { KINDS } from "../lib/onboarding.mjs";
import { network } from "../lib/network.mjs";
import { putMember, putMemberBody, rosterStoreFiles } from "../lib/roster.mjs";

const dryRun = process.argv.includes("--dry-run");
// A run from a host that does not hold the admitted store may say so on
// purpose: --no-admitted-store proceeds with roster.json's records only, and
// the plan says the store was not read.
const noAdmittedStore = process.argv.includes("--no-admitted-store");
// --admitted-store <path>: the admitted store file to read on this run's
// host, in place of the coordinator's volume. Absent, undefined means the
// flag was not given and null that it was given without a usable path.
const ADMITTED_STORE = "--admitted-store";
const admittedStoreArg = (() => {
  const at = process.argv.indexOf(ADMITTED_STORE);
  if (at !== -1) {
    const value = process.argv[at + 1];
    return value && !value.startsWith("--") ? value : null;
  }
  const inline = process.argv.find(arg => arg.startsWith(`${ADMITTED_STORE}=`));
  if (inline !== undefined) return inline.slice(ADMITTED_STORE.length + 1) || null;
  return undefined;
})();
const REGISTRY_URL = process.env.REGISTRY_URL;

// An account's suffix names its network by convention (.testnet here, .near
// on mainnet; an implicit account has no suffix and belongs to its network by
// construction). roster.json is shared by every network, so a record whose
// account contradicts NEAR_NETWORK must not be written: the registry would
// take it as admitted — and every coordinator of that network would read it
// back as a member to pay — on a network it was never admitted on.
const NETWORK_TLD = { testnet: ".testnet", mainnet: ".near" };

// The network whose admissions the board's local records hold: the board has
// run on testnet, so a backfill for another network writes only that
// network's admitted store and leaves roster.json's records out.
const ROSTER_NETWORK = "testnet";

// --- the local records -------------------------------------------------------

const buildersOf = path => {
  try {
    return JSON.parse(readFileSync(path, "utf8")).builders ?? [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};

const asPath = value => value instanceof URL ? fileURLToPath(value) : value;

const loginOf = builder => builder.links?.github?.replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "").toLowerCase() ?? null;

/**
 * The members to backfill: roster.json's records, overlaid by the admitted
 * store's (a board admission is the newer record of its login) — the same
 * precedence the roster merges by. roster.json holds admissions made on
 * testnet only, so a run for another network leaves its records out — named
 * in the plan, since an implicit account carries no network suffix and the
 * account guard in planWrites could not catch one — and writes only this
 * network's admitted store. That store lives on the coordinator's volume,
 * not in the repository, so it is read strictly: a run off-host that read
 * its absence as empty would drop every board admission and still report a
 * clean run. Records without a GitHub login come back as problems;
 * everything else a write needs is checked in planWrites.
 */
export function loadMembers() {
  const merged = new Map();
  const problems = [];
  const rosterBuilders = buildersOf(asPath(rosterStoreFiles.roster));
  const onRosterNetwork = network.networkId === ROSTER_NETWORK;
  const leftOut = onRosterNetwork ? [] : rosterBuilders.map(builder => loginOf(builder) ?? `an unnamed record (${builder.name ?? "unnamed"})`);
  const store = { path: asPath(admittedStoreArg ?? rosterStoreFiles.admitted), builders: [], skipped: noAdmittedStore, problem: null };
  if (!noAdmittedStore) {
    try {
      store.builders = JSON.parse(readFileSync(store.path, "utf8")).builders ?? [];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      store.problem = `the admitted store is missing: ${store.path} — a run without it would drop every board admission and still report a clean one. Run the backfill where the store lives, or pass --no-admitted-store to proceed with roster.json's records only.`;
    }
  }
  for (const builder of [...(onRosterNetwork ? rosterBuilders : []), ...store.builders]) {
    const login = loginOf(builder);
    if (!login) {
      problems.push(`a record names no GitHub login (${builder.name ?? "unnamed"})`);
      continue;
    }
    merged.set(login, builder);
  }
  return { members: [...merged.values()], problems, leftOut, store };
}

// --- proof from the roster file's own history --------------------------------

const git = (args, options = {}) => execFileSync("git", args, { encoding: "utf8", ...options }).trim();

const gitQuiet = args => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * For each login, the commit that added its entry to roster.json, as a
 * GitHub URL and a date — read out of the local git history of the roster
 * file itself. `for` answers null when git, the repository or the file's
 * history cannot say (the caller then reports the entry as unprovable rather
 * than invent).
 */
export function commitProofs(rosterFile) {
  let root;
  try {
    root = git(["rev-parse", "--show-toplevel"]);
  } catch {
    return { for: () => null, problem: "no git repository here, so no commit proof for roster.json entries" };
  }
  // Both sides canonical: git reports paths through /private/var where macOS
  // hands out /var (one symlink apart, the same place), and relative() would
  // otherwise call the roster file foreign to its own repository.
  const realpath = p => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const rel = relative(realpath(root), realpath(resolve(asPath(rosterFile))));
  if (rel.startsWith("..")) return { for: () => null, problem: `${asPath(rosterFile)} is not in this git repository, so no commit proof for its entries` };
  let slug = null;
  try {
    slug = git(["remote", "get-url", "origin"]).replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
  } catch {
    // A local-only clone: commit dates still work; URLs would be invented.
  }
  // The shallow boundary: the commits whose parents a shallow clone cut off.
  // Such a commit's parentage is unknown here, so it proves nothing — an
  // entry it merely carries must not take the commit's URL and date as proof
  // and stamp, and that false stamp would then outrank newer board
  // admissions in the registry. No shallow file: every unreadable parent
  // belongs to a root commit.
  const shallowFile = (() => {
    try {
      return readFileSync(gitQuiet(["rev-parse", "--git-path", "shallow"]), "utf8");
    } catch {
      return ""; // Not a shallow clone.
    }
  })();
  const cutOff = new Set(shallowFile.split("\n").filter(Boolean));
  const parentOf = sha => {
    try {
      return gitQuiet(["rev-parse", `${sha}~1`]);
    } catch {
      if (!cutOff.has(sha)) return EMPTY_TREE; // The root commit: against the empty tree, everything is new.
      // Cut off by a shallow clone: unknown parentage, nothing credited.
      return null;
    }
  };
  const buildersAt = sha => {
    if (sha === EMPTY_TREE) return [];
    try {
      return JSON.parse(gitQuiet(["show", `${sha}:${rel}`])).builders ?? [];
    } catch {
      return []; // A commit whose tree lacks the file reads as empty.
    }
  };
  const added = new Map(); // login → the first commit whose tree holds the entry
  for (const sha of git(["rev-list", "--reverse", "HEAD", "--", rel]).split("\n").filter(Boolean)) {
    const parent = parentOf(sha);
    const before = parent === null ? null : new Set(buildersAt(parent).map(loginOf));
    for (const builder of buildersAt(sha)) {
      const login = loginOf(builder);
      if (login && before && !before.has(login) && !added.has(login)) added.set(login, sha);
    }
  }
  return {
    for: login => {
      const sha = added.get(login);
      return sha ? { url: slug && `https://github.com/${slug}/commit/${sha}`, date: git(["show", "-s", "--format=%cI", sha]), sha } : null;
    },
    problem: null,
  };
}

// --- the board's record of the admission --------------------------------------

/**
 * The board join issue a record's proof names, if it names one: the issue the
 * coordinator admitted the member through (lib/onboarding.mjs builds it; the
 * coordinator stamps the record with its URL). Anything else — another
 * repository's issue, a pull request, an arbitrary URL — is not one.
 */
export const joinIssueOf = proof => {
  const prefix = `${repoUrl}/issues/`;
  const url = String(proof ?? "");
  return url.startsWith(prefix) && /^\d+$/.test(url.slice(prefix.length)) ? url.slice(prefix.length) : null;
};

/**
 * The board's own voice: the coordinator's login, named with
 * COORDINATOR_LOGIN when this run does not read the board as the
 * coordinator, or anyone isTrusted counts — the token's own account, or an
 * owner of the board.
 */
const boardVoice = login => login && (login === (process.env.COORDINATOR_LOGIN ?? "").trim() || isTrusted(login));

/**
 * The admission a join issue records: the board's own `**Admitted** by …`
 * comment — the coordinator posts it as it admits the member, and the roster
 * record it stamps that same moment carries this time — and when it was
 * posted. Not the issue's close: that waits until the deployed roster
 * carries the member, which can be days after `/admit`, and the joiner who
 * opened the issue can close and reopen it whenever they like. A comment
 * counts only from the board's own voice, so a stranger cannot forge one,
 * and an issue the board cannot answer about throws — the caller reports the
 * record rather than guessing.
 */
export async function joinIssueAdmission(number) {
  const joined = await issue(number);
  const admitted = [];
  for (const comment of await comments(number)) {
    if (/^\*\*Admitted\*\*/.test(String(comment.body ?? "")) && (await boardVoice(comment.user?.login))) admitted.push(comment);
  }
  const admission = admitted.at(-1);
  if (admission) {
    if (!admission.created_at) return { why: "was admitted without a date GitHub reports" };
    return { at: admission.created_at };
  }
  if (joined.state !== "closed") return { why: "is still open and has no admission on it" };
  if (joined.state_reason && joined.state_reason !== "completed") {
    return { why: `was closed as ${joined.state_reason.replaceAll("_", " ")}` };
  }
  return { why: "has no admission the board records" };
}

// --- the plan ----------------------------------------------------------------

/**
 * Turn the members into ordered, checked registry writes. People first — the
 * operators the agents name, then the rest — then agents. Each write carries
 * a proof and an admission stamp: the record's own when it has them, else the
 * stamp from the join issue its proof names, else the commit that added the
 * roster entry. Anything the registry would refuse (no kind or an unknown
 * kind, an agent without its operator among the members, an unprovable entry)
 * is a problem, not a write.
 */
export async function planWrites(members, { commitFor, joinIssueAdmission: admissionOf }) {
  const proofs = new Map(); // login → {value, from}
  const stamps = new Map();
  const problems = [];
  const fallbacks = [];

  const memberByLogin = new Map(members.map(m => [loginOf(m), m]));
  for (const member of members) {
    const login = loginOf(member);
    if (!member.nearAccount) {
      problems.push(`${login}: no ${network.networkId} account to be paid at — not written`);
      continue;
    }
    const elsewhere = Object.entries(NETWORK_TLD).find(([id, tld]) => id !== network.networkId && String(member.nearAccount).endsWith(tld));
    if (elsewhere) {
      problems.push(`${login}: ${member.nearAccount} is a ${elsewhere[0]} account, not ${network.networkId} — not written`);
      continue;
    }
    if (!KINDS.includes(member.kind)) {
      problems.push(`${login}: kind must be one of ${KINDS.join(", ")}`);
      continue;
    }
    // Before the proof: the registry refuses an agent whose operator is not a
    // human member however well the entry itself is proven.
    if (member.kind === "agent") {
      if (!member.operator) {
        problems.push(`${login}: an agent must name its operator's GitHub login`);
        continue;
      }
      const operator = String(member.operator).toLowerCase();
      const operatorRecord = memberByLogin.get(operator);
      if (!operatorRecord) {
        problems.push(`${login}: its operator ${operator} is not among the members, so the registry would refuse it`);
        continue;
      }
      if (operatorRecord.kind !== "human") {
        problems.push(`${login}: its operator ${operator} is not a human member`);
        continue;
      }
    }
    let proof = member.proof ? { value: member.proof, from: "record" } : null;
    let stamp = member.admittedAt ? { value: member.admittedAt, from: "record" } : null;
    // The record's proof names its join issue: the board's own `**Admitted**`
    // comment there is the admission — the coordinator posts it as it admits
    // the member, in the same breath it stamps the roster record — so its
    // time is the admission date a record without its own stamp takes. Where
    // the issue records no admission, no commit is substituted for it — the
    // plan reports the record instead of dating an admission that never
    // happened.
    const joinIssue = proof && !stamp ? joinIssueOf(proof.value) : null;
    if (joinIssue) {
      let admission;
      try {
        admission = await admissionOf(joinIssue);
      } catch (error) {
        problems.push(`${login}: its join issue (#${joinIssue}) could not be read to date the admission (${error.message}) — not written`);
        continue;
      }
      if (!admission.at) {
        problems.push(`${login}: no admission date — its join issue (#${joinIssue}) ${admission.why} — not written`);
        continue;
      }
      stamp = { value: admission.at, from: "join issue", issue: Number(joinIssue) };
    }
    if (!proof || !stamp) {
      const commit = commitFor(login);
      if (!commit) {
        const missing = !proof && !stamp ? "no proof and no admission date on the record" : proof ? "no admission date on the record" : "no proof on the record";
        problems.push(`${login}: ${missing}, and no commit that added it to roster.json — not written`);
        continue;
      }
      if (!proof) {
        if (!commit.url) {
          problems.push(`${login}: no proof on the record, and the commit that added it (${commit.sha.slice(0, 12)}) has no GitHub URL to prove it — not written`);
          continue;
        }
        proof = { value: commit.url, from: "commit" };
        fallbacks.push(`${login}: proof from the commit that added the roster entry (${commit.sha.slice(0, 12)})`);
      }
      if (!stamp) {
        stamp = { value: commit.date, from: "commit" };
        fallbacks.push(`${login}: admittedAt from that commit's date (${commit.date})`);
      }
    }
    proofs.set(login, proof);
    stamps.set(login, stamp);
  }

  // An agent whose operator exists and is human but will not be written (no
  // account, or nothing proves it) would still fail at the registry, so the
  // plan refuses it here rather than presenting the dry run as clean.
  const unwritable = new Set();
  for (const member of members) {
    if (member.kind !== "agent" || !proofs.has(loginOf(member))) continue;
    const operator = String(member.operator).toLowerCase();
    if (!proofs.has(operator)) {
      problems.push(`${loginOf(member)}: its operator ${operator} has no writable record, so the registry would refuse it`);
      unwritable.add(loginOf(member));
    }
  }
  const writable = members.filter(m => proofs.has(loginOf(m)) && !unwritable.has(loginOf(m)));
  const agents = writable.filter(m => m.kind === "agent");
  // An agent's write needs its operator admitted already: operators go first
  // among the people, the rest of the people follow, agents come last. Sort
  // is stable, so within each group the records keep their store order.
  const operatorsFirst = m => agents.some(a => String(a.operator).toLowerCase() === loginOf(m)) ? 0 : 1;
  const people = writable.filter(m => m.kind !== "agent").sort((a, b) => operatorsFirst(a) - operatorsFirst(b));

  const writes = [...people, ...agents].map(member => {
    const login = loginOf(member);
    const proof = proofs.get(login);
    const stamp = stamps.get(login);
    return {
      login,
      member,
      proof,
      admittedAt: stamp,
      body: putMemberBody(member, { proof: proof.value, admittedAt: stamp.value }),
    };
  });
  return { writes, problems, fallbacks };
}

// --- the registry's newer admissions -----------------------------------------

/**
 * The registry's latest admission per login for this network, read the way
 * lib/roster.mjs reads it (a read needs no token). Throws when the registry
 * cannot be read: the caller then writes nothing rather than guessing what a
 * write would overwrite.
 */
async function registryAdmissions(url) {
  const response = await fetch(`${url.replace(/\/+$/, "")}/listMembers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ json: { network: network.networkId, status: "admitted" } }),
    signal: AbortSignal.timeout(10_000),
  });
  const reply = await response.json().catch(() => null);
  if (!response.ok) {
    const message = reply?.json?.message ?? reply?.message ?? response.statusText;
    throw new Error(`registry listMembers failed: HTTP ${response.status}${message ? ` — ${message}` : ""}`);
  }
  const members = reply?.json?.data;
  if (!Array.isArray(members)) throw new Error("registry listMembers returned no member list");
  const admittedAt = new Map(); // login → when its latest admission on this network happened
  for (const member of members) {
    const stamps = (member?.admissions ?? [])
      .filter(a => a?.network === network.networkId && a?.status === "admitted" && a?.admittedAt)
      .map(a => Date.parse(a.admittedAt))
      .filter(Number.isFinite);
    if (stamps.length) admittedAt.set(String(member.githubLogin).toLowerCase(), Math.max(...stamps));
  }
  return admittedAt;
}

// --- the run -----------------------------------------------------------------

const row = write => {
  const { member } = write;
  const who = member.kind === "agent" ? `${member.name} (agent, operator ${member.operator})` : `${member.name} (${member.kind})`;
  const source = stamp => stamp.from === "commit" ? "  (commit fallback)" : stamp.from === "join issue" ? `  (its join issue #${stamp.issue})` : "";
  return `${write.login} — ${who}\n    account ${member.nearAccount}\n    proof ${write.proof.value}${write.proof.from === "commit" ? "  (commit fallback)" : ""}\n    admittedAt ${write.admittedAt.value}${source(write.admittedAt)}\n    skills ${JSON.stringify(member.skills)}`;
};

async function main() {
  console.log(`registry backfill — ${network.networkId}${REGISTRY_URL ? ` → ${REGISTRY_URL.replace(/\/+$/, "")}/putMember` : ""}`);
  if (admittedStoreArg === null) {
    console.error("--admitted-store needs a path: the admitted store file to read on this host.");
    process.exitCode = 1;
    return;
  }
  if (admittedStoreArg !== undefined && noAdmittedStore) {
    console.error("--admitted-store and --no-admitted-store contradict each other: give the store's path, or say this host has none — not both.");
    process.exitCode = 1;
    return;
  }
  if (admittedStoreArg !== undefined) {
    const name = basename(admittedStoreArg);
    const wanted = `roster-admitted.${network.networkId}.json`;
    if (name !== wanted) {
      console.error(`--admitted-store names ${name}, not ${wanted}: the file name is what ties a store to its network, and this run writes ${network.networkId} — a store of another network would write members it never admitted.`);
      process.exitCode = 1;
      return;
    }
  }
  if (!REGISTRY_URL) {
    console.error("REGISTRY_URL is not set: nowhere to write. Set it (and REGISTRY_TOKEN, to write).");
    process.exitCode = 1;
    return;
  }
  const { members, problems, leftOut, store } = loadMembers();
  if (store.problem) {
    console.error(store.problem);
    process.exitCode = 1;
    return;
  }
  console.log(store.skipped
    ? "\nadmitted store: none read — --no-admitted-store, roster.json's records only"
    : `\nadmitted store ${store.path}: ${store.builders.length} record${store.builders.length === 1 ? "" : "s"}`);
  if (leftOut.length) {
    console.log(`\nleft out — roster.json holds admissions made on ${ROSTER_NETWORK}, and this run writes only the ${network.networkId} admitted store:\n  ${leftOut.join("\n  ")}`);
  }
  const commits = commitProofs(rosterStoreFiles.roster);
  if (commits.problem) console.error(`note: ${commits.problem}`);
  const plan = await planWrites(members, { commitFor: commits.for, joinIssueAdmission });
  problems.push(...plan.problems);

  // A write of a local record older than the registry's own admission of that
  // login would overwrite the newer account, name and skills with old ones —
  // and every coordinator reading the registry would then pay the old
  // account. Such records stay unwritten. The registry must be readable to
  // know: a real run that cannot read it writes nothing at all.
  let admittedThere = new Map();
  try {
    admittedThere = await registryAdmissions(REGISTRY_URL);
  } catch (error) {
    if (dryRun) {
      console.error(`note: the registry could not be read to check for newer admissions (${error.message}); these writes are checked against nothing`);
    } else {
      console.error(`the registry could not be read to check for newer admissions (${error.message}) — nothing written; run again when it answers`);
      process.exitCode = 1;
      return;
    }
  }
  const newerThere = plan.writes.filter(write => admittedThere.get(write.login) > Date.parse(write.admittedAt.value));
  const writes = plan.writes.filter(write => !newerThere.includes(write));
  if (newerThere.length) {
    console.log(`\nnot written — the registry already holds a newer admission:\n  ${newerThere.map(write => `${write.login}: the registry admitted them ${new Date(admittedThere.get(write.login)).toISOString()}; the local record's stamp is ${write.admittedAt.value}`).join("\n  ")}`);
  }

  console.log(`\n${writes.length} member${writes.length === 1 ? "" : "s"} to write (people first — the operators agents name first — then agents):\n`);
  for (const [index, write] of writes.entries()) console.log(`${index + 1}. ${row(write)}\n   body ${JSON.stringify(write.body)}`);
  if (plan.fallbacks.length) console.log(`\nUsing the commit fallback (the record itself carries no join issue or stamp):\n  ${plan.fallbacks.join("\n  ")}`);
  if (problems.length) console.log(`\nproblems — not written:\n  ${problems.join("\n  ")}`);

  if (dryRun) {
    console.log(`\ndry run: nothing was written.${problems.length ? ` ${problems.length} problem${problems.length === 1 ? "" : "s"} to fix first.` : ""}`);
    if (problems.length) process.exitCode = 1;
    return;
  }
  if (!process.env.REGISTRY_TOKEN) {
    console.error("\nREGISTRY_TOKEN is not set: the registry would refuse every write (401). Run the dry run, or set the token.");
    process.exitCode = 1;
    return;
  }
  if (problems.length) console.log("\nwriting the members that check out; the problems above stay unwritten");

  let failed = 0;
  for (const write of writes) {
    const outcome = await putMember(write.member, { proof: write.proof.value, admittedAt: write.admittedAt.value });
    if (outcome === null) {
      console.error(`${write.login}: the write was not attempted — REGISTRY_URL or REGISTRY_TOKEN went missing mid-run`);
      failed++;
    } else if (outcome.ok) {
      console.log(`${write.login}: written${outcome.overwritten.length ? ` (the registry overwrote ${outcome.overwritten.join(", ")})` : ""}`);
    } else {
      console.error(`${write.login}: ${outcome.problem}`);
      failed++;
    }
  }
  console.log(`\n${writes.length - failed}/${writes.length} written${failed ? `, ${failed} failed — fix and run again; the writes are idempotent` : ""}`);
  if (failed || problems.length) process.exitCode = 1;
}

// Run only when invoked directly (`node scripts/registry-backfill.mjs`): the
// test imports this file for planWrites, and an import must write nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
