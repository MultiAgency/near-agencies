import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

// Requests go only to the fetch stubs below; no registry is contacted.
process.env.GITHUB_TOKEN = "test-token";

// The local admitted store: a member an owner admitted on the board, whom the
// registry does not have, and one whose stamped admission the registry's newer
// copy of the same login replaces.
const admittedFile = join(mkdtempSync(join(tmpdir(), "registry-")), "roster-admitted.json");
writeFileSync(admittedFile, JSON.stringify({ builders: [{
  nearAccount: "local.admitted.testnet",
  name: "Local admitted",
  skills: ["review"],
  links: { github: "https://github.com/local-member" },
  kind: "human",
}, {
  nearAccount: "stale.local.testnet",
  name: "Stale admitted",
  skills: ["writing"],
  links: { github: "https://github.com/stale-member" },
  kind: "agent",
  admittedAt: "2026-09-01T00:00:00Z",
}] }));
process.env.ADMITTED_FILE = admittedFile;

const { admit, byGithub, refreshRegistry, registryHealth } = await import("../lib/roster.mjs");
const { eligibility } = await import("../lib/seats.mjs");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
afterEach(() => { delete process.env.REGISTRY_URL; });

const REGISTRY_URL = "https://registry.test/api/rpc/builders";
// The dashboard identity (nearAccount) deliberately differs from the payout
// accounts: a member is paid at the account they listed for this network.
const member = (overrides = {}) => ({
  githubLogin: "reg-agent",
  kind: "agent",
  operatorGithubLogin: "reg-operator",
  name: "Registry agent",
  skills: ["research", "writing"],
  nearAccount: "dashboard.reg-agent.testnet",
  accounts: [
    { network: "testnet", account: "payout.reg-agent.testnet" },
    { network: "mainnet", account: "payout.reg-agent.near" },
  ],
  admissions: [
    { network: "testnet", status: "admitted", proofUrl: "https://github.com/MultiAgency/kanban-sandbox/issues/9", admittedAt: "2026-10-01T00:00:00Z" },
  ],
  ...overrides,
});

// Serves one canned oRPC reply, recording every call the module makes.
const serve = (body, status = 200) => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method, body: options.body });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return calls;
};

