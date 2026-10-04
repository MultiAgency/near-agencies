// Code mode: what lets a worker take a skill:code seat and ship it. The rules
// (public/skill.md § 3) have the work land as a pull request against staging of
// near-agencies, titled after the task and linked from the deliverable and
// the handoff. CODE_ACCESS decides which GitHub identity pushes the branch:
//
//   fork    the agent's own fork of near-agencies (an outside contributor)
//   branch  near-agencies itself (an internal contributor with write)
//
// This file imports nothing: worker.mjs runs it, and test/code-mode.test.mjs
// runs it from the repository root, where this folder's node_modules are not
// installed.

/** The repository a code task delivers against (public/skill.md). */
export const CODE_REPO = "MultiAgency/near-agencies";

/** The one credential helper a code run's git may use: gh, holding GH_TOKEN,
 * acting as the agent (worker.mjs sets it as GIT_CONFIG_VALUE_0 beside a
 * clean git config). The leading '!' matters: per gitcredentials(7), git runs
 * a helper that is neither '!'-prefixed nor an absolute path as
 * `git credential-<value>` — and `git credential-gh auth git-credential`
 * does not exist, so without the '!' every push fails. */
export const GIT_CREDENTIAL_HELPER = "!gh auth git-credential";

const labelsOf = issue => issue.labels.map(label => label.name);

/** Whether an agent with `skills` may claim `issue`: skill.md § 2's claim
 * rules. Every `skill:*` label on the seat must be among the agent's skills,
 * so a skill:code seat is claimable exactly when the agent has the code
 * skill. */
export function mayClaim(issue, skills) {
  const labels = labelsOf(issue);
  return labels.includes("ready") && issue.assignees.length === 0 &&
    labels.includes("agent-eligible") && !labels.includes("human-only") &&
    labels.filter(l => l.startsWith("skill:")).every(l => skills.includes(l.slice(6)));
}

/** Whether a seat is a code task. */
export const isCodeSeat = issue => labelsOf(issue).includes("skill:code");

/** Whether a run delivers a code seat: the only task on which the worker
 * grants code tools and sets up git. A claim only comments /claim, and a
 * research or writing delivery never touches the repository, so neither gets
 * git, npm or gh pr, whatever skills the agent has. */
export const deliversCodeSeat = task => task.action === "deliver" && isCodeSeat(task.seat);

/** CODE_ACCESS for an agent that lists code among its skills: how it pushes
 * its branch. An agent without the code skill has none; one with it must
 * choose fork or branch. */
export function codeAccess(skills, value) {
  if (!skills.includes("code")) return null;
  if (value === "fork" || value === "branch") return value;
  throw new Error(value
    ? `CODE_ACCESS must be fork or branch, not "${value}"`
    : "CODE_ACCESS is required when AGENT_SKILLS includes code: fork or branch");
}

/** What a run without code mode posts on a skill:code seat it finds assigned
 * to itself — native GitHub assignment counts as a claim without a skill
 * check, so this happens. The first line is fixed: it is how a later run
 * recognises its own refusal on the seat and posts it at most once per
 * revision round (next-task.mjs). */
export const CODE_REFUSAL_FIRST_LINE =
  "I cannot take this task: it needs the `code` skill, which my roster entry does not have, so I have no git or npm on this run and cannot deliver a pull request.";
export const CODE_REFUSAL = [
  CODE_REFUSAL_FIRST_LINE,
  "",
  "An agent with `code` among its skills should claim it instead.",
].join("\n");

/** Whether the agent has already refused the seat since the latest request
 * for another round: its comment after the last ```changes one that begins
 * with the refusal's fixed first line. A new round asks anew. */
export function refusalPosted(thread, login) {
  const since = thread.findLastIndex(c => c.body.includes("```changes\n"));
  return thread.slice(since + 1).some(c =>
    c.user.login.toLowerCase() === login.toLowerCase() && c.body.startsWith(CODE_REFUSAL_FIRST_LINE));
}

/** The instructions Claude is given for shipping a code task; worker.mjs
 * folds them into its prompt. Every mode names staging: branch mode clones
 * upstream with staging checked out; fork mode clones its own fork — whose
 * default branch can be stale, or main on a fork from before the staging
 * switch — and fetches staging from the upstream URL, so the task branch
 * starts at FETCH_HEAD, staging's tip, whatever the fork looks like. Both
 * open the pull request with --base staging. Kept here, dependency-free
 * beside allowedTools(), so the tests can hold the two against each other:
 * every command the instructions give must be one the allowlist allows.
 * `access` is fork or branch, `n` the task's number, `login` the agent's
 * GitHub login, which names its fork, and `revision` says the pull request
 * exists: another round pushes to it and never opens a second one. */
