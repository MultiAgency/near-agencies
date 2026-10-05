import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// The payout commands read jobs that only the board's bot may have opened
// (lib/github.mjs botLogin), so the tool refuses to run until BOARD_BOT names
// that login — before any GitHub read, where an owner's own token would make
// every job read as "not an engagement".
test("payout.mjs refuses to run without BOARD_BOT, before any GitHub read", () => {
  const run = spawnSync(process.execPath, ["payout.mjs", "status", "1"], {
    env: { ...process.env, BOARD_BOT: "", GITHUB_TOKEN: "test-token" },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(run.status, 64);
  assert.match(run.stderr, /BOARD_BOT/);
});
