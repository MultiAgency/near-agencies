// Every script is run by a test (problem #130): each `scripts/*.mjs` and each
// top-level CLI is spawned once, the way a live run starts it — as
// test/payout-tool.test.mjs was the first — with an input that makes it exit
// early and cleanly without touching the network: `--help`, a missing
// required argument, or a missing GITHUB_EVENT_PATH. The entry asserts the
// expected exit code and a stderr free of load-time crashes — a
// ReferenceError, a SyntaxError, a "before initialization" — the class of
// defect the lib-only tests miss, because importing a script's library never
// runs the script (the describe-before-initialization in
// scripts/staging-approval.mjs reached staging's first live run).
//
// The list is explicit on purpose: the last test fails when a new
// scripts/*.mjs shows up without a smoke entry here. A script with no clean
// early exit gets the smallest one — a usage message on missing input, as
// connector.mjs and agent.mjs got — rather than a skip.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// A load-time crash reads as one of these on stderr, whatever the script's own
// error handling prints around it.
const CRASH = /ReferenceError|SyntaxError|before initialization/;
const TIMEOUT_MS = 30_000;

// Spawn arguments per entry point: the input that exits early, the exit code
// it exits with, and what its own message on that path says (stderr, or stdout
// for a `--help` that prints usage). `drop` names environment variables the
// spawn must not inherit — the absence the early exit answers, or a value a
// GitHub Actions runner sets (GITHUB_EVENT_PATH) that would send the script
// on to the network.
const ENTRIES = [
  {
    file: "scripts/operator-approval.mjs",
    drop: ["GITHUB_EVENT_PATH"],
    code: 1,
    stderr: /operator-approval: .*failing closed/,
  },
  {
    file: "scripts/staging-approval.mjs",
    drop: ["GITHUB_EVENT_PATH"],
    code: 1,
    stderr: /staging-approval/,
  },
  {
    file: "scripts/registry-backfill.mjs",
    drop: ["REGISTRY_URL", "REGISTRY_TOKEN"],
    code: 1,
    stderr: /REGISTRY_URL is not set/,
  },
  { file: "scripts/replay-check.mjs", code: 64, stderr: /usage:/ },
  { file: "roster.mjs", code: 64, stderr: /usage:/ },
  { file: "payout.mjs", code: 64, stderr: /usage:/ },
  { file: "assemble.mjs", code: 64, stderr: /usage:/ },
  { file: "org.mjs", code: 64, stderr: /usage:/ },
  { file: "connector.mjs", args: ["--help"], code: 0, stdout: /usage:/ },
  { file: "agent.mjs", args: ["--help"], code: 0, stdout: /usage:/ },
];

const env = drop => {
  const copied = { ...process.env };
  for (const name of drop ?? []) delete copied[name];
  return copied;
};

for (const entry of ENTRIES) {
  test(`${entry.file} exits ${entry.code} on its smoke input, with no load-time crash`, () => {
    const run = spawnSync(process.execPath, [join(ROOT, entry.file), ...(entry.args ?? [])], {
      env: env(entry.drop),
      encoding: "utf8",
      timeout: TIMEOUT_MS,
    });
    assert.equal(run.status, entry.code, `${entry.file}: stderr was:\n${run.stderr}`);
    if (entry.stderr) assert.match(run.stderr, entry.stderr);
    if (entry.stdout) assert.match(run.stdout, entry.stdout);
    assert.doesNotMatch(String(run.stderr), CRASH);
  });
}

// The server listens (every module in its graph loads, mounts, and reaches
// app.listen) and then stops cleanly on the SIGTERM a deployment sends it —
// server.mjs exits 0 on that signal on purpose, so a replaced deployment does
// not read as a crash. PORT=0 binds an ephemeral loopback port; with
// REGISTRY_URL and COORDINATOR unset nothing reads the board or the registry
// during startup.
test("server.mjs listens and stops cleanly on SIGTERM, with no load-time crash", async () => {
  const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    env: env(["FACILITATOR_URL", "COORDINATOR", "REGISTRY_URL", "GITHUB_EVENT_PATH"]),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", chunk => {
    stderr += chunk;
  });
  let stdout = "";
  child.stdout.on("data", chunk => {
    stdout += chunk;
  });
  const listened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server.mjs did not listen within ${TIMEOUT_MS} ms; stdout:\n${stdout}stderr:\n${stderr}`)), TIMEOUT_MS);
    child.stdout.on("data", () => {
      if (stdout.includes("MultiAgency demo on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`server.mjs exited before it listened (code ${code}, signal ${signal}); stderr:\n${stderr}`));
    });
  });
  await listened;
  child.kill("SIGTERM");
  const stopped = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  const enforcer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  const { code } = await stopped;
  clearTimeout(enforcer);
  assert.equal(code, 0, `SIGTERM should exit 0; stderr was:\n${stderr}`);
  assert.doesNotMatch(stderr, CRASH);
});

test("every scripts/*.mjs has a smoke entry above", () => {
  const listed = new Set(ENTRIES.filter(entry => entry.file.startsWith("scripts/")).map(entry => basename(entry.file)));
  const missing = readdirSync(join(ROOT, "scripts")).filter(name => name.endsWith(".mjs") && !listed.has(name));
  assert.deepEqual(missing, [], `no smoke entry for ${missing.map(name => `scripts/${name}`).join(", ")} — add one to ENTRIES in test/scripts-smoke.test.mjs, with an input that exits early and cleanly (add the smallest early exit to the script itself when it has none)`);
});
