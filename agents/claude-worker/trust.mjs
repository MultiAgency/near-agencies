// Who the board credits with a ```changes round on a seat: the bot or an
// owner — the authorship rule every block the coordinator acts on follows
// (AGENTS.md), applied there by lib/github.mjs's isTrusted. The worker runs
// as the agent, not as the bot, so the bot's login arrives as configuration
// and an owner's role is looked up through the same injected github(). This
// file imports nothing: worker.mjs runs it, and the repository's tests run it
// from the root, where this folder's node_modules are not installed.

/** Repository roles whose holder may route change requests, as lib/github.mjs reads them. */
export const OWNER_ROLES = ["admin", "maintain"];

/** The board role of `login`: what the owner half of the rule reads, or null
 * when GitHub answers that it has none — a login that is not a collaborator
 * on the board. worker.mjs probes the bot's role once per run, so a mistyped
 * BOARD_BOT or a token that cannot read roles is on the log before any round
 * depends on it. */
export const boardRole = (github, login) =>
  github(`/collaborators/${encodeURIComponent(login)}/permission`).then(
    p => p.role_name,
    error => {
      // A login that is not a collaborator has no role (lib/github.mjs).
      if (String(error.message).endsWith(": 404")) return null;
      throw error;
    },
  );

/** Whether a ```changes comment by `login` opens a revision round: the bot's
 * own, or an owner's (admin or maintain on the board). Logins compare
 * case-insensitively: GitHub logins are not case-sensitive, and the bot's
 * login arrives from a human-edited setting, not from the API. A failed role
 * lookup reads as not trusted — it can only lose an owner's round, never the
 * bot's, and the harm this check exists to prevent is acting on a round
 * twice, not missing one. A lookup refused with 403 — a token that cannot
 * read board roles at all, as an Issues-only one cannot — is the exception:
 * fail-closed there strands an owner's direct round, which the coordinator
 * counts and waits on, with the worker skipping the seat on every run. So
 * the 403 reads as trusted — the rule this check replaced, whose cost (a
 * stranger's block counts too) the README and the run log state. */
export function trustCheck({ github, bot }) {
  if (!bot) throw new Error("trustCheck: the board bot's login (BOARD_BOT) is required");
  // Roles are kept for the run's life; a failed lookup is not kept, so the
  // next comment asks again. A non-403 failure is logged once per login: a
  // board outage would otherwise silently unseat every owner's round. The
  // 403 is the token's own defect, the same for every login, so it is
  // logged once for the run.
  const roles = new Map();
  const warned = new Set();
  let unscoped = false;
  const roleOf = login => boardRole(github, login);
  return async login => {
    if (login.toLowerCase() === bot.toLowerCase()) return true;
    if (!roles.has(login)) {
      const role = roleOf(login);
      roles.set(login, role.then(r => OWNER_ROLES.includes(r)));
      role.catch(error => {
        roles.delete(login);
        if (String(error.message).endsWith(": 403")) {
          if (!unscoped) {
            unscoped = true;
            console.error(`worker: this token cannot read board roles (403): ${"```"}changes rounds count from any author, not just the bot's and an owner's — see agents/claude-worker/README.md`);
          }
          return;
        }
        if (!warned.has(login)) {
          warned.add(login);
          console.error(`worker: cannot read @${login}'s role on the board (${error.message}) — until this works, only the bot's ${"```"}changes rounds count`);
        }
      });
    }
    return roles.get(login).catch(error => String(error.message).endsWith(": 403"));
  };
}

/** The index of the thread's latest ```changes comment the board credits —
 * the bot's or an owner's — or -1: the boundary of the current revision
 * round, the one the coordinator's routedRequests finds (lib/coordinator.mjs).
 * `trusted` is trustCheck's answer for a login. */
export async function latestChangesRound(thread, trusted) {
  for (let i = thread.length - 1; i >= 0; i--) {
    if (thread[i].body.includes("```changes\n") && await trusted(thread[i].user.login)) return i;
  }
  return -1;
}
