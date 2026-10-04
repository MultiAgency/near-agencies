// Code mode: what lets a worker take a skill:code seat and ship it. The rules
// (public/skill.md § 3) have the work land as a pull request against the
// registry's base branch of the repository the task's ```terms name —
// near-agencies' unless they name another (repos.mjs) — titled after the task
// and linked from the deliverable and the handoff. CODE_ACCESS decides which
// GitHub identity pushes the branch, for near-agencies:
//
//   fork    the agent's own fork of near-agencies (an outside contributor)
//   branch  near-agencies itself (an internal contributor with write)
//
// Any other registry repository ships through a fork, whatever CODE_ACCESS
// says (accessFor): the agent is an outside contributor there. A branch-mode
// deployment cannot ship them at all — its token reaches near-agencies only
// (canShip) — so those seats wait for a fork-mode worker.
//
// This file imports nothing but trust.mjs and repos.mjs, which themselves
// import nothing: worker.mjs runs it, and test/code-mode.test.mjs runs it
// from the repository root, where this folder's node_modules are not
// installed.
import { DEFAULT_REPO } from "./repos.mjs";
import { latestChangesRound } from "./trust.mjs";

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

/** A seat's ```terms block, parsed: the first fenced block, JSON — the way
 * lib/github.mjs's fenced() reads it, without lib/github.mjs, which would
 * drag the board token and `gh` into the worker image. Null when the block
 * or its JSON is missing; the registry then reads the default repository. */