describe("the shared member registry", () => {
  test("with REGISTRY_URL unset, the roster is the local files and nothing is fetched", async () => {
    const calls = serve({ json: { data: [member()] } });
    await refreshRegistry();
    assert.equal(calls.length, 0);
    assert.equal(byGithub("multi-agency").nearAccount, "agent.agency.testnet");
    assert.equal(byGithub("jlwaugh").nearAccount, "reviewer.agency.testnet");
    assert.equal(byGithub("local-member").nearAccount, "local.admitted.testnet");
    assert.equal(byGithub("reg-agent"), null);
    assert.equal(registryHealth(), null);
  });

  test("a member admitted here joins the roster, eligible, with the registry's fields", async () => {
    process.env.REGISTRY_URL = REGISTRY_URL;
    const calls = serve({ json: { data: [
      member(),
      member({ githubLogin: "mainnet-only", admissions: [{ network: "mainnet", status: "admitted", proofUrl: "u", admittedAt: "2026-10-01T00:00:00Z" }] }),
      member({ githubLogin: "still-pending", admissions: [{ network: "testnet", status: "pending", proofUrl: "u", admittedAt: "2026-10-01T00:00:00Z" }] }),
      member({ githubLogin: "no-account-here", accounts: [{ network: "mainnet", account: "elsewhere.near" }] }),
      // Also on the local files: the registry's copy is the one that counts.
      member({ githubLogin: "jlwaugh", name: "Registry James", skills: ["code"], nearAccount: "dashboard.jlwaugh.testnet", accounts: [{ network: "testnet", account: "payout.jlwaugh.testnet" }] }),
      // The registry's admission of this login is newer than the store's.
      member({ githubLogin: "stale-member", admissions: [{ network: "testnet", status: "admitted", proofUrl: "https://github.com/MultiAgency/kanban-sandbox/issues/10", admittedAt: "2026-10-01T00:00:00Z" }] }),
    ] } });
    await refreshRegistry();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://registry.test/api/rpc/builders/listMembers");
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(JSON.parse(calls[0].body), { json: { network: "testnet", status: "admitted" } });
    const listed = byGithub("reg-agent");
    assert.equal(listed.kind, "agent");
    assert.equal(listed.name, "Registry agent");
    assert.deepEqual(listed.skills, ["research", "writing"]);
    assert.equal(listed.operator, "reg-operator");
    assert.equal(listed.proof, "https://github.com/MultiAgency/kanban-sandbox/issues/9");
    assert.equal(byGithub("mainnet-only"), null, "admitted only on the other network");
    assert.equal(byGithub("still-pending"), null, "not admitted yet");
    assert.equal(byGithub("no-account-here"), null, "nowhere on this network to be paid at");
    assert.equal(eligibility({ labels: ["ready", "agent-eligible"], skills: [] }, listed), null);
  });

  test("the payout account is the member's account for this network, never the dashboard identity", () => {
    assert.equal(byGithub("reg-agent").nearAccount, "payout.reg-agent.testnet");
    assert.notEqual(byGithub("reg-agent").nearAccount, "dashboard.reg-agent.testnet");
    assert.equal(byGithub("jlwaugh").nearAccount, "payout.jlwaugh.testnet");
  });

  test("roster.json and the admitted store stay as the fallback, an admission stays live", async () => {
    process.env.REGISTRY_URL = REGISTRY_URL;
    assert.equal(byGithub("multi-agency").nearAccount, "agent.agency.testnet");
    assert.equal(byGithub("local-member").kind, "human");
    assert.equal(byGithub("jlwaugh").kind, "agent", "the registry's copy of a login wins over the local files");
    assert.equal(byGithub("stale-member").nearAccount, "payout.reg-agent.testnet", "the registry's newer admission beats the store's older one");
    // A fresh board admission keeps its place: the registry's older copy of
    // the login, read again, does not revert what an owner just admitted.
    admit({ nearAccount: "newcomer.admitted.testnet", name: "Newcomer", skills: ["code"], links: { github: "https://github.com/newcomer" }, kind: "agent" });
    assert.equal(byGithub("newcomer").nearAccount, "newcomer.admitted.testnet");
    serve({ json: { data: [
      member({ githubLogin: "newcomer", kind: "agent", admissions: [{ network: "testnet", status: "admitted", proofUrl: "u", admittedAt: "2026-10-01T00:00:00Z" }] }),
      member(),
      member({ githubLogin: "jlwaugh", name: "Registry James", skills: ["code"], nearAccount: "dashboard.jlwaugh.testnet", accounts: [{ network: "testnet", account: "payout.jlwaugh.testnet" }] }),
      member({ githubLogin: "stale-member", admissions: [{ network: "testnet", status: "admitted", proofUrl: "https://github.com/MultiAgency/kanban-sandbox/issues/10", admittedAt: "2026-10-01T00:00:00Z" }] }),
    ] } });
    await refreshRegistry();
    assert.equal(byGithub("newcomer").nearAccount, "newcomer.admitted.testnet", "an admission newer than the registry's read stands");
    assert.equal(byGithub("newcomer").kind, "agent");
    const health = registryHealth();
    assert.equal(health.url, REGISTRY_URL);
    assert.equal(health.members, 4);
    assert.ok(health.last_success_at);
    assert.equal(health.last_error, null);
  });

  test("an outage keeps the last good roster and reports the failure", async () => {
    process.env.REGISTRY_URL = REGISTRY_URL;
    const before = registryHealth();
    const failing = serve({ json: { code: "INTERNAL_SERVER_ERROR", status: 503, message: "registry is down" } }, 503);
    await refreshRegistry();
    assert.equal(failing.length, 1);
    assert.equal(byGithub("reg-agent").nearAccount, "payout.reg-agent.testnet", "an outage drops nobody");
    assert.equal(byGithub("newcomer").nearAccount, "newcomer.admitted.testnet");
    let health = registryHealth();
    assert.match(health.last_error.message, /HTTP 503 — registry is down/);
    assert.equal(health.members, before.members);
    assert.equal(health.last_success_at, before.last_success_at);
    // Unreachable counts the same: the failure is recorded, the copy stays.
    globalThis.fetch = async () => { throw new Error("connect ECONNREFUSED"); };
    await refreshRegistry();
    health = registryHealth();
    assert.match(health.last_error.message, /ECONNREFUSED/);
    assert.equal(byGithub("reg-agent").nearAccount, "payout.reg-agent.testnet");
  });
});
