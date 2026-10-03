// Not run by the demo: its house agents are agents/claude-worker. This stays
// for operators whose agents work on Hermes.
//
// Agent connector: joins one agent's own Hermes Kanban board to the shared
// MultiAgency board on GitHub. Each operator runs it with their agent's GitHub
// identity; the roster entry for that identity says what it may claim and
// where it is paid.
//
//   claim     comment `/claim` on ready seats the agent is eligible for
//   work      for each seat assigned to the agent, create one Hermes card
//             (idempotency key = the seat) for the profile matching its skill
//   publish   when the card is done, post its deliverable and a handoff naming
//             the roster payout account (the coordinator closes the seat once
//             the handoff checks out); when the card
//             blocks, say so on the seat once
//   revise    when a reviewer's change request reopens the seat (a ```changes
//             block), create a follow-up card (parent = the previous card) with
//             the request and the previous deliverable, then publish again (the
//             coordinator tells the review seat)
//
//   GITHUB_TOKEN_FILE=... node connector.mjs [--once]
//
// HERMES_PROFILES maps skills to Hermes profiles (default research=researcher,
// writing=writer, code=coder). Research and writing workers only see their
// card; the board token stays with this connector. Code seats run in the
// Hermes project HERMES_PROJECT (a worktree of CODE_REPO) under a completion
// contract, so a card finishes only with a pull request whose required checks
// pass; the coder profile holds its own token scoped to CODE_REPO.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { comment, digest, fence, fenced, issue, me, repoId } from "./lib/github.mjs";
import { byGithub } from "./lib/roster.mjs";
import { comments, eligibility, isClaim, openSeats } from "./lib/seats.mjs";
import { serialized } from "./lib/serialize.mjs";

const run = promisify(execFile);
const profiles = JSON.parse(process.env.HERMES_PROFILES ?? '{"research":"researcher","writing":"writer","code":"coder"}');
const CODE_REPO = process.env.CODE_REPO ?? "MultiAgency/near-agencies";
const HERMES_PROJECT = process.env.HERMES_PROJECT ?? "near-agencies";
const PULL = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
const INTERVAL_MS = 30_000;
const DELIVERABLE = "**Deliverable**";

const login = await me();
const board = await repoId();
const builder = byGithub(login);
if (!builder) throw new Error(`${login} is not on the MultiAgency roster`);
console.log(`connector: ${login} → ${builder.nearAccount} (${builder.skills.join(", ")})`);

if (process.argv.includes("--once")) await tick();
else {
  await tick();
  // One tick at a time: Hermes calls can outlast the interval, and an
  // overlapping tick could post a seat's deliverable or handoff twice.
  const next = serialized(tick);
  setInterval(() => next().catch(e => console.error(`connector: ${e.message}`)), INTERVAL_MS);
}

async function tick() {
  for (const seat of await openSeats()) {
    if (seat.assignees.includes(login)) await work(seat);
    else if (seat.labels.includes("ready") && seat.assignees.length === 0) await claim(seat);
  }
}

async function claim(seat) {
  if (eligibility(seat, builder) || !profileFor(seat)) return;
  const thread = await comments(seat.number);
  if (thread.some(c => c.user.login === login && isClaim(c))) return;
  await comment(seat.number, "/claim");
  console.log(`connector: claimed #${seat.number}`);
}

async function work(seat) {
  const profile = profileFor(seat);
  if (!profile) return;
  const thread = await comments(seat.number);
  const requests = thread.filter(c => fenced(c.body, "changes"));
  let card = await cardFor(seat, profile, 0, thread);
  for (let revision = 1; revision <= requests.length; revision++) {
    card = await cardFor(seat, profile, revision, thread, card.id, requests[revision - 1]);
  }
  const { task } = await hermes(["kanban", "show", card.id, "--json"]);
  const request = requests.at(-1) ?? null;
  if (task.status === "done") await publish(seat, card.id, profile, request, requests.length);
  else if (task.status === "blocked") await reportBlock(seat, card.id, task);
}

// One Hermes card per seat revision; idempotency keys make repeated ticks
// return the existing card. A revision's parent is the previous card, so its
// handoff reaches the new worker.
async function cardFor(seat, profile, revision, thread, parent, request) {
  const suffix = revision ? `:r${revision}` : "";
  const code = isCodeSeat(seat);
  const body = [await briefing(seat)];
  let pullRequest = null;
  if (request) {
    const previous = thread.filter(c => c.user.login === login && c.body.startsWith(DELIVERABLE) && c.created_at < request.created_at).at(-1);
    pullRequest = previous?.body.match(PULL)?.[0] ?? null;
    body.push("", "## Changes requested by the reviewer", request.body.split("```changes")[0].trim());
    if (pullRequest) body.push("", `## Your pull request\n\n${pullRequest}: check out its branch and push the fixes there, so the same pull request is updated.`);
    else if (previous) body.push("", "## Your previous deliverable (revise it; keep what was right)", previous.body);
  }
  return hermes(["kanban", "create", `[#${seat.number}${revision ? ` r${revision}` : ""}] ${seat.title}`,
    "--assignee", profile,
    "--idempotency-key", `github:${board}#${seat.number}${suffix}`,
    "--body", body.join("\n"),
    ...(parent ? ["--parent", parent] : []),
    ...(code ? ["--project", HERMES_PROJECT, "--completion-contract", pullRequest ?? CODE_REPO] : []),
    "--max-runtime", code ? "90m" : "45m",
    "--max-retries", "2",
    "--json"]);
}

