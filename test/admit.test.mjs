import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { bytesToBase64, privateKeyFromRandom, signNep413Message } from "@fastnear/utils";

process.env.GITHUB_TOKEN = "test-token";

// Members admitted on the board, as the server's volume holds them: one
// replaces a roster.json entry (a re-registration), one is new.
const admittedFile = join(mkdtempSync(join(tmpdir(), "admitted-")), "roster-admitted.json");
const member = (login, nearAccount, kind = "human") => ({ nearAccount, name: login, skills: ["research"], links: { github: `https://github.com/${login}` }, kind });
writeFileSync(admittedFile, JSON.stringify({ builders: [member("jlwaugh", "new.agency.testnet"), member("saad", "saad-test.testnet")] }));
process.env.ADMITTED_FILE = admittedFile;

const { admit, byGithub, roster } = await import("../lib/roster.mjs");
const { isAdmission, settleJoinRequests } = await import("../lib/coordinator.mjs");
const { joinIssue, joinMessage, newNonce, RECIPIENT } = await import("../lib/onboarding.mjs");
const { network } = await import("../lib/network.mjs");

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

// --- /admit drops USDC storage registration ----------------------------------

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const signedRequest = fields => {
  const message = joinMessage(fields, new Date(Date.now() - 60_000));
  const nonce = newNonce();
  const { publicKey, signature } = signNep413Message({ message, nonce: Buffer.from(nonce, "base64"), recipient: RECIPIENT }, privateKeyFromRandom());
  return { message, nonce, recipient: RECIPIENT, accountId: fields.near, publicKey, signature: bytesToBase64(signature) };
};

describe("/admit with no USDC registration", () => {
  test("admits with no storage read, no registration note, and a roster reply naming no payee", async () => {
    const fields = { github: "newcomer2", near: "newcomer2.testnet", name: "Newcomer Two", kind: "human", skills: ["research"] };
    const request = signedRequest(fields);
    const { title, body } = joinIssue(request);
    const htmlUrl = "https://github.com/MultiAgency/kanban-sandbox/issues/70";
    const issue = {
      number: 70,
      title,
      html_url: htmlUrl,
      state: "open",
      user: { login: fields.github },
      assignees: [],
      labels: [{ name: "roster-verified" }],
      created_at: new Date(Date.now() - 30_000).toISOString(),
      updated_at: new Date(Date.now() - 30_000).toISOString(),
      body,
    };
    const command = { id: 900, user: { login: "owner-jl" }, body: "/admit", html_url: `${htmlUrl}#issuecomment-900`, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const posted = [];
    globalThis.fetch = async (url, options = {}) => {
      const method = options.method ?? "GET";
      const u = String(url);
      const json = (responseBody, status = 200) => new Response(JSON.stringify(responseBody), { status, headers: { "content-type": "application/json" } });
      if (u.startsWith(network.rpc)) {
        const rpc = JSON.parse(options.body);
        // Only the signing key's binding is checked: no contract view, of any
        // method, is made.
        if (rpc.params.request_type !== "view_access_key") throw new Error(`unexpected NEAR view: ${rpc.params.method_name}`);
        return json({ jsonrpc: "2.0", id: rpc.id, result: { nonce: 1, permission: "FullAccess" } });
      }
      if (u.includes("/search/issues")) return json({ items: [] });
      if (u.includes("/collaborators/")) return json({ role_name: "admin" });
      if (u.includes(`/issues/${issue.number}/comments?`) && method === "GET") return json([command]);
      if (u.endsWith(`/issues/${issue.number}/comments`) && method === "POST") {
        posted.push(JSON.parse(options.body).body);
        return json({});
      }
      if (u.endsWith(`/issues/${issue.number}`) && method === "PATCH") return json(issue);
      if (u.includes("/comments/") && u.includes("/reactions")) return json(method === "GET" ? [] : {});
      if (u.endsWith(`/issues/${issue.number}/labels`)) return json({});
      throw new Error(`unexpected fetch: ${method} ${u}`);
    };
    await settleJoinRequests("multi-agency", [issue]);
    assert.equal(posted.length, 2, posted.join("|"));
    assert.equal(posted[0], "**Admitted** by @owner-jl.", "no registration note follows the admission");
    assert.equal(posted[1], `@newcomer2 is on the MultiAgency roster. The tasks you can claim now, and what to do next: https://demo.multiagency.ai/#/status/newcomer2`,
      "the roster reply names no account as a payee");
    assert.equal(byGithub("newcomer2").nearAccount, "newcomer2.testnet");
  });
});