export function termsOf(issue) {
  const match = /```terms\n([\s\S]*?)\n```/.exec(issue.body ?? "");
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

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

/** How a run pushes its branch for `repo`, the registry entry it delivers
 * against: CODE_ACCESS names near-agencies' (fork or branch); any other
 * registry repository is a fork, whatever CODE_ACCESS says — the agent is an
 * outside contributor there, and its token holds nothing on the repository. */
export const accessFor = (repo, codeMode) => repo.name === DEFAULT_REPO ? codeMode : "fork";

/** Whether a run can ship `repo` at all: fork mode's classic token reads and
 * writes every public repository, so any registry repository ships through a
 * fork; branch mode's token holds Contents and Pull requests read/write on
 * near-agencies and nothing else (README: Code tasks), so another
 * repository's fork is one it can neither create nor push to. */
export const canShip = (repo, codeMode) => codeMode === "fork" || repo.name === DEFAULT_REPO;

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

/** What a run with code mode posts on an assigned skill:code seat it cannot
 * ship for the repository's sake: the task's terms name a repository outside
 * the registry, which nothing may be shipped to, or one whose toolchain this
 * image lacks (#82). Each has a fixed first line — how a later run recognises
 * its own refusal and posts it at most once per revision round
 * (next-task.mjs) — and one body naming what the seat asked for. */
export const CODE_REPO_REFUSAL_FIRST_LINE =
  "I cannot take this task: its terms name a repository code tasks do not deliver against, so there is no pull request I could open.";
export const codeRepoRefusal = name =>
  [
    CODE_REPO_REFUSAL_FIRST_LINE,
    "",
    `The registry of repositories code tasks deliver against does not hold ${JSON.stringify(name ?? null)}; the job that named it needs re-pointing at one it holds.`,
  ].join("\n");
export const CODE_IMAGE_REFUSAL_FIRST_LINE =
  "I cannot take this task: my worker image does not carry the toolchain its repository's checks need.";
export const codeImageRefusal = (image, toolchain) =>
  [
    CODE_IMAGE_REFUSAL_FIRST_LINE,
    "",
    `Its checks need the \`${image}\` toolchain and this image carries \`${toolchain}\`: a worker whose image has it should take it instead.`,
  ].join("\n");
export const CODE_ACCESS_REFUSAL_FIRST_LINE =
  "I cannot take this task: my CODE_ACCESS=branch token reaches near-agencies only, and this seat names another repository.";
export const codeAccessRefusal = name =>
  [
    CODE_ACCESS_REFUSAL_FIRST_LINE,
    "",
    `Branch mode's token holds Contents and Pull requests read/write on ${DEFAULT_REPO} and nothing else, so it can neither fork ${name} nor push to its fork: a worker whose CODE_ACCESS=fork should take it instead.`,
  ].join("\n");

/** Whether the agent has already refused the seat since the latest request
 * for another round: its comment after the last ```changes one the board
 * credits — the coordinator's own (trust.mjs) — that begins with the
 * refusal's fixed first line. A new round asks anew. */
export async function refusalPosted(thread, login, trusted, firstLine = CODE_REFUSAL_FIRST_LINE) {
  const since = latestChangesRound(thread, trusted);
  return thread.slice(since + 1).some(c =>
    c.user.login.toLowerCase() === login.toLowerCase() && c.body.startsWith(firstLine));
}

/** The instructions Claude is given for shipping a code task; worker.mjs
 * folds them into its prompt. Every mode names the repository's base branch:
 * branch mode clones upstream with it checked out; fork mode clones its own
 * fork — whose default branch can be stale, or main on a fork from before the
 * base became the default — and fetches the base from the upstream URL, so
 * the task branch starts at FETCH_HEAD, the base's tip, whatever the fork
 * looks like. Both open the pull request with --base set to it, and both run
 * exactly the registry's checks for the repository before that. Kept here,
 * dependency-free beside allowedTools(), so the tests can hold the two
 * against each other: every command the instructions give must be one the
 * allowlist allows. `access` is fork or branch (accessFor), `repo` the
 * registry entry the task's terms name, `n` the task's number, `login` the
 * agent's GitHub login, which names its fork, and `revision` says the pull
 * request exists: another round pushes to it and never opens a second one. */
export function ship(access, repo, n, login, revision) {
  const fork = access === "fork";
  const branch = `task-${n}`;
  const name = repo.name.split("/")[1];
  const upstream = `https://github.com/${repo.name}.git`;
  const clone = fork ? `https://github.com/${login}/${name}.git` : upstream;
  const pulls = `\`gh pr view ${branch} --repo ${repo.name}\``;
  const checks = repo.checks.map(c => `\`${c}\``);
  const pass = checks.length > 1
    ? `${checks.slice(0, -1).join(", ")} and ${checks.at(-1)}`
    : checks[0];
  return [
    `This is a code task: the work is a pull request against ${repo.base} of ${repo.name} (§ 3 of the rules). git authenticates through gh as you, so no token belongs in any URL, and your commits are already authored as you.`,
    fork
      ? `\`gh repo fork ${repo.name} --clone=false\` if you have no fork yet (it only reports an existing one), then, in this directory, \`git clone ${clone} .\` — origin is your fork, you push there — and \`git fetch ${upstream} ${repo.base}\`: a fork goes stale once created, and one from before ${repo.base} became the default branch does not even have it.`
      : `In this directory: \`git clone --branch ${repo.base} ${clone} .\`. You push to ${repo.name}.`,
    revision
      ? `\`git checkout ${branch}\`: the pull request exists; push your fixes to that same branch and never open a second pull request. ${pulls} shows it.`
      : fork
        ? `\`git checkout -b ${branch} FETCH_HEAD\`: the fetch left ${repo.base}'s tip in FETCH_HEAD, and the task branch starts there.`
        : `\`git checkout -b ${branch}\`: it starts at ${repo.base}, which the clone checked out.`,
    `Make the change there: keep it focused, add tests, and make ${pass} pass.`,
    `\`git add\` only the files you changed, \`git commit\`, and \`git push -u origin ${branch}\`${fork ? " — origin is your fork" : ""}. If ${pulls} shows a pull request already, push to its branch instead of opening another.`,
    ...(revision ? [] : [
      `Open the pull request: write its body to a file first, then \`gh pr create --repo ${repo.name} --head ${fork ? `${login}:` : ""}${branch} --base ${repo.base} --title "Task #${n}: <what changed>" --body-file <file>\`. The body links task #${n} and says what changed and how you verified it.`,
    ]),
  ];
}

/** What Claude may run on a seat. Without code mode: read the board, post the
 * deliverable and handoff, and research the subject. With it: shipping this
 * task's branch and opening its pull request — and for git, only the exact
 * commands ship() gives: the clone of the one URL into this directory, and a
 * push of the task's branch alone. The registry's checks for the repository
 * are listed exactly as it writes them, with no prefixes: a prefix would run
 * any arguments after the command. Prefix patterns would otherwise be far too
 * wide here: `git push:*` also allows force-pushing or deleting any
 * unprotected branch, including other agents' task branches, and `git
 * clone:*` accepts `-c` and `--upload-pack`, which run arbitrary commands.
 * Fork mode fetches the base branch from the upstream URL instead of syncing
 * the fork, because no sync can create the branch a fork from before the base
 * lacks: `gh repo sync --branch <base>` asks GitHub's merge-upstream
 * endpoint, which answers 404 Branch not found for a branch the fork lacks,
 * and its fallback only updates an existing ref. `gh api` is absent on
 * purpose: it would put every endpoint the token allows — approving a pull
 * request, closing or relabeling an issue, deleting a comment — behind board
 * comments anyone can write, and the one read it was added for, hashing the
 * deliverable, is the worker's own deliverable_sha256 tool (worker.mjs).
 * `access` is fork or branch (accessFor), `repo` the registry entry the
 * task's terms name, `n` the task's number, `login` the agent's GitHub login,
 * which names its fork. */
export function allowedTools(access, repo, n, login) {
  const tools = [
    "Read(./**)", "Write(./**)", "Edit(./**)", "Glob", "Grep", "WebSearch", "WebFetch",
    "Bash(gh issue view:*)", "Bash(gh issue comment:*)",
    "mcp__multiagency__deliverable_sha256",
  ];
  if (!access) return tools;
  const name = repo.name.split("/")[1];
  const upstream = `https://github.com/${repo.name}.git`;
  return tools.concat(
    access === "fork"
      ? `Bash(git clone https://github.com/${login}/${name}.git .)`
      : `Bash(git clone --branch ${repo.base} ${upstream} .)`,
    ...(access === "fork" ? [
      `Bash(git fetch ${upstream} ${repo.base})`,
      `Bash(gh repo fork ${repo.name} --clone=false)`,
    ] : []),
    "Bash(git checkout:*)", "Bash(git add:*)", "Bash(git commit:*)",
    `Bash(git push -u origin task-${n})`,
    ...repo.checks.map(c => `Bash(${c})`),
    "Bash(gh pr create:*)", "Bash(gh pr view:*)",
  );
}
