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

// The Claude Code settings worker.mjs passes to query(). Without them the
// SDK adds its own attribution to commits (a Co-Authored-By trailer, which a
// squash merge keeps) and to pull request bodies, and AGENTS.md allows
// neither: the change's own description only. An empty string hides each
// (#141). settingSources stays [], so nothing else reaches the run.
export const SDK_SETTINGS = { attribution: { commit: "", pr: "" } };

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

/** What a run posts on an assigned skill:code seat whose delivery preflight
 * failed (preflight.mjs): before any model turn is spent, the run checks
 * with its own credentials that the pull request the work needs can land —
 * a branch-mode token without Contents write answers 403 at the push, and
 * the run must say so instead of doing the work it could never ship (#115).
 * The fixed first line is how a later run recognises its own blocker and
 * skips the seat for the current round without probing again
 * (blockerStands); the body names the repository and git's own answer. */
export const DELIVERY_BLOCKED_FIRST_LINE =
  "I cannot take this task: I checked before starting, and this run cannot ship the pull request the work needs.";

const DELIVERY_BLOCKED_RECOVERY =
  "The check is read-only and runs again on a later run once this round changes, or once a comment this agent did not write arrives here: an owner who has fixed the token can just say so on the task.";

/** The blocker for credentials that cannot read the repository a clone or
 * fork would start from. */
export const deliveryBlockedRead = (repoName, detail) =>
  [
    DELIVERY_BLOCKED_FIRST_LINE,
    "",
    `The preflight ran before any work: with this run's own credentials, \`git ls-remote\` cannot read ${repoName} (\`${detail}\`). There is no clone or fork to work from, so the run spends no model turns on the task.`,
    "",
    DELIVERY_BLOCKED_RECOVERY,
  ].join("\n");

/** The blocker for credentials that read the repository but cannot push the
 * branch — the 403 every wasted run of #115 ended at. */
export const deliveryBlockedPush = (repoName, detail) =>
  [
    DELIVERY_BLOCKED_FIRST_LINE,
    "",
    `The preflight ran before any work: with this run's own credentials, git reads ${repoName}, but a dry-run push of a scratch branch does not land (\`${detail}\`). Every run on this task would end the same way at \`git push\`, so the run spends no model turns on it.`,
    "",
    DELIVERY_BLOCKED_RECOVERY,
  ].join("\n");

/** What a run posts on a seat it hands back instead of leaving to the next
 * cron run: its attempts are spent — the last two runs saved no new work, or
 * five unfinished runs on one round (#169). The fixed first line is how a
 * later run recognises the hand-back and leaves the seat alone for the rest
 * of the round (next-task.mjs reads it through refusalPosted, the same
 * once-per-round match the refusals use). The comment must never look like a
 * handoff to the coordinator: a ```handoff block by the assignee closes the
 * seat and holds its claim (lib/coordinator.mjs, closeIfHandedOff and
 * releaseIfStale), and #166 makes a passing handoff the only thing that
 * holds one — a hand-back that read as a handoff would hold the very claim
 * it is giving up. So: prose only, no fenced block, no `**Handoff:**`. The
 * worker does not unassign itself either: a seat in progress with no
 * assignee reads as mid-release and refuses new claims until the
 * coordinator's stale sweep reopens it. */
export const HAND_BACK_FIRST_LINE =
  "Handing this task back unfinished: my runs on it could not reach a delivery.";

/** The hand-back for a run whose save could not be pushed: its work is lost,
 * and every later run would lose its work the same way and be paid for again,
 * so the task goes back after the first one (#169). Same first line as any
 * hand-back, so task selection skips the seat for the rest of the round; the
 * push's own error is quoted, since it says what to fix. A refusal for
 * workflow files means the fork's base branch is behind the upstream one:
 * syncing the fork fixes it, and no token needs the workflow permission. */
export const saveFailedComment = ({ n, branch, remote, error }) =>
  [
    HAND_BACK_FIRST_LINE,
    "",
    `My last run on it stopped unfinished, and pushing its work to \`${branch}\` on ${remote} failed, so that run's work is lost. Every later run would end the same way, so I'm stopping here. The push said:`,
    "",
    ...String(error ?? "").trimEnd().split("\n").map(l => `> ${l}`),
    "",
    "If it refused to create or update a workflow, the fork's base branch is behind the upstream one: sync the fork (GitHub's **Sync fork** button), and the next run can save.",
    "",
    `The task is still assigned to me until the coordinator's stale release reopens it.`,
  ].join("\n");

export const handBackComment = ({ n, branch, remote, reason, note }) =>
  [
    HAND_BACK_FIRST_LINE,
    "",
    `${reason} The work so far is not thrown away: my unfinished runs saved it to the branch \`${branch}\` on ${remote}, and the last run's note there reads:`,
    "",
    ...String(note ?? "").trimEnd().split("\n").map(l => `> ${l}`),
    "",
    `The task is still assigned to me until the coordinator's stale release reopens it; the branch waits there until a run of #${n} delivers and deletes it.`,
  ].join("\n");

