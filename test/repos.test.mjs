import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { codeRepo, DEFAULT_REPO, REPOS, repoOf, WORKER_DELIVERS } from "../agents/claude-worker/repos.mjs";

describe("the repository registry", () => {
  test("near-agencies is the default everywhere", () => {
    assert.equal(DEFAULT_REPO, "MultiAgency/near-agencies");
    assert.equal(repoOf(undefined), DEFAULT_REPO);
    assert.equal(repoOf({}), DEFAULT_REPO);
    assert.equal(repoOf({ engagement: 28, key: "research", amount: "1000000" }), DEFAULT_REPO);
    assert.equal(codeRepo(undefined).name, DEFAULT_REPO);
  });

  test("a task's terms name their repository", () => {
    assert.equal(repoOf({ repo: "MultiAgency/legion-social" }), "MultiAgency/legion-social");
    assert.equal(codeRepo({ repo: "MultiAgency/legion-social" }).name, "MultiAgency/legion-social");
  });

  test("each entry records its base branch, checks and worker image", () => {
    assert.deepEqual(codeRepo({}), {
      name: "MultiAgency/near-agencies",
      base: "staging",
      image: "node",
      checks: ["npm ci", "npm run check", "npm test"],
    });
    assert.deepEqual(codeRepo({ repo: "MultiAgency/legion-social" }), {
      name: "MultiAgency/legion-social",
      base: "staging",
      image: "rust",
      checks: [
        "cargo clippy --all-targets -- -D warnings",
        "cargo test",
        "npm --prefix web ci",
        "npm --prefix web run lint",
        "npm --prefix web run typecheck",
        "npm --prefix web test",
      ],
    });
  });

  test("a repository outside the registry is refused: nothing may be shipped there", () => {
    assert.throws(() => codeRepo({ repo: "octocat/hello-world" }), /not a repository code tasks deliver against/);
    assert.throws(() => codeRepo({ repo: ["MultiAgency/legion-social"] }), /not a repository code tasks deliver against/,
      "an array is not a name, however it stringifies");
  });

  test("the registry holds every repository once, under its exact name", () => {
    assert.deepEqual(Object.keys(REPOS).sort(), ["MultiAgency/legion-social", "MultiAgency/near-agencies"]);
  });

  test("until workers read a task's repository (#82), a job may name only what they deliver to", () => {
    assert.deepEqual([...WORKER_DELIVERS], [DEFAULT_REPO]);
  });

  test("the module imports nothing, so the worker image can copy it", () => {
    const source = readFileSync(new URL("../agents/claude-worker/repos.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(source, /(^|\n)\s*import\b/, "no import statements");
    assert.doesNotMatch(source, /\bimport\s*\(/, "no dynamic imports");
    assert.doesNotMatch(source, /(^|\n)\s*export[^;\n]*\bfrom\b/, "no re-exports");
  });
});
