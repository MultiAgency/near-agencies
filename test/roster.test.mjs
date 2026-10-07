import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { network } from "../lib/network.mjs";

// Requests go only to the fetch stub each test installs: the registry's URL
// and NEAR's RPC, nothing else. No registry or RPC is contacted.
process.env.GITHUB_TOKEN = "test-token";

const REGISTRY_URL = "https://registry.test/api/rpc/builders";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.REGISTRY_URL;
});

// Every test loads its own roster module over its own admitted store, so the
// registry cache, its timestamps and the ensured-payee memory start fresh and
// no test depends on what an earlier one read. Passing a scratch back in
// stands in for a restart on the same volume.
let loads = 0;
const roster = async (scratch = mkdtempSync(join(tmpdir(), "registry-"))) => {
  writeFileSync(join(scratch, "roster-admitted.json"), JSON.stringify({ builders: [
    // A member an owner admitted on the board, whom the registry does not
    // have, and one whose stamped admission the registry's newer copy of the
    // same login replaces.
    { nearAccount: "local.admitted.testnet", name: "Local admitted", skills: ["review"], links: { github: "https://github.com/local-member" }, kind: "human" },
    { nearAccount: "stale.local.testnet", name: "Stale admitted", skills: ["writing"], links: { github: "https://github.com/stale-member" }, kind: "agent", admittedAt: "2026-09-01T00:00:00Z" },
  ] }));
  process.env.ADMITTED_FILE = join(scratch, "roster-admitted.json");
  return { scratch, ...await import(`../lib/roster.mjs?test=${++loads}`) };
};

const REGISTRY_FILE = scratch => join(scratch, `roster-registry.${network.networkId}.json`);

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