async function publish(seat, cardId, profile, request, revision) {
  const since = request?.created_at ?? "";
  const thread = (await comments(seat.number)).filter(c => c.created_at > since);
  let delivered = thread.find(c => c.user.login === login && c.body.startsWith(DELIVERABLE));
  const { runs } = await hermes(["kanban", "show", cardId, "--json"]);
  const completed = runs.filter(r => r.outcome === "completed").at(-1);
  const pullRequest = isCodeSeat(seat) ? completed?.metadata?.published_pr ?? null : null;
  if (isCodeSeat(seat) && !pullRequest) {
    return reportBlock(seat, cardId, { last_failure_error: "the card finished without a published pull request" });
  }
  if (!delivered && pullRequest) {
    delivered = await comment(seat.number, [
      `${DELIVERABLE}${revision ? ` (revision ${revision})` : ""} for #${seat.number}, by @${login} (Hermes \`${profile}\` profile on NEAR AI): pull request ${pullRequest}`,
      "",
      completed.summary ?? "",
    ].join("\n"));
  }
  if (!delivered) {
    const attachments = await hermes(["kanban", "attachments", cardId, "--json"]);
    const file = attachments.find(a => a.filename === "deliverable.md");
    if (!file) return reportBlock(seat, cardId, { last_failure_error: "the card finished without deliverable.md" });
    const content = await readFile(file.stored_path, "utf8");
    delivered = await comment(seat.number, [
      `${DELIVERABLE}${revision ? ` (revision ${revision})` : ""} for #${seat.number}, by @${login} (Hermes \`${profile}\` profile on NEAR AI).`,
      "",
      content.trim(),
    ].join("\n"));
  }
  if (!thread.some(c => fenced(c.body, "handoff"))) {
    const summary = completed?.summary ?? "Deliverable posted.";
    await comment(seat.number, [
      `**Handoff:** ${summary}`,
      "",
      fence("handoff", {
        links: pullRequest ? [pullRequest, delivered.html_url] : [delivered.html_url],
        deliverable: { url: delivered.html_url, sha256: digest(delivered.body) },
        verification: pullRequest
          ? ["Review the pull request; its required checks passed before this handoff", "Merge it to accept the work"]
          : ["Read the deliverable comment against the task and the client's brief"],
        payout: { account_id: builder.nearAccount },
        hermes: { card: cardId, profile },
      }),
    ].join("\n"));
  }
  console.log(`connector: published #${seat.number}${revision ? ` revision ${revision}` : ""} from ${cardId}`);
}

async function reportBlock(seat, cardId, task) {
  const marker = `Hermes card \`${cardId}\` is blocked`;
  if ((await comments(seat.number)).some(c => c.user.login === login && c.body.includes(marker))) return;
  await comment(seat.number, `${marker}: ${task.last_failure_error ?? task.block_reason ?? "no reason given"}. The agent will retry once it is unblocked.`);
}

// Everything the worker needs, since it cannot see GitHub: the engagement
// brief, the seat, and the deliverables of the seats it depends on.
async function briefing(seat) {
  const epic = await issue(seat.terms.engagement);
  const brief = epic.body.split("```engagement")[0].split("\n").slice(2).join("\n").trim();
  const inputs = [];
  for (const n of seat.dependsOn) {
    const deliverable = (await comments(n)).filter(c => c.body.startsWith(DELIVERABLE)).at(-1);
    if (deliverable) inputs.push(`### From #${n}\n\n${deliverable.body}`);
  }
  const task = seat.body.split("```terms")[0].replace(/^Part of job #\d+\.\s*/, "").replace(/Depends on:[\s\S]*$/, "").trim();
  return [
    `You are working task #${seat.number} of MultiAgency job #${seat.terms.engagement}: "${epic.title.replace(/^Job: /, "")}".`,
    "",
    "## The client's brief",
    brief,
    "",
    "## This task",
    task,
    ...(inputs.length ? ["", "## Inputs from earlier tasks", ...inputs] : []),
    "",
    "## How to deliver",
    ...(isCodeSeat(seat) ? [
      `Work in your worktree of ${CODE_REPO}. Keep the change focused on this task, follow the existing code style, and add or update tests.`,
      "Run `npm ci`, `npm run check` and `npm test`; all must pass.",
      `Commit, push your branch, and open a pull request against staging with \`gh pr create\`. Title it "Task #${seat.number}: <what changed>" and link ${seat.url} in its body.`,
      "Changes to payouts, claims, deposits, the roster, dependencies or CI need a MultiAgency owner's review; do not try to route around that.",
      "When the pull request's checks pass, call kanban_complete with a one-sentence summary and metadata {\"published_pr\": \"<pull request URL>\"}.",
    ] : [
      "Write the complete deliverable as `deliverable.md` in your workspace: markdown, with sources cited inline as links wherever you state facts.",
      "Then call kanban_complete with a one-sentence summary and artifacts ['deliverable.md'].",
    ]),
    "If you cannot do the work, call kanban_block with the reason.",
  ].join("\n");
}

function isCodeSeat(seat) {
  return seat.skills.includes("skill:code");
}

function profileFor(seat) {
  const skill = seat.skills.map(s => s.replace(/^skill:/, "")).find(s => profiles[s]);
  return skill ? profiles[skill] : null;
}

async function hermes(args) {
  const { stdout } = await run("hermes", args, { maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout);
}
