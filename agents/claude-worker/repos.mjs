// The repositories a code task may deliver against, and what each demands of
// a pull request there: the branch it bases on, the checks it must pass, and
// the worker image that can build it. A job names its repository on the hire
// form or in POST /engagements; the quote carries it into the job's
// ```engagement block (lib/epic.mjs) and from there into the ```terms of every
// skill:code task (lib/team.mjs). A task whose terms name no repository is
// near-agencies', as every task was before tasks named one. Every
// repository's pull requests go against staging.
//
// This file imports nothing: the worker image copies only this folder's
// modules, and the lib modules that read a task's repository — payouts,
// handoff, team — import it from the root.

export const DEFAULT_REPO = "MultiAgency/near-agencies";

export const REPOS = {
  "MultiAgency/near-agencies": {
    base: "staging",
    image: "node",
    checks: ["npm ci", "npm run check", "npm test"],
  },
  "MultiAgency/legion-social": {
    // No `cargo fmt --check`: upstream (near-social-kv) is not rustfmt-clean,
    // and formatting the fork would conflict with every upstream rebase.
    base: "staging",
    image: "rust",
    checks: [
      "cargo clippy --all-targets -- -D warnings",
      "cargo test",
      "npm --prefix web ci",
      "npm --prefix web run lint",
      "npm --prefix web run typecheck",
      "npm --prefix web test",
    ],
  },
};

/** The repository a task's terms name, defaulting to near-agencies. */
export const repoOf = terms => terms?.repo ?? DEFAULT_REPO;

/** The repositories the intake may name on a job (#100): the ones workers
 * deliver to. Every registry entry is one now that the worker reads a task's
 * repository (#82); a later entry joins this set only when a worker image
 * serves it, so the intake never takes a deposit a delivery would hold. */
export const WORKER_DELIVERS = new Set([DEFAULT_REPO, "MultiAgency/legion-social"]);

/** The registry entry for the repository a task's terms name:
 * { name, base, checks, image }. Everything that needs a task's repository
 * reads it through this one function, so nowhere keeps a second definition.
 * A task naming a repository outside the registry throws: nothing may be
 * shipped there. */
export function codeRepo(terms) {
  const name = repoOf(terms);
  // The type check first: hasOwn would take a one-element array for its joined string.
  if (typeof name !== "string" || !Object.hasOwn(REPOS, name)) throw new Error(`${name} is not a repository code tasks deliver against`);
  return { name, ...REPOS[name] };
}
