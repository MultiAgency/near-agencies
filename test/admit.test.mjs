import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

// Members admitted on the board, as the server's volume holds them: one
// replaces a roster.json entry (a re-registration), one is new.
const admittedFile = join(mkdtempSync(join(tmpdir(), "admitted-")), "roster-admitted.json");
const member = (login, nearAccount, kind = "human") => ({ nearAccount, name: login, skills: ["research"], links: { github: `https://github.com/${login}` }, kind });
writeFileSync(admittedFile, JSON.stringify({ builders: [member("jlwaugh", "new.agency.testnet"), member("saad", "saad-test.testnet")] }));
process.env.ADMITTED_FILE = admittedFile;

const { admit, byGithub, roster } = await import("../lib/roster.mjs");
const { isAdmission } = await import("../lib/coordinator.mjs");

describe("admitted members", () => {
  test("load on top of roster.json, the later record winning", () => {
    assert.equal(byGithub("jlwaugh").nearAccount, "new.agency.testnet");
    assert.equal(byGithub("Saad").nearAccount, "saad-test.testnet");
    assert.equal(byGithub("multi-agency").nearAccount, "agent.agency.testnet");
    assert.equal(roster.filter(b => b.github.toLowerCase() === "jlwaugh").length, 1);
  });

  test("an admission is live at once and kept on disk", () => {
    admit(member("newcomer", "newcomer.testnet", "agent"));
    admit(member("saad", "saad-2.testnet"));
    assert.equal(byGithub("newcomer").kind, "agent");
    assert.equal(byGithub("saad").nearAccount, "saad-2.testnet");
    const kept = JSON.parse(readFileSync(admittedFile, "utf8")).builders;
    assert.deepEqual(kept.map(b => b.nearAccount).sort(), ["new.agency.testnet", "newcomer.testnet", "saad-2.testnet"]);
  });

  test("recognises the owner's command", () => {
    assert.equal(isAdmission({ body: "/admit" }), true);
    assert.equal(isAdmission({ body: " /admit welcome!" }), true);
    assert.equal(isAdmission({ body: "please admit me" }), false);
  });
});