// Serves the canned reply on the registry's URL, and on NEAR's RPC a USDC
// storage view answering `registered` for every account (so the payee pass
// confirms each without paying anything); both are recorded, anything else
// fails loudly.
const serve = (body, status = 200, { registered = true } = {}) => {
  const registry = [];
  const viewed = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.startsWith(REGISTRY_URL)) {
      registry.push({ url: u, method: options.method, body: options.body });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    if (u.startsWith(network.rpc)) {
      const rpc = JSON.parse(options.body);
      assert.equal(rpc.params.method_name, "storage_balance_of");
      viewed.push(JSON.parse(Buffer.from(rpc.params.args_base64, "base64").toString()).account_id);
      const value = registered ? { total: "12500000000000000000000", available: "0" } : null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { block_height: 1, block_hash: "x", result: [...Buffer.from(JSON.stringify(value))] } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return { registry, viewed };
};

describe("the shared member registry", () => {
  test("with REGISTRY_URL unset, the roster is the local files and nothing is fetched", async () => {
    const { refreshRegistry, byGithub, registryHealth } = await roster();
    const stub = serve({ json: { data: [member()] } });
    await refreshRegistry();
    assert.equal(stub.registry.length, 0);
    assert.equal(byGithub("multi-agency").nearAccount, "agent.agency.testnet");
    assert.equal(byGithub("jlwaugh").nearAccount, "reviewer.agency.testnet");
    assert.equal(byGithub("local-member").nearAccount, "local.admitted.testnet");
    assert.equal(byGithub("reg-agent"), null);
    assert.equal(registryHealth(), null);
  });

  test("a member admitted here joins the roster, eligible, with the registry's fields", async () => {
    process.env.REGISTRY_URL = REGISTRY_URL;
    const { refreshRegistry, byGithub, registryHealth } = await roster();
    const stub = serve({ json: { data: [
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
    assert.equal(stub.registry.length, 1);
    assert.equal(stub.registry[0].url, "https://registry.test/api/rpc/builders/listMembers");
    assert.equal(stub.registry[0].method, "POST");
    assert.deepEqual(JSON.parse(stub.registry[0].body), { json: { network: "testnet", status: "admitted" } });
    const listed = byGithub("reg-agent");
    assert.equal(listed.kind, "agent");
    assert.equal(listed.name, "Registry agent");
    assert.deepEqual(listed.skills, ["research", "writing"]);
    assert.equal(listed.operator, "reg-operator");
    assert.equal(listed.proof, "https://github.com/MultiAgency/kanban-sandbox/issues/9");
    assert.equal(byGithub("mainnet-only"), null, "admitted only on the other network");
    assert.equal(byGithub("still-pending"), null, "not admitted yet");
    assert.equal(byGithub("no-account-here"), null, "nowhere on this network to be paid at");
    const { eligibility } = await import("../lib/seats.mjs");
    assert.equal(eligibility({ labels: ["ready", "agent-eligible"], skills: [] }, listed), null);
    assert.equal(registryHealth().members, 3, "reg-agent, the registry's jlwaugh and its stale-member copy");
  });

  test("a record without a known kind or string skills is skipped, and /api/health says so", async () => {
    process.env.REGISTRY_URL = REGISTRY_URL;
    const { refreshRegistry, byGithub, registryHealth } = await roster();
    serve({ json: { data: [
      member(),
      // An unchecked kind passes eligibility's gates both ways: neither human
      // enough for human-only work nor agent enough to be refused the rest.
      member({ githubLogin: "kind-Agent", kind: "Agent" }),
      member({ githubLogin: "kind-bot", kind: "bot" }),
      member({ githubLogin: "kind-missing", kind: undefined }),
      member({ githubLogin: "skills-numbers", skills: ["research", 7] }),
      member({ githubLogin: "skills-object", skills: { 0: "research" } }),
    ] } });
    await refreshRegistry();
    assert.equal(byGithub("reg-agent").kind, "agent");
    for (const login of ["kind-Agent", "kind-bot", "kind-missing", "skills-numbers", "skills-object"]) {
      assert.equal(byGithub(login), null, `${login} stays off the roster`);
    }
    const health = registryHealth();
    assert.equal(health.members, 1);
    assert.equal(health.skipped, 5);
  });

  test("the payout account is the member's account for this network, never the dashboard identity", async () => {
    process.env.REGISTRY_URL = REGISTRY_URL;
    const { refreshRegistry, byGithub } = await roster();
    serve({ json: { data: [
      member(),
      member({ githubLogin: "jlwaugh", name: "Registry James", skills: ["code"], nearAccount: "dashboard.jlwaugh.testnet", accounts: [{ network: "testnet", account: "payout.jlwaugh.testnet" }] }),
    ] } });
    await refreshRegistry();
    assert.equal(byGithub("reg-agent").nearAccount, "payout.reg-agent.testnet");
    assert.notEqual(byGithub("reg-agent").nearAccount, "dashboard.reg-agent.testnet");
    assert.equal(byGithub("jlwaugh").nearAccount, "payout.jlwaugh.testnet");
  });

  test("a registry read makes no storage_balance_of view, registered or not", async () => {
    process.env.REGISTRY_URL = REGISTRY_URL;
    const { refreshRegistry, registryHealth } = await roster();
    let stub = serve({ json: { data: [
      member(),
      member({ githubLogin: "second", accounts: [{ network: "testnet", account: "payout.second.testnet" }] }),
    ] } });
    await refreshRegistry();
    assert.deepEqual(stub.viewed, [], "a registry read touches no chain");
    assert.equal(registryHealth().last_error, null);
    // An unregistered member's read is no different: still no view.
    stub = serve({ json: { data: [member({ githubLogin: "third", accounts: [{ network: "testnet", account: "payout.third.testnet" }] })] } }, 200, { registered: false });
    await refreshRegistry();
    assert.deepEqual(stub.viewed, []);
    assert.equal(registryHealth().last_error, null);
  });

  test("roster.json and the admitted store stay as the fallback, an admission stays live", async () => {
    process.env.REGISTRY_URL = REGISTRY_URL;
    const { admit, byGithub, refreshRegistry, registryHealth } = await roster();
    serve({ json: { data: [
      member(),
      member({ githubLogin: "jlwaugh", name: "Registry James", skills: ["code"], nearAccount: "dashboard.jlwaugh.testnet", accounts: [{ network: "testnet", account: "payout.jlwaugh.testnet" }] }),
      member({ githubLogin: "stale-member", admissions: [{ network: "testnet", status: "admitted", proofUrl: "https://github.com/MultiAgency/kanban-sandbox/issues/10", admittedAt: "2026-10-01T00:00:00Z" }] }),
    ] } });
    await refreshRegistry();
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
    const { refreshRegistry, byGithub, registryHealth } = await roster();
    serve({ json: { data: [member()] } });
    await refreshRegistry();
    const before = registryHealth();
    const failing = serve({ json: { code: "INTERNAL_SERVER_ERROR", status: 503, message: "registry is down" } }, 503);
    await refreshRegistry();
    assert.equal(failing.registry.length, 1);
    assert.equal(byGithub("reg-agent").nearAccount, "payout.reg-agent.testnet", "an outage drops nobody");
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

  test("the last good read survives a restart, even while the registry stays down", async () => {
    process.env.REGISTRY_URL = REGISTRY_URL;
    const first = await roster();
    serve({ json: { data: [member()] } });
    await first.refreshRegistry();
    assert.equal(first.byGithub("reg-agent").nearAccount, "payout.reg-agent.testnet");
    const savedAt = first.registryHealth().last_success_at;
    assert.ok(savedAt);
    // The copy is on the volume, beside the admitted store.
    const saved = JSON.parse(readFileSync(REGISTRY_FILE(first.scratch), "utf8"));
    assert.equal(saved.at, savedAt);
    assert.deepEqual(saved.members.map(m => m.github), ["reg-agent"]);
    assert.equal(saved.members[0].nearAccount, "payout.reg-agent.testnet");

    // A restart on the same volume, the registry now unreachable: the roster
    // is whole as the module loads, before any read could answer.
    const second = await roster(first.scratch);
    assert.equal(second.byGithub("reg-agent").nearAccount, "payout.reg-agent.testnet", "a restart during an outage drops nobody");
    assert.equal(second.registryHealth().last_success_at, savedAt, "the stamp is the read that produced the copy");
    // And a failing read on the new process keeps it there.
    globalThis.fetch = async () => { throw new Error("connect ECONNREFUSED"); };
    await second.refreshRegistry();
    assert.equal(second.byGithub("reg-agent").nearAccount, "payout.reg-agent.testnet");
    assert.match(second.registryHealth().last_error.message, /ECONNREFUSED/);
  });
});
