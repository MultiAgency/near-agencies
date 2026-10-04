// Who the board credits with a ```changes round on a seat: only the
// coordinator. It writes every block a round is owed to — when a reviewer
// asks for another round, the coordinator posts the ```changes block itself
// (lib/coordinator.mjs) — so a block by anyone else, an owner's own
// hand-written one included, is not a round. The worker runs as the agent,
// not as the bot, so the bot's login arrives as configuration (BOARD_BOT).
// This file imports nothing: worker.mjs runs it, and the repository's tests
// run it from the root, where this folder's node_modules are not installed.

/** Whether a ```changes comment by `login` opens a revision round: only the
 * coordinator's own. Logins compare case-insensitively: GitHub logins are
 * not case-sensitive, and the bot's login arrives from a human-edited
 * setting, not from the API. No GitHub read takes part — there is nothing
 * to fail open: whatever the worker's token may or may not read, a
 * stranger's block counts for nothing on it, and an owner's request for
 * another round reaches the seat as the coordinator's own block or not at
 * all. */
export function trustCheck({ bot }) {
  if (!bot) throw new Error("trustCheck: the board bot's login (BOARD_BOT) is required");
  return login => login.toLowerCase() === bot.toLowerCase();
}

/** The index of the thread's latest ```changes comment the board credits —
 * the coordinator's own — or -1: the boundary of the current revision
 * round, the one the coordinator's routedRequests finds (lib/coordinator.mjs).
 * `trusted` is trustCheck's answer for a login. */
export function latestChangesRound(thread, trusted) {
  for (let i = thread.length - 1; i >= 0; i--) {
    if (thread[i].body.includes("```changes\n") && trusted(thread[i].user.login)) return i;
  }
  return -1;
}
