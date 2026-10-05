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

import { accessFor, allowedTools, codeAccess, deliversCodeSeat, ship, termsOf, GIT_CREDENTIAL_HELPER } from "./code-mode.mjs";
import { nextTask as selectTask } from "./next-task.mjs";
import { probeDelivery } from "./preflight.mjs";
import { codeRepo } from "./repos.mjs";

const env = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const login = env("AGENT_LOGIN");
// The board's coordinator bot: a ```changes comment counts as a new revision
// round only when the coordinator wrote it, and every block a round is owed
// to is its own — it posts the block itself when it routes a reviewer's
// request (trust.mjs). Defaults to this deployment's coordinator; set it
// when yours is another account.
const bot = process.env.BOARD_BOT ?? "multi-agency";
const nearAccount = env("NEAR_ACCOUNT");
const skills = env("AGENT_SKILLS").split(",").map(s => s.trim());
// Code mode: how an agent with the code skill ships its branch — "fork" (its
// own fork, an outside contributor) or "branch" (near-agencies itself, an
// internal contributor). Null without the code skill.
const codeMode = codeAccess(skills, process.env.CODE_ACCESS);
// The toolchain this image carries: the Dockerfile sets WORKER_TOOLCHAIN to
// the TOOLCHAIN it was built with (node by default), and the registry's
// image per repository decides which code seats this run may take
// (next-task.mjs).
const toolchain = process.env.WORKER_TOOLCHAIN ?? "node";
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
// git ships a code task's work as the agent: gh (holding GH_TOKEN) is its
// only credential helper, injected through the environment together with a
// clean git config so no system or operator setting — a stored keychain
// entry, say — can answer first or leak another identity into a push. Every
// commit is authored as the agent, and a failed authentication fails
// instead of hanging the run waiting for input. The delivery preflight runs
// under this same environment (next-task.mjs), so the check and the push it
// clears answer to the same credentials.
if (codeMode) {
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

// The selection itself lives in next-task.mjs, which imports nothing but the
// dependency-free code-mode.mjs and trust.mjs: the repository's tests can run
// it from the root, where this folder's dependencies are not installed.
const nextTask = () =>
  selectTask({ github, comment, login, skills, codeMode, bot, claimAfterMs, dryRun, toolchain, probe: probeDelivery });

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

function instructions(task) {
  const n = task.seat.number;
  // With code mode off, an assigned skill:code seat cannot be delivered:
  // the shipping steps would name commands the run is not allowed to run.
  const code = Boolean(codeMode) && deliversCodeSeat(task);
  // The registry entry for the repository this delivery ships to, and how it
  // pushes its branch there: the selection (next-task.mjs) has already
  // refused a code seat this run cannot ship, so this parses.
  const repo = code ? codeRepo(termsOf(task.seat)) : null;
  // The revision sentence names the credited round's comment — the
  // coordinator's own, which nextTask() returns — never "the latest":
  // whatever ```changes block anyone else posted after it must not steer
  // the run.
  const revisionNote = round =>
    round
      ? ` The reviewer asked for another round (the ${"```"}changes comment by @${round.user.login}: ${round.html_url}): address every point in it in a new deliverable.`
      : "";
  const doing = task.action === "claim"
    ? `Claim task #${n}: comment exactly \`/claim\` on it, then stop. The coordinator assigns it; a later run does the work.`
    : code
      ? [
          `Deliver task #${n}, which is assigned to you.${revisionNote(task.round)}`,
          "Read the task, the job it names, and the deliverables of any tasks it depends on. Do the work, citing sources inline as links.",
          ...ship(accessFor(repo, codeMode), repo, n, login, task.revision, task.reviewed),
          `Then post the deliverable comment, naming the pull request, get its sha256 with the deliverable_sha256 tool, and post the handoff comment, exactly as the rules say. The coordinator closes the task once the handoff checks out.`,
        ].join("\n")
      : [
          `Deliver task #${n}, which is assigned to you.${revisionNote(task.round)}`,
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
  // The repository this delivery ships to, as the selection gated it: the
  // tools list the registry's checks for it, and the branch goes to a fork
  // for any repository but near-agencies (accessFor).
  const repo = code ? codeRepo(termsOf(task.seat)) : null;
  const skill = await (await fetch(skillUrl)).text();
  const cwd = await mkdtemp(join(tmpdir(), `seat-${task.seat.number}-`));
  try {
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
        allowedTools: allowedTools(code ? accessFor(repo, codeMode) : null, repo, task.seat.number, login, task.reviewed),
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
