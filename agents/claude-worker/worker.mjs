// A MultiAgency task worker built on the Claude Agent SDK. It knows nothing
// about MultiAgency's code: each run reads the published skill.md and follows
// it. One run handles at most one task:
//
//   deliver  a task assigned to this agent with no handoff since the last
//            change request: do the work, post the deliverable and handoff
//   claim    otherwise, the first ready task this agent may claim: /claim it
//
// Finding that work is a few GitHub reads; Claude runs only when there is some.
// Run it on a schedule (see README); --dry-run only names the task.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { allowedTools, codeAccess, deliversCodeSeat, CODE_REPO, GIT_CREDENTIAL_HELPER } from "./code-mode.mjs";
import { nextTask as selectTask } from "./next-task.mjs";

const env = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const login = env("AGENT_LOGIN");
const nearAccount = env("NEAR_ACCOUNT");
const skills = env("AGENT_SKILLS").split(",").map(s => s.trim());
// Code mode: how an agent with the code skill ships its branch — "fork" (its
// own fork, an outside contributor) or "branch" (near-agencies itself, an
// internal contributor). Null without the code skill.
const codeMode = codeAccess(skills, process.env.CODE_ACCESS);
const board = process.env.BOARD ?? "MultiAgency/kanban-sandbox";
const skillUrl = process.env.SKILL_URL ?? "https://demo.multiagency.ai/skill.md";
const model = process.env.MODEL ?? "claude-sonnet-5";
const maxBudgetUsd = Number(process.env.MAX_BUDGET_USD ?? "3");
// A house agent sets this so it claims a task only after others have had it
// for a while: it is the fallback that finishes a job, not the first in line.
const claimAfterMs = Number(process.env.CLAIM_AFTER_MINUTES ?? "0") * 60_000;
const dryRun = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
env("GH_TOKEN");
if (!dryRun) env("ANTHROPIC_API_KEY");

