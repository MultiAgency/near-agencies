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

const env = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const login = env("AGENT_LOGIN");
const nearAccount = env("NEAR_ACCOUNT");
const skills = env("AGENT_SKILLS").split(",").map(s => s.trim());
const board = process.env.BOARD ?? "MultiAgency/kanban-sandbox";
const skillUrl = process.env.SKILL_URL ?? "https://demo-production-3e13.up.railway.app/skill.md";
const model = process.env.MODEL ?? "claude-sonnet-5";
const maxBudgetUsd = Number(process.env.MAX_BUDGET_USD ?? "3");
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

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const isSeat = issue => !issue.pull_request && /```terms\n/.test(issue.body ?? "");
const labelsOf = issue => issue.labels.map(label => label.name);

// The claim rules of skill.md section 2.
function mayClaim(issue) {
  const labels = labelsOf(issue);
  return labels.includes("ready") && issue.assignees.length === 0 &&
    labels.includes("agent-eligible") && !labels.includes("human-only") &&
    labels.filter(l => l.startsWith("skill:")).every(l => skills.includes(l.slice(6)));
}

async function nextTask() {
  const seats = (await github("/issues?state=open&per_page=100")).filter(isSeat);
  for (const seat of seats.filter(s => s.assignees.some(a => same(a.login, login)))) {
    const thread = await github(`/issues/${seat.number}/comments?per_page=100`);
    const since = thread.findLastIndex(c => c.body.includes("```changes\n"));
    const handedOff = thread.slice(since + 1).some(c => same(c.user.login, login) && c.body.includes("```handoff\n"));
    if (!handedOff) return { action: "deliver", seat, revision: since !== -1 };
  }
  for (const seat of seats.filter(mayClaim)) {
    const thread = await github(`/issues/${seat.number}/comments?per_page=100`);
    if (!thread.some(c => same(c.user.login, login) && c.body.trim().startsWith("/claim"))) return { action: "claim", seat };
  }
  return null;
}

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
  const doing = task.action === "claim"
    ? `Claim task #${n}: comment exactly \`/claim\` on it, then stop. The coordinator assigns it; a later run does the work.`
    : [
      `Deliver task #${n}, which is assigned to you.${task.revision ? " The reviewer asked for another round (the latest ```changes comment): address every point in a new deliverable." : ""}`,
      "Read the task, the job it names, and the deliverables of any tasks it depends on. Do the work, citing sources inline as links.",
      "Then post the deliverable comment, get its sha256 with the deliverable_sha256 tool, and post the handoff comment, exactly as the rules say. The coordinator closes the task once the handoff checks out.",
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
        allowedTools: [
          "Read(./**)", "Write(./**)", "Edit(./**)", "Glob", "Grep", "WebSearch", "WebFetch",
          "Bash(gh issue view:*)", "Bash(gh issue comment:*)", "Bash(gh api:*)",
          "mcp__multiagency__deliverable_sha256",
        ],
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
