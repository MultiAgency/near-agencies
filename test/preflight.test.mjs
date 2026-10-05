import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { probeDelivery, gitEnv } from "../agents/claude-worker/preflight.mjs";
import { GIT_CREDENTIAL_HELPER } from "../agents/claude-worker/code-mode.mjs";
import { codeRepo } from "../agents/claude-worker/repos.mjs";

// The near-agencies registry entry the probes run against, and the login
// whose credentials (through gh, holding GH_TOKEN) the delivery would use.
const near = codeRepo({});
const login = "near-builder";

// Git's own answers, as the real probes met them on github.com: the denied
// push is the 403 every wasted run of #115 ended at, word for word.
const DENIED_PUSH =
  "remote: Permission to MultiAgency/near-agencies.git denied to near-builder.\n" +
  "fatal: unable to access 'https://github.com/MultiAgency/near-agencies.git/': The requested URL returned error: 403";
const AUTH_FAILED =
  "fatal: Authentication failed for 'https://github.com/MultiAgency/near-agencies.git/'";
const NO_HOST = "fatal: Could not resolve host: github.com";
const NO_FORK = "fatal: repository 'https://github.com/near-builder/near-agencies.git/' not found";
const OUTAGE = "fatal: unable to access 'https://github.com/MultiAgency/near-agencies.git/': The requested URL returned error: 502";
const RATE_LIMIT = "fatal: unable to access 'https://github.com/MultiAgency/near-agencies.git/': The requested URL returned error: 429";
const DEAD_TOKEN = "gh: HTTP 401: Bad credentials (https://api.github.com/user)";

// The name of the git step a call represents: ls-remote is keyed by the URL
// it reads (fork and upstream are two probes), `remote add` is two words,
// every other subcommand by its name.
const stepOf = args => (args[0] === "ls-remote" ? `ls-remote ${args[1]}` : args[0] === "remote" ? "remote add" : args[0]);

// The injected git (and gh): every command the probe runs is recorded, and
// each one answers from `plan` — null for success, a string for the stderr
// of a failure.
const gitRunner = plan => {
  const calls = [];
  const run = async (file, args, opts) => {
    assert.equal(["git", "gh"].includes(file), true);
    calls.push({ file, args, opts });
    const key = stepOf(args);
    if (!(key in plan)) throw new Error(`unexpected ${file} ${args.join(" ")}`);
    const step = plan[key];
    if (step) {
      const error = new Error(`${file} failed`);
      error.stderr = step;
      throw error;
    }
    return { stdout: "", stderr: "" };
  };
  run.calls = calls;
  return run;
};

const ran = calls => calls.map(c => `${c.file} ${stepOf(c.args)}`);

// The git steps a passing probe runs besides its ls-remote: the scratch
// repository's init, its one empty commit, the remote, the dry-run push.
const HAPPY_PATH = { init: null, commit: null, "remote add": null, push: null };

