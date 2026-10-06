#!/usr/bin/env node
// A stand-in for gh during an eval: it answers the reads the review makes
// from the case's fixtures, and records the summary comment instead of
// posting it. EVAL_CASE is the case folder, EVAL_OUT where the run's
// outputs land. Any other call fails loudly, so a review that tries
// something new shows up in the eval, not as a silent pass.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const fixtures = process.env.EVAL_CASE;
const out = process.env.EVAL_OUT;
const args = process.argv.slice(2);
const fixture = name => readFileSync(join(fixtures, name), "utf8");
const json = name => (existsSync(join(fixtures, name)) ? JSON.parse(fixture(name)) : []);
appendFileSync(join(out, "gh-calls.log"), `${args.join(" ")}\n`);

if (args[0] === "pr" && args[1] === "diff") {
  process.stdout.write(fixture("pr.diff"));
} else if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(fixture("pr.md"));
} else if (args[0] === "pr" && args[1] === "comment") {
  const file = args[args.indexOf("--body-file") + 1];
  const body = args.includes("--body-file") ? readFileSync(file, "utf8") : args[args.indexOf("--body") + 1];
  appendFileSync(join(out, "summary.md"), `${body}\n`);
  console.log(`https://github.com/eval/eval/pull/0#issuecomment-${Date.now()}`);
} else if (args[0] === "api") {
  const path = args.find(a => a.startsWith("repos/"));
  if (/\/issues\/\d+\/comments$/.test(path)) console.log(JSON.stringify([json("comments.json")]));
  else if (/\/pulls\/\d+\/comments$/.test(path)) console.log(JSON.stringify([json("inline.json")]));
  else if (/\/compare\//.test(path) && args.includes("--jq")) console.log(existsSync(join(fixtures, "delta.diff")) ? "ahead" : "diverged");
  else if (/\/compare\//.test(path)) process.stdout.write(fixture("delta.diff"));
  else fail();
} else {
  fail();
}

function fail() {
  console.error(`gh-stub: the evals don't answer \`gh ${args.join(" ")}\``);
  process.exit(1);
}
