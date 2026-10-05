// The delivery preflight: before a code task reaches Claude, this run checks
// with its own credentials that the pull request the work needs can land at
// all (#115, #130). A branch-mode token without Contents write answers 403
// at `git push` — after the model run has spent its turns doing the work —
// and nothing remembered the failure, so every cron run redid it. The probe
// runs the two git reads the delivery itself will run: listing the remote's
// refs (the clone must read the repository) and pushing a scratch commit
// with --dry-run, which negotiates the update with GitHub but sends
// nothing, so no ref is ever created. It reports; next-task.mjs decides —
// a failed check costs the seat one blocker comment and no model turns.
//
// The probes authenticate exactly as the delivery does: through gh, holding
// GH_TOKEN, beside a clean git config (worker.mjs sets the same environment
// for the delivery itself). Only node builtins and code-mode.mjs's
// credential helper are imported, so the repository's tests can run this
// module from the root with the git calls injected.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { GIT_CREDENTIAL_HELPER } from "./code-mode.mjs";

// The scratch branch a dry-run push targets: --dry-run negotiates with the
// remote and reports the update it would make, but sends nothing, so the
// ref is never created. The name says what it is for anyone who sees it.
const PROBE_BRANCH = "preflight-probe";

// A probe that hangs must not hang the run: git answers the credential
// helper and GitHub well inside this on any healthy connection, and a kill
// reads as the inconclusive failure it is.
const TIMEOUT_MS = 60_000;

// The git environment of the probe and of the delivery itself (worker.mjs
// assigns it before selecting a task, so both answer to the same
// credentials): the credential helper the delivery uses, a clean config —
// no system or operator setting (a commit-signing key with a passphrase,
// say) takes part or fails the scratch commit — and prompts off, so a
// credential problem fails instead of waiting for input. One definition:
// the copies drifted apart once already.
export const gitEnv = login => ({
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
  GIT_CONFIG_VALUE_0: GIT_CREDENTIAL_HELPER,
  GIT_CONFIG_KEY_1: "commit.gpgsign",
  GIT_CONFIG_VALUE_1: "false",
  GIT_AUTHOR_NAME: login,
  GIT_AUTHOR_EMAIL: `${login}@users.noreply.github.com`,
  GIT_COMMITTER_NAME: login,
  GIT_COMMITTER_EMAIL: `${login}@users.noreply.github.com`,
  GIT_TERMINAL_PROMPT: "0",
});

// Git's own account of a failed probe, cut to one line for a comment: the
// fatal line carries the verdict and usually the status ("The requested URL
// returned error: 403"), the remote line the server's own words ("Permission
// to … denied to …"), gh's its own ("HTTP 401: Bad credentials"). The token
// never appears in any of them — git authenticates through the helper, never
// the URL — and the line is trimmed and de-backticked before it reaches a
// comment. Only a 401, a 403 or a 404 says something about the credentials
// or the repository: a 5xx or a 429 is GitHub having a bad minute, which
// must not read as a denied token — it reports as inconclusive, and the
// next run probes again. gh answers a spent rate limit with an HTTP 403 of
// its own, which says nothing about the token: a rate limit reads as
// inconclusive too.
const DEFINITIVE_STATUSES = new Set(["401", "403", "404"]);
const failureOf = stderr => {
  const text = String(stderr ?? "");
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const line = lines.find(l => l.startsWith("fatal:"))
    ?? lines.find(l => l.startsWith("remote:"))
    ?? lines.at(-1) ?? "git gave no reason";
  const said = /rate limit/i.test(text) ? null
    : text.match(/returned error: (\d{3})/)?.[1]
    ?? text.match(/HTTP (\d{3})/)?.[1]
    ?? (/Authentication failed/.test(text) ? "401" : null)
    ?? (/ not found/.test(text) ? "404" : null);
  return { status: DEFINITIVE_STATUSES.has(said) ? said : null, detail: line.replaceAll("`", "'").slice(0, 200) };
};

/** Whether this run's credentials can deliver `repo` by `access` (fork or
 * branch, as accessFor decided): the checks answer
 * `{ ok: true }`, or `{ ok: false, step, status, detail }` — `step` is the
 * probe that failed ("read": no clone or fork to work from; "push": the
 * branch could not land), `status` the HTTP status git reported, null when
 * the failure says nothing about permissions (a network blip) and `detail`
 * git's own one-line account of it. Fork mode passes when the fork exists
 * and accepts the push, or when it does not exist yet and the repository
 * itself is readable — creating a fork of a readable public repository is
 * the delivery's own first step. `run` is git's executor, injected so the
 * tests can hold every command this module runs; each call gets a timeout,
 * and its environment carries the credentials beside the caller's PATH. */
export async function probeDelivery({ access, repo, login, run = promisify(execFile) }) {
  const env = { ...process.env, ...gitEnv(login) };
  const upstream = `https://github.com/${repo.name}.git`;

  const read = async url => {
    try {
      await run("git", ["ls-remote", url], { env, timeout: TIMEOUT_MS });
      return null;
    } catch (error) {
      return failureOf(error.stderr);
    }
  };

  // Whether the token itself answers gh: for the fork-mode case with no
  // fork yet, the one path where every other probe can pass anonymously.
  const tokenAlive = async () => {
    try {
      await run("gh", ["api", "user"], { env, timeout: TIMEOUT_MS });
      return null;
    } catch (error) {
      return failureOf(error.stderr);
    }
  };

  // The dry-run push: a scratch repository holding one empty commit, pushed
  // to a branch name nothing will ever hold. The commit's identity is the
  // agent's, as every commit of the delivery's would be.
  const push = async url => {
    const dir = await mkdtemp(join(tmpdir(), "preflight-"));
    try {
      await run("git", ["init"], { cwd: dir, env, timeout: TIMEOUT_MS });
      await run("git", ["commit", "--allow-empty", "--message", "preflight: the delivery check's scratch commit"],
        { cwd: dir, env, timeout: TIMEOUT_MS });
      await run("git", ["remote", "add", "origin", url], { cwd: dir, env, timeout: TIMEOUT_MS });
      await run("git", ["push", "--dry-run", "origin", `HEAD:refs/heads/${PROBE_BRANCH}`],
        { cwd: dir, env, timeout: TIMEOUT_MS });
      return null;
    } catch (error) {
      return failureOf(error.stderr);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  if (access === "fork") {
    const fork = `https://github.com/${login}/${repo.name.split("/")[1]}.git`;
    const forkFailure = await read(fork);
    if (!forkFailure) {
      const pushFailure = await push(fork);
      return pushFailure ? { ok: false, step: "push", ...pushFailure } : { ok: true };
    }
    // No fork yet (or none this token can see): the delivery creates it,
    // which any token of its own that can read the repository can do — but
    // a public repository reads anonymously, so the read probe alone would
    // pass a dead token. The token answers gh directly; this runs before
    // Claude, where the call is the worker's own, not anything the
    // allowlist governs.
    const tokenFailure = await tokenAlive();
    if (tokenFailure) return { ok: false, step: "read", ...tokenFailure };
    const readFailure = await read(upstream);
    return readFailure ? { ok: false, step: "read", ...readFailure } : { ok: true };
  }

  const readFailure = await read(upstream);
  if (readFailure) return { ok: false, step: "read", ...readFailure };
  const pushFailure = await push(upstream);
  return pushFailure ? { ok: false, step: "push", ...pushFailure } : { ok: true };
}