async function github(path) {
  const response = await fetch(`https://api.github.com/repos/${board}${path}`, {
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub GET ${path}: ${response.status}`);
  return response.json();
}

// Posts a comment on a seat: the one board write the task selection makes,
// the refusal a run without code mode leaves on an assigned skill:code seat.
async function comment(number, body) {
  const response = await fetch(`https://api.github.com/repos/${board}/issues/${number}/comments`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json" },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) throw new Error(`GitHub POST comment: ${response.status}`);
}

// The selection itself lives in next-task.mjs, which imports nothing: it is
// the one worker module beside code-mode.mjs that the repository's tests can
// run from the root, where this folder's dependencies are not installed.
const nextTask = () =>
  selectTask({ github, comment, login, skills, codeMode, claimAfterMs, dryRun });

// Hashing is the one step easy to get subtly wrong in a shell, so the worker
// provides it as a tool: sha256 of the comment body exactly as GitHub stores it.
const helpers = createSdkMcpServer({
  name: "multiagency",
  tools: [
    tool("deliverable_sha256", "sha256 (hex) of a board comment's body exactly as GitHub stores it, for the handoff's deliverable.sha256.",
      { comment_url: z.string().describe("The deliverable comment URL, ending in #issuecomment-<id>") },
      async ({ comment_url }) => {
        const id = comment_url.match(/#issuecomment-(\d+)$/)?.[1];
        if (!id) return { content: [{ type: "text", text: "Not a comment URL ending in #issuecomment-<id>." }], isError: true };
        const { body } = await github(`/issues/comments/${id}`);
        return { content: [{ type: "text", text: createHash("sha256").update(body).digest("hex") }] };
      }),
  ],
});

// How Claude ships a code task (public/skill.md § 3): the work lands as a
// pull request against main of near-agencies, titled after the task and
// linked from the deliverable and the handoff; a revision round pushes to the
// same pull request.
function ship(n, revision) {
  const fork = codeMode === "fork";
  const branch = `task-${n}`;
  const name = CODE_REPO.split("/")[1];
  const clone = fork ? `https://github.com/${login}/${name}.git` : `https://github.com/${CODE_REPO}.git`;
  const pulls = `\`gh pr view ${branch} --repo ${CODE_REPO}\``;
  return [
    `This is a code task: the work is a pull request against main of ${CODE_REPO} (§ 3 of the rules). git authenticates through gh as you, so no token belongs in any URL, and your commits are already authored as you.`,
    fork
      ? `\`gh repo fork ${CODE_REPO} --clone=false\` if you have no fork yet (it only reports an existing one), then \`gh repo sync ${login}/${name}\` so your fork's default branch is current — a fork goes stale once created — then, in this directory, \`git clone ${clone} .\`. You push to your fork.`
      : `In this directory: \`git clone ${clone} .\`. You push to ${CODE_REPO}.`,
    revision
      ? `\`git checkout ${branch}\`: the pull request exists; push your fixes to that same branch and never open a second pull request. ${pulls} shows it.`
      : `\`git checkout -b ${branch}\`.`,
    "Make the change there: keep it focused, add tests, and make `npm ci`, `npm run check` and `npm test` pass.",
    `\`git add\` only the files you changed, \`git commit\`, and \`git push -u origin ${branch}\`${fork ? " — origin is your fork" : ""}. If ${pulls} shows a pull request already, push to its branch instead of opening another.`,
    ...(revision ? [] : [
      `Open the pull request: write its body to a file first, then \`gh pr create --repo ${CODE_REPO} --head ${fork ? `${login}:` : ""}${branch} --title "Task #${n}: <what changed>" --body-file <file>\`. The body links task #${n} and says what changed and how you verified it.`,
    ]),
  ];
}

function instructions(task) {
  const n = task.seat.number;
  // With code mode off, an assigned skill:code seat cannot be delivered:
  // the shipping steps would name commands the run is not allowed to run.
  const code = Boolean(codeMode) && deliversCodeSeat(task);
  const doing = task.action === "claim"
    ? `Claim task #${n}: comment exactly \`/claim\` on it, then stop. The coordinator assigns it; a later run does the work.`
    : code
      ? [
          `Deliver task #${n}, which is assigned to you.${task.revision ? " The reviewer asked for another round (the latest ```changes comment): address every point in a new deliverable." : ""}`,
          "Read the task, the job it names, and the deliverables of any tasks it depends on. Do the work, citing sources inline as links.",
          ...ship(n, task.revision),
          `Then post the deliverable comment, naming the pull request, get its sha256 with the deliverable_sha256 tool, and post the handoff comment, exactly as the rules say. The coordinator closes the task once the handoff checks out.`,
        ].join("\n")
      : [
          `Deliver task #${n}, which is assigned to you.${task.revision ? " The reviewer asked for another round (the latest ```changes comment): address every point in a new deliverable." : ""}`,
          "Read the task, the job it names, and the deliverables of any tasks it depends on. Do the work, citing sources inline as links.",
          `Then post the deliverable comment, get its sha256 with the deliverable_sha256 tool, and post the handoff comment, exactly as the rules say. The coordinator closes the task once the handoff checks out.`,
        ].join("\n");
  return [
    `You are @${login}, an AI agent on the MultiAgency roster with skills ${skills.join(", ")}. Your roster NEAR account, for payout.account_id, is ${nearAccount}.`,
    "",
    doing,
    "",
    `Use \`gh\` for GitHub; it is authenticated as you. The board is ${board}: pass \`--repo ${board}\`. Write each comment to a file in the current directory first and post it with \`gh issue comment ${n} --repo ${board} --body-file <file>\`, which prints the new comment's URL.`,
    "Work on this one task only. If you cannot do the work, comment on the task saying why, and stop.",
  ].join("\n");
}

async function run() {
  const task = await nextTask();
  if (!task) return console.log("worker: nothing to do");
  console.log(`worker: ${task.action} #${task.seat.number}${task.revision ? " (revision)" : ""}`);
  if (dryRun) return;
  // Only a run with code mode (the agent listed the code skill and chose a
  // CODE_ACCESS) that is delivering a skill:code seat gets the git
  // environment, the shipping instructions and the code tools. A run without
  // code mode never gets here on a skill:code seat: nextTask() refused it
  // once and moved on to what this run can deliver.
  const code = Boolean(codeMode) && deliversCodeSeat(task);
  const skill = await (await fetch(skillUrl)).text();
  const cwd = await mkdtemp(join(tmpdir(), `seat-${task.seat.number}-`));
  try {
    if (code) {
      // git ships the work as the agent: gh (holding GH_TOKEN) is its only
      // credential helper, injected through the environment together with a
      // clean git config so no system or operator setting — a stored keychain
      // entry, say — can answer first or leak another identity into a push.
      // Every commit is authored as the agent, and a failed authentication
      // fails instead of hanging the run waiting for input.
      Object.assign(process.env, {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
        GIT_CONFIG_VALUE_0: GIT_CREDENTIAL_HELPER,
        GIT_AUTHOR_NAME: login,
        GIT_AUTHOR_EMAIL: `${login}@users.noreply.github.com`,
        GIT_COMMITTER_NAME: login,
        GIT_COMMITTER_EMAIL: `${login}@users.noreply.github.com`,
        GIT_TERMINAL_PROMPT: "0",
      });
    }
    for await (const message of query({
      prompt: instructions(task),
      options: {
        cwd,
        model,
        maxBudgetUsd,
        maxTurns: 60,
        settingSources: [],
        systemPrompt: { type: "preset", preset: "claude_code", append: `\n\n# The MultiAgency rules (${skillUrl})\n\n${skill}` },
        mcpServers: { multiagency: helpers },
        tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"],
        permissionMode: "dontAsk",
        allowedTools: allowedTools(code ? codeMode : null, task.seat.number, login),
      },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "tool_use") console.log(`  tool ${block.name} ${JSON.stringify(block.input).slice(0, 160)}`);
        }
      } else if (message.type === "result") {
        console.log(`worker: ${message.subtype} after ${message.num_turns} turns, $${message.total_cost_usd.toFixed(2)}`);
        if (message.subtype === "success") console.log(message.result);
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

await run();
