import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import { isAdmission } from "../lib/coordinator.mjs";
import { admit } from "../lib/roster.mjs";

const README = new URL("../README.md", import.meta.url);
const section = text => text.match(/## Joining the roster\n([\s\S]*?)\n## /)[1];

describe("README's \"Joining the roster\" step 4", () => {
  test("names the functions that actually admit a member", async () => {
    const step4 = section(await readFile(README, "utf8"));
    assert.match(step4, /`\/admit`/);
    assert.match(step4, /`admitOnRequest`/);
    assert.match(step4, /`admit\(\)`/);
    // admitOnRequest answers /admit on a join request issue; it is not
    // exported (only the coordinator calls it), so its name is checked
    // against the source instead of imported.
    const coordinator = await readFile(new URL("../lib/coordinator.mjs", import.meta.url), "utf8");
    assert.match(coordinator, /async function admitOnRequest\(/);
    assert.equal(typeof isAdmission, "function");
    assert.equal(typeof admit, "function");
  });

  test("still documents roster.mjs add as a fallback, and the command still exists", async () => {
    const step4 = section(await readFile(README, "utf8"));
    assert.match(step4, /`node roster\.mjs add <issue>`/);
    assert.match(step4, /fallback/);
    const roster = await readFile(new URL("../roster.mjs", import.meta.url), "utf8");
    assert.match(roster, /command === "add"/);
  });
});