/** Whether the agent's own delivery-blocker comment — by its fixed first
 * line — is the seat's latest word: posted since the latest round the board
 * credits, with no later comment by anyone else. While it stands, a later
 * run skips the seat without probing again and without redoing the work,
 * refusalPosted's once-per-round rule. A new round reopens the seat, and so
 * does any comment the agent did not write itself — an owner saying the
 * token is fixed re-arms the preflight without waiting for a coordinator's
 * round. No role lookup takes part: whoever else comments, the cost of the
 * needless re-check is two read-only git calls, and the blocker itself is
 * never posted twice in one round. */
export function blockerStands(thread, login, trusted, firstLine = DELIVERY_BLOCKED_FIRST_LINE) {
  const own = c => c.user.login.toLowerCase() === login.toLowerCase();
  let blocker = -1;
  for (let i = thread.length - 1; i >= 0; i--) {
    if (own(thread[i]) && thread[i].body.startsWith(firstLine)) { blocker = i; break; }
  }
  if (blocker === -1 || blocker <= latestChangesRound(thread, trusted)) return false;
  return !thread.slice(blocker + 1).some(c => !own(c));
}

/** Whether the agent has already refused the seat since the latest request
 * for another round: its comment after the last ```changes one the board
 * credits — the coordinator's own (trust.mjs) — that begins with the
 * refusal's fixed first line. A new round asks anew. */
export async function refusalPosted(thread, login, trusted, firstLine = CODE_REFUSAL_FIRST_LINE) {
  const since = latestChangesRound(thread, trusted);
  return thread.slice(since + 1).some(c =>
    c.user.login.toLowerCase() === login.toLowerCase() && c.body.startsWith(firstLine));
}

// Branch mode's own pull request merges by itself, unless a review task
// waits on it; fork mode's waits for a person.
const autoMerges = (access, reviewed) => access === "branch" && !reviewed;

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
 * agent's GitHub login, which names its fork, `revision` says the pull
 * request exists: another round pushes to it and never opens a second one,
 * and `reviewed` says a review task waits on this one. Branch mode turns on
 * auto-merge only when nothing reviews the task: a reviewer's request for
 * another round must find the pull request still open. */
export function ship(access, repo, n, login, revision, reviewed, resumed = false) {
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
    ...(resumed
      ? [
          // A resumed run finds the clone ready-made: the worker's own code
          // started it at the branch the previous unfinished run saved
          // (resume.mjs), and the prompt carries that run's log and note.
          `The repository is already cloned in this directory, and branch \`${branch}\` is checked out where a previous run of this task stopped: do not clone, fork or fetch, and do not start the work over — continue from what is here.`,
        ]
      : [
          fork
            ? `\`gh repo fork ${repo.name} --clone=false\` if you have no fork yet (it only reports an existing one), then, in this directory, \`git clone ${clone} .\` — origin is your fork, you push there — and \`git fetch ${upstream} ${repo.base}\`: a fork goes stale once created, and one from before ${repo.base} became the default branch does not even have it.`
            : `In this directory: \`git clone --branch ${repo.base} ${clone} .\`. You push to ${repo.name}.`,
          revision
            ? `\`git checkout ${branch}\`: the pull request exists; push your fixes to that same branch and never open a second pull request. ${pulls} shows it.`
            : fork
              ? `\`git checkout -b ${branch} FETCH_HEAD\`: the fetch left ${repo.base}'s tip in FETCH_HEAD, and the task branch starts there.`
              : `\`git checkout -b ${branch}\`: it starts at ${repo.base}, which the clone checked out.`,
        ]),
    `Make the change there: keep it focused, add tests, and make ${pass} pass.`,
    // Checkpoints (#169): a run that stops unfinished leaves its steps behind
    // for the next run, which starts from the branch those commits sit on.
    `Work in steps, and \`git commit\` locally after each one that leaves ${pass} passing: \`git add\` only that step's files — never the \`.board/\` comment drafts — and write the message so it says what the step did and what it has left — a run that stops unfinished leaves its finished steps somewhere the next run can take them up.`,
    `\`git add\` only the files you changed, \`git commit\`, and \`git push -u origin ${branch}\`${fork ? " — origin is your fork" : ""}. Every commit carries part of the change: never an empty or probe commit, and no tool attribution in a commit message or the pull request body (AGENTS.md). If ${pulls} shows a pull request already, push to its branch instead of opening another.`,
    ...(revision ? [] : [
      `Open the pull request: read \`.github/pull_request_template.md\` from this clone, and if it has one, fill in its headings, keeping the task link, before writing the body to a file in \`.board/\`. With no template, write its body to \`.board/\` first so it links task #${n} and says what changed and how you verified it. Then \`gh pr create --repo ${repo.name} --head ${fork ? `${login}:` : ""}${branch} --base ${repo.base} --title "Task #${n}: <what changed>" --body-file .board/<file>\`.`,
      ...(autoMerges(access, reviewed) ? [
        `Then \`gh pr merge ${branch} --repo ${repo.name} --auto --squash\`: it returns at once, and GitHub merges the pull request by itself once the required checks pass and a code owner or the approval gate approves it. You need not wait for it.`,
      ] : []),
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
 * which names its fork, and `reviewed` whether a review task waits on this
 * one (no auto-merge then). */
export function allowedTools(access, repo, n, login, reviewed) {
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
    ...(autoMerges(access, reviewed) ? [`Bash(gh pr merge task-${n} --repo ${repo.name} --auto --squash)`] : []),
  );
}