describe("the delivery preflight, branch mode", () => {
  test("credentials that can read and push pass, probing exactly the delivery's git path", async () => {
    const git = gitRunner({
      ...HAPPY_PATH,
      "ls-remote https://github.com/MultiAgency/near-agencies.git": null,
    });
    const found = await probeDelivery({ access: "branch", repo: near, login, run: git });
    assert.deepEqual(found, { ok: true });
    assert.deepEqual(ran(git.calls), [
      "git ls-remote https://github.com/MultiAgency/near-agencies.git",
      "git init", "git commit", "git remote add", "git push",
    ]);
    const push = git.calls.at(-1);
    assert.equal(push.args[0], "push");
    assert.deepEqual(push.args.slice(1), ["--dry-run", "origin", "HEAD:refs/heads/preflight-probe"],
      "the dry-run negotiates the update and sends nothing: no ref is ever created");
    assert.equal(push.opts.cwd.startsWith("/"), true, "the scratch commit is made in its own directory");
    // The probe authenticates exactly as the delivery does: gh holding
    // GH_TOKEN, beside a clean git config, prompts off.
    assert.equal(push.opts.env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(push.opts.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(push.opts.env.GIT_CONFIG_KEY_0, "credential.https://github.com.helper");
    assert.equal(push.opts.env.GIT_CONFIG_VALUE_0, GIT_CREDENTIAL_HELPER);
    assert.equal(push.opts.env.GIT_CONFIG_KEY_1, "commit.gpgsign", "no operator's signing setup takes part");
    assert.equal(push.opts.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(push.opts.env.GIT_AUTHOR_NAME, login);
    assert.equal(push.opts.env.GIT_AUTHOR_EMAIL, `${login}@users.noreply.github.com`);
    assert.equal(push.opts.timeout, 60_000, "a hung probe must not hang the run");
    const commit = git.calls.find(c => c.args[0] === "commit");
    assert.equal(commit.args.includes("--allow-empty"), true, "the scratch commit carries nothing");
  });

  test("credentials that read but cannot push fail the push probe with git's own answer", async () => {
    const git = gitRunner({
      ...HAPPY_PATH,
      "ls-remote https://github.com/MultiAgency/near-agencies.git": null,
      push: DENIED_PUSH,
    });
    const found = await probeDelivery({ access: "branch", repo: near, login, run: git });
    assert.equal(found.ok, false);
    assert.equal(found.step, "push");
    assert.equal(found.status, "403");
    assert.match(found.detail, /returned error: 403/);
    assert.equal(found.detail.includes("\n"), false, "the detail is one line, for a comment");
  });

  test("credentials that cannot even read the repository fail before any push is attempted", async () => {
    const git = gitRunner({ "ls-remote https://github.com/MultiAgency/near-agencies.git": AUTH_FAILED });
    const found = await probeDelivery({ access: "branch", repo: near, login, run: git });
    assert.equal(found.ok, false);
    assert.equal(found.step, "read");
    assert.equal(found.status, "401");
    assert.equal(ran(git.calls).includes("git push"), false);
  });

  test("a failure that says nothing about permissions stays inconclusive", async () => {
    const git = gitRunner({ "ls-remote https://github.com/MultiAgency/near-agencies.git": NO_HOST });
    const found = await probeDelivery({ access: "branch", repo: near, login, run: git });
    assert.equal(found.ok, false);
    assert.equal(found.step, "read");
    assert.equal(found.status, null, "a network blip must not read as a denied token");
    assert.match(found.detail, /Could not resolve host/);
  });

  test("GitHub having a bad minute is not a denied token: 5xx and 429 stay inconclusive", async () => {
    for (const stderr of [OUTAGE, RATE_LIMIT]) {
      const git = gitRunner({
        ...HAPPY_PATH,
        "ls-remote https://github.com/MultiAgency/near-agencies.git": null,
        push: stderr,
      });
      const found = await probeDelivery({ access: "branch", repo: near, login, run: git });
      assert.equal(found.ok, false);
      assert.equal(found.step, "push");
      assert.equal(found.status, null, `${stderr}: an outage or a rate limit must not post a false blocker`);
    }
  });

  test("git's one-line answer is fit for a comment: backticks gone, length capped", async () => {
    const long = "fatal: " + "x".repeat(400);
    const git = gitRunner({ "ls-remote https://github.com/MultiAgency/near-agencies.git": "fatal: a `quoted` word" });
    const found = await probeDelivery({ access: "branch", repo: near, login, run: git });
    assert.equal(found.detail.includes("`"), false);
    const git2 = gitRunner({ "ls-remote https://github.com/MultiAgency/near-agencies.git": long });
    const found2 = await probeDelivery({ access: "branch", repo: near, login, run: git2 });
    assert.equal(found2.detail.length <= 200, true);
  });
});

describe("the delivery preflight, fork mode", () => {
  const forkPlan = {
    ...HAPPY_PATH,
    [`ls-remote https://github.com/${login}/near-agencies.git`]: null,
    "ls-remote https://github.com/MultiAgency/near-agencies.git": null,
  };

  test("an existing fork the token can push passes, and the upstream is never probed", async () => {
    const git = gitRunner({ ...forkPlan });
    const found = await probeDelivery({ access: "fork", repo: near, login, run: git });
    assert.deepEqual(found, { ok: true });
    assert.deepEqual(ran(git.calls), [
      `git ls-remote https://github.com/${login}/near-agencies.git`,
      "git init", "git commit", "git remote add", "git push",
    ], "the push probe targets the fork the delivery would push");
    assert.equal(git.calls.at(-1).args[2], "origin");
  });

  test("a fork that does not exist yet passes when the token answers and the repository is readable", async () => {
    const git = gitRunner({
      ...forkPlan,
      api: null,
      [`ls-remote https://github.com/${login}/near-agencies.git`]: NO_FORK,
    });
    const found = await probeDelivery({ access: "fork", repo: near, login, run: git });
    assert.deepEqual(found, { ok: true }, "the delivery's own first step creates the fork");
    assert.deepEqual(ran(git.calls), [
      `git ls-remote https://github.com/${login}/near-agencies.git`,
      "gh api",
      "git ls-remote https://github.com/MultiAgency/near-agencies.git",
    ], "the token answers gh directly: a public repository reads anonymously");
    assert.equal(ran(git.calls).includes("git push"), false);
  });

  test("a fork that does not exist and a dead token fail before the repository is even read", async () => {
    const git = gitRunner({
      ...forkPlan,
      api: DEAD_TOKEN,
      [`ls-remote https://github.com/${login}/near-agencies.git`]: NO_FORK,
    });
    const found = await probeDelivery({ access: "fork", repo: near, login, run: git });
    assert.equal(found.ok, false);
    assert.equal(found.step, "read");
    assert.equal(found.status, "401");
  });

  test("a fork that does not exist and an unreadable repository fail the read", async () => {
    const git = gitRunner({
      ...forkPlan,
      api: null,
      [`ls-remote https://github.com/${login}/near-agencies.git`]: NO_FORK,
      "ls-remote https://github.com/MultiAgency/near-agencies.git": AUTH_FAILED,
    });
    const found = await probeDelivery({ access: "fork", repo: near, login, run: git });
    assert.equal(found.ok, false);
    assert.equal(found.step, "read");
    assert.equal(found.status, "401");
  });

  test("gh's spent rate limit says HTTP 403 and is not a denied token", async () => {
    const git = gitRunner({
      api: "gh: HTTP 403: API rate limit exceeded for 203.0.113.7. (https://api.github.com/search/...)",
      [`ls-remote https://github.com/${login}/near-agencies.git`]: NO_FORK,
    });
    const found = await probeDelivery({ access: "fork", repo: near, login, run: git });
    assert.equal(found.ok, false);
    assert.equal(found.status, null, "a spent rate limit must not read as a denied token");
    assert.match(found.detail, /rate limit/);
  });

  test("a fork that exists but rejects the push fails the push probe", async () => {
    const git = gitRunner({ ...forkPlan, push: DENIED_PUSH });
    const found = await probeDelivery({ access: "fork", repo: near, login, run: git });
    assert.equal(found.ok, false);
    assert.equal(found.step, "push");
    assert.equal(found.status, "403");
  });
});

describe("the git environment has one definition", () => {
  test("worker.mjs assigns the probe's gitEnv before selecting a task", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../agents/claude-worker/worker.mjs", import.meta.url), "utf8");
    assert.match(source, /^if \(codeMode\) Object\.assign\(process\.env, gitEnv\(login\)\);$/m);
    assert.equal(source.includes("GIT_CONFIG_NOSYSTEM"), false, "the environment is not copied a second time");
  });

  test("it carries the credential helper, a clean config and the agent's identity", () => {
    const env = gitEnv(login);
    assert.equal(env.GIT_CONFIG_VALUE_0, GIT_CREDENTIAL_HELPER);
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(env.GIT_CONFIG_KEY_1, "commit.gpgsign");
    assert.equal(env.GIT_CONFIG_VALUE_1, "false");
    assert.equal(env.GIT_AUTHOR_NAME, login);
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  });
});