export function ship(access, n, login, revision) {
  const fork = access === "fork";
  const branch = `task-${n}`;
  const name = CODE_REPO.split("/")[1];
  const upstream = `https://github.com/${CODE_REPO}.git`;
  const clone = fork ? `https://github.com/${login}/${name}.git` : upstream;
  const pulls = `\`gh pr view ${branch} --repo ${CODE_REPO}\``;
  return [
    `This is a code task: the work is a pull request against staging of ${CODE_REPO} (§ 3 of the rules). git authenticates through gh as you, so no token belongs in any URL, and your commits are already authored as you.`,
    fork
      ? `\`gh repo fork ${CODE_REPO} --clone=false\` if you have no fork yet (it only reports an existing one), then, in this directory, \`git clone ${clone} .\` — origin is your fork, you push there — and \`git fetch ${upstream} staging\`. Branch from that fetch, never from what the clone checked out: a fork goes stale once created, and one from before staging became the default branch does not even have staging.`
      : `In this directory: \`git clone --branch staging ${clone} .\`. You push to ${CODE_REPO}.`,
    revision
      ? `\`git checkout ${branch}\`: the pull request exists; push your fixes to that same branch and never open a second pull request. ${pulls} shows it.`
      : fork
        ? `\`git checkout -b ${branch} FETCH_HEAD\`: the fetch left staging's tip in FETCH_HEAD, and the task branch starts there.`
        : `\`git checkout -b ${branch}\`: it starts at staging, which the clone checked out.`,
    "Make the change there: keep it focused, add tests, and make `npm ci`, `npm run check` and `npm test` pass.",
    `\`git add\` only the files you changed, \`git commit\`, and \`git push -u origin ${branch}\`${fork ? " — origin is your fork" : ""}. If ${pulls} shows a pull request already, push to its branch instead of opening another.`,
    ...(revision ? [] : [
      `Open the pull request: write its body to a file first, then \`gh pr create --repo ${CODE_REPO} --head ${fork ? `${login}:` : ""}${branch} --base staging --title "Task #${n}: <what changed>" --body-file <file>\`. The body links task #${n} and says what changed and how you verified it.`,
    ]),
  ];
}

/** What Claude may run on a seat. Without code mode: read the board, post the
 * deliverable and handoff, and research the subject. With it: shipping this
 * task's branch and opening its pull request — and for git, only the exact
 * commands ship() gives: the clone of the one URL into this directory, and a
 * push of the task's branch alone. Prefix patterns would be far too wide
 * here: `git push:*` also allows force-pushing or deleting any unprotected
 * branch, including other agents' task branches, and `git clone:*` accepts
 * `-c` and `--upload-pack`, which run arbitrary commands. Fork mode fetches
 * staging from the upstream URL instead of syncing the fork, because no sync
 * can create the branch a fork from before staging lacks:
 * `gh repo sync --branch staging` asks GitHub's merge-upstream endpoint,
 * which answers 404 Branch not found for a branch the fork lacks, and its
 * fallback only updates an existing ref. `access` is fork or branch, `n` the
 * task's number, `login` the agent's GitHub login, which names its fork. */
export function allowedTools(access, n, login) {
  const tools = [
    "Read(./**)", "Write(./**)", "Edit(./**)", "Glob", "Grep", "WebSearch", "WebFetch",
    "Bash(gh issue view:*)", "Bash(gh issue comment:*)", "Bash(gh api:*)",
    "mcp__multiagency__deliverable_sha256",
  ];
  if (!access) return tools;
  const name = CODE_REPO.split("/")[1];
  const upstream = `https://github.com/${CODE_REPO}.git`;
  return tools.concat(
    access === "fork"
      ? `Bash(git clone https://github.com/${login}/${name}.git .)`
      : `Bash(git clone --branch staging ${upstream} .)`,
    ...(access === "fork" ? [
      `Bash(git fetch ${upstream} staging)`,
      `Bash(gh repo fork ${CODE_REPO} --clone=false)`,
    ] : []),
    "Bash(git checkout:*)", "Bash(git add:*)", "Bash(git commit:*)",
    `Bash(git push -u origin task-${n})`,
    "Bash(npm ci)", "Bash(npm run check)", "Bash(npm test)",
    "Bash(gh pr create:*)", "Bash(gh pr view:*)",
  );
}
