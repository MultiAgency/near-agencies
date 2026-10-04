// The repositories a code task may deliver against, and the checks a pull
// request on each must pass before it opens. A task names its repository in
// its ```terms block (lib/team.mjs writes it from the team draft); a task
// whose terms name none is near-agencies', as every task was before tasks
// named one. Every repository's pull requests go against staging.
//
// This file imports nothing: the worker image copies only this folder's
// modules, and lib/team.mjs and lib/payouts.mjs import it from the root.

export const DEFAULT_REPO = "MultiAgency/near-agencies";

export const REPOS = {
  "MultiAgency/near-agencies": { checks: ["npm ci", "npm run check", "npm test"] },
  "MultiAgency/legion-social": {
    // No `cargo fmt --check`: upstream (near-social-kv) is not rustfmt-clean,
    // and formatting the fork would conflict with every upstream rebase.
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

/** The registry entry for a task's terms: { name, checks }. A task naming a
 * repository outside the registry throws: nothing may be shipped there. */
export function codeRepo(terms) {
  const name = repoOf(terms);
  if (!Object.hasOwn(REPOS, name)) throw new Error(`${name} is not a repository code tasks deliver against`);
  return { name, ...REPOS[name] };
}

/** The registry entry for a seat as GitHub's API returns it, from the terms
 * in its body. */
export const seatRepo = issue => codeRepo(JSON.parse(/```terms\n([\s\S]*?)\n```/.exec(issue.body)[1]));
