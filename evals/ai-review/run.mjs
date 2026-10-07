#!/usr/bin/env node
// Runs ai-review, as .github/workflows/ai-review.yml configures it, on
// recorded pull requests, and checks what it does. Each case in cases/ is
// one review round: the pull request's base tree with this checkout's
// REVIEW.md, AGENTS.md, CLAUDE.md, docs/decisions.md and .claude/ laid over
// it (the configuration under test), the diff and description, and the
// earlier rounds' comments, which the workflow's own "Earlier rounds" script
// turns into the reviewer's memory. After the review, the workflow's own
// "Verdict" script rewrites verdict.json as the gate reads it. gh is a stub
// (gh-stub.mjs). The one change to the review: the inline-comment tool
// exists only inside the GitHub action, so the eval asks for those comments
// in a file instead.
//
//   node evals/ai-review/run.mjs [case ...] [--keep]
//
// Needs claude on PATH (with ANTHROPIC_API_KEY in CI) and git history back
// to each case's base. Exits 1 when any contract check fails or fewer than
// BEHAVIOR_PASS of the behavior checks pass.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checks } from "./checks.mjs";
import { interpolate, reviewConfig, splitArgs } from "./workflow.mjs";

const BEHAVIOR_PASS = 0.75;
const REPO = "MultiAgency/near-agencies";
const here = new URL(".", import.meta.url).pathname;
const root = join(here, "../..");
const CONFIG = ["REVIEW.md", "AGENTS.md", "CLAUDE.md", "docs/decisions.md"];
const INLINE = "eval-inline.json";
const ADAPTER = `

EVAL RUN. The inline-comment tool is not available here. Instead of posting inline comments with it, write them all to ${INLINE} (Write tool) as one JSON array of {"path", "line", "body"} objects, [] when there are none. Everything else exactly as above.`;

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const named = args.filter(a => !a.startsWith("--"));
const cases = named.length ? named : readdirSync(join(here, "cases")).sort();
const config = reviewConfig(readFileSync(join(root, ".github/workflows/ai-review.yml"), "utf8"));

let contractFailed = false, behavior = 0, behaviorPassed = 0, cost = 0;
for (const name of cases) {
  const dir = join(here, "cases", name);
  const spec = JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
  const ws = mkdtempSync(join(tmpdir(), `ai-review-eval-${name}-`));
  const aside = mkdtempSync(join(tmpdir(), "ai-review-eval-aside-"));
  const out = join(aside, "out");
  const bin = join(aside, "bin");
  mkdirSync(out);
  mkdirSync(bin);
  try {
    if (!/^[0-9a-f]{40}$/.test(spec.base)) throw new Error(`${name}: base must be a full commit SHA`);
    execFileSync("tar", ["-x", "-C", ws], { input: execFileSync("git", ["-C", root, "archive", spec.base], { maxBuffer: 1 << 28 }) });
    for (const file of CONFIG) if (existsSync(join(root, file))) cpSync(join(root, file), join(ws, file));
    rmSync(join(ws, ".claude"), { recursive: true, force: true });
    if (existsSync(join(root, ".claude"))) cpSync(join(root, ".claude"), join(ws, ".claude"), { recursive: true });
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec node "${join(here, "gh-stub.mjs")}" "$@"\n`, { mode: 0o755 });
    const env = {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, EVAL_CASE: dir, EVAL_OUT: out,
      REPO, PR: String(spec.pr), HEAD_SHA: spec.head, GH_TOKEN: "eval",
    };
    execFileSync("bash", ["-e", "-c", config.earlierRounds], { cwd: ws, env, stdio: "ignore" });

    const prompt = interpolate(config.prompt, {
      "github.repository": REPO,
      "github.event.pull_request.number || github.event.issue.number": String(spec.pr),
      "github.event.pull_request.head.sha": spec.head,
      "steps.pr.outputs.sha": spec.head,
    }) + ADAPTER;
    const claudeArgs = splitArgs(config.claudeArgs);
    const tools = claudeArgs.indexOf("--allowedTools") + 1;
    claudeArgs[tools] += `,Edit(./${INLINE})`;
    const ran = spawnSync("claude", ["-p", prompt, ...claudeArgs, "--output-format", "json", "--no-session-persistence", "--setting-sources", "project"],
      { cwd: ws, env, encoding: "utf8", maxBuffer: 1 << 26, timeout: 15 * 60_000 });
    const attempt = f => {
      try {
        return f();
      } catch {
        return null;
      }
    };
    const read = (file, parse) => attempt(() => parse(readFileSync(file, "utf8")));
    // The workflow's own posting step, through the gh stub that records it.
    spawnSync("bash", ["-c", config.post], { cwd: ws, env, stdio: "ignore" });
    // The workflow's Verdict step: the event's SHA and a count that parses,
    // or no file at all.
    spawnSync("bash", ["-c", config.verdict], { cwd: ws, env, stdio: "ignore" });
    const run = {
      head: spec.head,
      result: attempt(() => JSON.parse(ran.stdout)),
      verdict: read(join(ws, "verdict.json"), JSON.parse),
      summary: read(join(out, "summary.md"), s => s),
      inline: existsSync(join(ws, INLINE)) ? read(join(ws, INLINE), JSON.parse) : [],
    };
    cost += run.result?.total_cost_usd ?? 0;
    const results = checks(spec.expect, run);
    console.log(`\n${name}: ${spec.what} ($${(run.result?.total_cost_usd ?? 0).toFixed(2)}, ${run.result?.num_turns ?? "?"} turns)`);
    for (const c of results) {
      if (c.note) {
        console.log(`  note  ${c.name}`);
        continue;
      }
      console.log(`  ${c.ok ? "pass" : "FAIL"}  ${c.contract ? "[contract] " : ""}${c.name}${c.ok || !c.detail ? "" : `: ${c.detail}`}`);
      if (c.contract && !c.ok) contractFailed = true;
      if (!c.contract) {
        behavior++;
        if (c.ok) behaviorPassed++;
      }
    }
    if (keep) console.log(`  kept: ${ws} and ${aside}`);
  } finally {
    if (!keep) {
      rmSync(ws, { recursive: true, force: true });
      rmSync(aside, { recursive: true, force: true });
    }
  }
}

const rate = behavior ? behaviorPassed / behavior : 1;
console.log(`\nbehavior ${behaviorPassed}/${behavior}, contract ${contractFailed ? "FAILED" : "held"}, $${cost.toFixed(2)}`);
process.exit(contractFailed || rate < BEHAVIOR_PASS ? 1 : 0);
