import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, test } from "node:test";
import { bytesToBase64, privateKeyFromRandom, signNep413Message } from "@fastnear/utils";

import { network } from "../lib/network.mjs";

// This file's own stores and registry settings, pinned before the lib loads.
const scratch = mkdtempSync(join(tmpdir(), "registry-write-"));
const admittedFile = join(scratch, "roster-admitted.json");
writeFileSync(admittedFile, JSON.stringify({ builders: [] }));
process.env.ADMITTED_FILE = admittedFile;
process.env.GITHUB_TOKEN = "test-token";
process.env.REGISTRY_URL = "https://registry.test/api/rpc/builders";
const TOKEN = "registry-secret-sentinel";
process.env.REGISTRY_TOKEN = TOKEN;

const { putMember, putMemberBody, registryHealth } = await import("../lib/roster.mjs");
const { coordinatorHealth, cycle } = await import("../lib/coordinator.mjs");
const { joinIssue, joinMessage, newNonce, RECIPIENT } = await import("../lib/onboarding.mjs");
const { planWrites } = await import("../scripts/registry-backfill.mjs");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Captures console output while `run` executes; restores it afterwards.
const withLogs = async run => {
  const logs = [];
  const log = console.log, error = console.error;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
  try {
    return { value: await run(), logs };
  } finally {
    console.log = log;
    console.error = error;
  }
};

const builder = (overrides = {}) => ({
  nearAccount: "newcomer.testnet",
  name: "Newcomer",
  skills: ["research"],
  links: { github: "https://github.com/Newcomer" },
  kind: "human",
  ...overrides,
});

const agent = overrides => builder({
  nearAccount: "agent.testnet",
  name: "Some agent",
  skills: ["code"],
  links: { github: "https://github.com/Some-Agent" },
  kind: "agent",
  operator: "Operator-One",
  ...overrides,
});

const REGISTRY_URL = process.env.REGISTRY_URL;
const ISSUE_URL = "https://github.com/MultiAgency/kanban-sandbox/issues/7";

describe("the registry write (putMember)", () => {
  test("the body: logins lowercase, operatorGithubLogin exactly when kind is agent", () => {
    const now = "2026-10-04T12:00:00.000Z";
    assert.deepEqual(putMemberBody(builder(), { proof: ISSUE_URL, admittedAt: now }), { json: {
      githubLogin: "newcomer",
      network: "testnet",
      kind: "human",
      name: "Newcomer",
      skills: ["research"],
      account: { account: "newcomer.testnet", proof: ISSUE_URL },
      admission: { status: "admitted", proofUrl: ISSUE_URL, admittedAt: now },
    } });
    assert.deepEqual(putMemberBody(agent(), { proof: "u", admittedAt: now }).json, {
      githubLogin: "some-agent",
      network: "testnet",
      kind: "agent",
      operatorGithubLogin: "operator-one",
      name: "Some agent",
      skills: ["code"],
      account: { account: "agent.testnet", proof: "u" },
      admission: { status: "admitted", proofUrl: "u", admittedAt: now },
    });
  });

  test("posts to <REGISTRY_URL>/putMember with the token in its header, and reports overwrites", async () => {
    const writes = [];
    globalThis.fetch = async (url, options = {}) => {
      writes.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ json: { data: { overwritten: ["name", "skills"] } } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const { value, logs } = await withLogs(() => putMember(agent(), { proof: ISSUE_URL }));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, `${REGISTRY_URL}/putMember`);
    assert.equal(writes[0].headers["x-registry-token"], TOKEN);
    assert.ok(new Date(writes[0].body.json.admission.admittedAt) > new Date(Date.now() - 60_000), "admittedAt is now");
    assert.deepEqual(value, { ok: true, overwritten: ["name", "skills"] });
    assert.ok(logs.some(line => line.includes("some-agent") && line.includes("testnet") && line.includes("name, skills")), "the overwrite is logged with login, network and fields");
    const health = registryHealth();
    assert.equal(health.overwritten[0].login, "some-agent");
    assert.equal(health.overwritten[0].network, "testnet");
    assert.deepEqual(health.overwritten[0].fields, ["name", "skills"]);
  });

  test("a 5xx is retried, and success after retries reports no failure", async () => {
    const statuses = [500, 503];
    const seen = [];
    globalThis.fetch = async (url, options = {}) => {
      seen.push(JSON.parse(options.body).json.githubLogin);
      const status = statuses.shift() ?? 200;
      return new Response(JSON.stringify({ json: { data: { overwritten: [] } } }), { status, headers: { "content-type": "application/json" } });
    };
    const { value } = await withLogs(() => putMember(builder(), { proof: "u" }));
    assert.deepEqual(seen, ["newcomer", "newcomer", "newcomer"]);
    assert.equal(value.ok, true);
    assert.equal(registryHealth().last_write_error, null);
  });

  test("a 5xx that outlasts the retries reports the failure on /api/health", async () => {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      return new Response(JSON.stringify({ json: { code: "INTERNAL", status: 500, message: "registry is down" } }), { status: 500, headers: { "content-type": "application/json" } });
    };
    const { value } = await withLogs(() => putMember(builder(), { proof: "u" }));
    assert.equal(attempts, 3);
    assert.equal(value.ok, false);
    assert.match(value.problem, /HTTP 500 — registry is down/);
    assert.match(registryHealth().last_write_error.message, /registry is down/);
    assert.equal(registryHealth().last_write_error.login, "newcomer");
  });

  test("a 409 and a 403 are the registry's verdict: reported with its message, never retried", async () => {
    for (const [status, message] of [[409, "the account belongs to another member"], [403, "an identity change the registry refuses"]]) {
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        return new Response(JSON.stringify({ json: { code: "CONFLICT", status, message } }), { status, headers: { "content-type": "application/json" } });
      };
      const { value } = await withLogs(() => putMember(builder(), { proof: "u" }));
      assert.equal(attempts, 1, `HTTP ${status} is not retried`);
      assert.match(value.problem, new RegExp(`HTTP ${status} — ${message}`));
      assert.match(registryHealth().last_write_error.message, new RegExp(message));
    }
  });

  test("another member's successful write does not retire a failure; the same login's does", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ json: { data: {} } }), { status: 200, headers: { "content-type": "application/json" } });
    // The previous test left newcomer's failure as the last write error.
    await withLogs(() => putMember(builder({ links: { github: "https://github.com/other" } }), { proof: "u" }));
    assert.match(registryHealth().last_write_error.message, /the account belongs to another member|an identity change/, "another login's success retires nothing");
    assert.equal(registryHealth().last_write_error.login, "newcomer");
    await withLogs(() => putMember(builder(), { proof: "u" }));
    assert.equal(registryHealth().last_write_error, null, "the same login's successful write does retire it");
  });

  test("the token appears in no output: not in logs, not in a problem, not in health", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ json: { code: "X", status: 500, message: "boom" } }), { status: 500, headers: { "content-type": "application/json" } });
    const { value, logs } = await withLogs(() => putMember(builder(), { proof: "u" }));
    globalThis.fetch = async () => { throw new Error("connect ECONNREFUSED"); };
    const second = await withLogs(() => putMember(builder({ links: { github: "https://github.com/other" } }), { proof: "u" }));
    const everything = JSON.stringify([...logs, ...second.logs, value, second.value, registryHealth()]);
    assert.ok(!everything.includes(TOKEN), "the token leaked");
    assert.match(second.value.problem, /ECONNREFUSED/);
  });

  test("with no token, or no REGISTRY_URL, nothing is attempted and nothing reported", async () => {
    let fetched = 0;
    globalThis.fetch = async () => { fetched++; throw new Error("should not fetch"); };
    delete process.env.REGISTRY_TOKEN;
    assert.equal(await putMember(builder(), { proof: "u" }), null);
    delete process.env.REGISTRY_URL;
    process.env.REGISTRY_TOKEN = TOKEN;
    assert.equal(await putMember(builder(), { proof: "u" }), null);
    assert.equal(fetched, 0);
    assert.equal(registryHealth(), null, "no REGISTRY_URL, no registry section at all");
    process.env.REGISTRY_URL = REGISTRY_URL;
    process.env.REGISTRY_TOKEN = TOKEN;
    globalThis.fetch = async () => new Response(JSON.stringify({ json: { data: {} } }), { status: 200, headers: { "content-type": "application/json" } });
    assert.equal((await putMember(builder(), { proof: "u" })).ok, true);
  });
});

// --- /admit writes the shared registry ---------------------------------------

// A signed join request the board would verify, posted as an issue.
const signedRequest = fields => {
  const message = joinMessage(fields, new Date(Date.now() - 60_000));
  const nonce = newNonce();
  const { publicKey, signature } = signNep413Message({ message, nonce: Buffer.from(nonce, "base64"), recipient: RECIPIENT }, privateKeyFromRandom());
  return { message, nonce, recipient: RECIPIENT, accountId: fields.near, publicKey, signature: bytesToBase64(signature) };
};

const person = { github: "newcomer", near: "newcomer.testnet", name: "Newcomer", kind: "human", skills: ["research"] };
const agentFields = { github: "some-agent", near: "some-agent.testnet", name: "Some agent", kind: "agent", skills: ["code"], operator: "operator-one" };

const OPEN = "https://api.github.com/repos/MultiAgency/kanban-sandbox/issues?state=open&per_page=100";
const ENGAGED = "https://api.github.com/repos/MultiAgency/kanban-sandbox/issues?labels=engagement";

// The board, NEAR's RPC and the registry on one stub. `registry` answers each
// putMember (the last entry repeats); everything is recorded.
const board = ({ join, registry = [] } = {}) => {
  const state = { comments: [], registry: [], closed: [] };
  const replies = [...registry];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? "GET";
    const u = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.startsWith(REGISTRY_URL)) {
      state.registry.push({ url: u, headers: options.headers, body: JSON.parse(options.body) });
      const reply = replies.length > 1 ? replies.shift() : replies[0] ?? { status: 200, body: { json: { data: { overwritten: [] } } } };
      return json(reply.body, reply.status);
    }
    if (u.startsWith(network.rpc)) {
      const rpc = JSON.parse(options.body);
      // A key query answers flat (permission at the top of result); a contract
      // view answers with its value base64-ready under result.result.
      const keyQuery = rpc.params.request_type === "view_access_key";
      const value = keyQuery ? { nonce: 1, permission: "FullAccess" } : { total: "12500000000000000000000" };
      return json({ jsonrpc: "2.0", id: rpc.id, result: keyQuery ? value : { block_height: 1, block_hash: "x", result: [...Buffer.from(JSON.stringify(value))] } });
    }
    if (u === "https://api.github.com/user") return json({ login: "multi-agency" });
    if (u.includes("/search/issues")) return json({ items: [] });
    if (u.includes("/collaborators/")) return json({ role_name: "admin" });
    if (u === OPEN) return json([join.issue]);
    if (u.startsWith(ENGAGED)) return json([]);
    if (u.includes("/issues?state=closed&labels=")) return json([]);
    if (u.includes(`/issues/${join.issue.number}/comments?per_page`) && method === "GET") return json([join.command]);
    if (u.endsWith(`/issues/${join.issue.number}/comments`) && method === "POST") {
      state.comments.push({ number: join.issue.number, body: JSON.parse(options.body).body });
      return json({});
    }
    if (u.endsWith(`/issues/${join.issue.number}`) && method === "PATCH") {
      state.closed.push(JSON.parse(options.body));
      return json(join.issue);
    }
    if (u.includes("/comments/") && u.includes("/reactions")) return json(method === "GET" ? [] : {});
    if (u.endsWith(`/issues/${join.issue.number}/labels`)) return json({});
    throw new Error(`unexpected fetch: ${method} ${u}`);
  };
  return state;
};

const joinIssueFor = fields => {
  const request = signedRequest(fields);
  const { title, body } = joinIssue(request);
  return {
    number: 7,
    title,
    html_url: ISSUE_URL,
    state: "open",
    user: { login: fields.github },
    assignees: [],
    labels: [{ name: "roster-verified" }],
    created_at: new Date(Date.now() - 30_000).toISOString(),
    updated_at: new Date(Date.now() - 30_000).toISOString(),
    body,
  };
};

const admitRun = async ({ fields = person, registry } = {}) => {
  const issue = joinIssueFor(fields);
  const command = { id: 501, user: { login: "owner-jl" }, body: "/admit", html_url: `${ISSUE_URL}#issuecomment-501`, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const state = board({ join: { issue, command }, registry });
  const { logs } = await withLogs(() => cycle());
  // The cycle swallows its failures into coordinatorHealth; a stub this test
  // forgot to serve would otherwise look like a quiet no-op.
  assert.equal(coordinatorHealth().last_error, null, `the cycle failed: ${coordinatorHealth().last_error?.message}`);
  return { state, logs };
};

describe("/admit writes the shared registry", () => {
  test("an owner's /admit writes the verified person: the exact body, the token only in the header", async () => {
    const { state, logs } = await admitRun();
    assert.equal(state.registry.length, 1);
    assert.equal(state.registry[0].url, `${REGISTRY_URL}/putMember`);
    assert.equal(state.registry[0].headers["x-registry-token"], TOKEN);
    const body = state.registry[0].body.json;
    assert.equal(body.githubLogin, "newcomer");
    assert.equal(body.network, "testnet");
    assert.equal(body.kind, "human");
    assert.equal(body.operatorGithubLogin, undefined);
    assert.equal(body.account.account, "newcomer.testnet");
    assert.equal(body.account.proof, ISSUE_URL);
    assert.equal(body.admission.status, "admitted");
    assert.equal(body.admission.proofUrl, ISSUE_URL);
    assert.ok(new Date(body.admission.admittedAt) > new Date(Date.now() - 60_000));
    // The admission also stands locally, and the command is answered with no
    // registry failure to report.
    assert.ok(state.comments.some(c => c.body.startsWith("**Admitted** by @owner-jl.")), state.comments.map(c => c.body).join("|"));
    assert.ok(state.comments.every(c => !/registry/.test(c.body)));
    assert.ok(logs.every(line => !line.includes(TOKEN)));
  });

  test("an agent carries its operator's login, lowercased", async () => {
    const { state } = await admitRun({ fields: agentFields });
    assert.equal(state.registry.length, 1);
    assert.equal(state.registry[0].body.json.kind, "agent");
    assert.equal(state.registry[0].body.json.operatorGithubLogin, "operator-one");
    assert.equal(state.registry[0].body.json.githubLogin, "some-agent");
  });

  test("a 409 is reported on the join issue with the registry's message; the admission stays", async () => {
    const { state } = await admitRun({ registry: [{ status: 409, body: { json: { code: "CONFLICT", status: 409, message: "the account belongs to another member" } } }] });
    assert.equal(state.registry.length, 1, "a 409 is not retried");
    const comment = state.comments.find(c => c.body.includes("registry"));
    assert.match(comment.body, /the account belongs to another member/);
    assert.match(registryHealth().last_write_error.message, /the account belongs to another member/);
    assert.ok(state.comments.some(c => c.body.startsWith("**Admitted** by @owner-jl.")), "the admission itself stands");
  });

  test("a registry outage is retried, then reported on the join issue and in health", async () => {
    const { state } = await admitRun({ registry: [{ status: 500, body: { json: { code: "X", status: 500, message: "registry is down" } } }] });
    assert.equal(state.registry.length, 3, "5xx writes are retried");
    const comment = state.comments.find(c => c.body.includes("registry"));
    assert.match(comment.body, /registry is down/);
    assert.match(registryHealth().last_write_error.message, /registry is down/);
  });

  test("with REGISTRY_TOKEN unset, /admit behaves exactly as before the registry: no write, no failure", async () => {
    delete process.env.REGISTRY_TOKEN;
    // Health keeps the last write failure from earlier tests; what this cycle
    // must not do is report a new one.
    const before = registryHealth()?.last_write_error ?? null;
    try {
      const { state, logs } = await admitRun();
      assert.equal(state.registry.length, 0);
      assert.equal(registryHealth().last_write_error, before);
      const comment = state.comments.find(c => c.body.startsWith("**Admitted**"));
      assert.ok(comment, "the admission is answered as always");
      assert.ok(!comment.body.includes("registry"));
      assert.ok(logs.every(line => !line.includes("putMember")));
    } finally {
      process.env.REGISTRY_TOKEN = TOKEN;
    }
  });
});

// --- the backfill script -----------------------------------------------------

const rosterRecord = (login, overrides = {}) => ({
  nearAccount: `${login.replace(/-/g, ".")}.testnet`,
  name: login,
  skills: ["research"],
  links: { github: `https://github.com/${login}` },
  kind: "human",
  ...overrides,
});

describe("the registry backfill", () => {
  test("orders people first with the agents' operators first, agents last; logins lowercase; operator exactly on agents", () => {
    const commitFor = () => ({ url: "https://github.com/MultiAgency/near-agencies/commit/abc", date: "2026-09-27T23:18:01-04:00", sha: "abc" });
    const members = [
      rosterRecord("Stray-Human"),
      rosterRecord("Some-Agent", { kind: "agent", operator: "Operator-One", nearAccount: "some.agent.testnet" }),
      rosterRecord("Operator-One"),
      rosterRecord("Second-Agent", { kind: "agent", operator: "Operator-Two", nearAccount: "second.agent.testnet" }),
      rosterRecord("Operator-Two"),
    ];
    const { writes, problems, fallbacks } = planWrites(members, { commitFor });
    assert.deepEqual(writes.map(w => w.login), ["operator-one", "operator-two", "stray-human", "some-agent", "second-agent"]);
    assert.equal(fallbacks.length, 10, "every entry without its own proof or stamp uses the commit fallback");
    assert.deepEqual(problems, []);
    const bodies = writes.map(w => w.body.json);
    assert.ok(bodies.every(b => b.githubLogin === b.githubLogin.toLowerCase()));
    assert.deepEqual(bodies.filter(b => b.kind === "agent").map(b => b.operatorGithubLogin), ["operator-one", "operator-two"]);
    assert.ok(bodies.filter(b => b.kind === "human").every(b => b.operatorGithubLogin === undefined));
    assert.deepEqual([...new Set(bodies.map(b => b.network))], ["testnet"]);
  });

  test("records with a join issue keep it; problems are listed, never written", () => {
    const members = [
      rosterRecord("joined", { proof: "https://github.com/MultiAgency/kanban-sandbox/issues/42", admittedAt: "2026-09-29T23:56:41-04:00" }),
      rosterRecord("no-kind", { kind: undefined }),
      rosterRecord("lonely-agent", { kind: "agent", operator: "nobody-here", nearAccount: "lonely.testnet" }),
      rosterRecord("ghost-agent", { kind: "agent", operator: "no-kind", nearAccount: "ghost.testnet" }),
      rosterRecord("grounded", { nearAccount: undefined }),
      rosterRecord("orphan-agent", { kind: "agent", operator: "grounded", nearAccount: "orphan.testnet", proof: "https://github.com/MultiAgency/kanban-sandbox/issues/9", admittedAt: "2026-09-30T00:00:00.000Z" }),
    ];
    const { writes, problems } = planWrites(members, { commitFor: () => null });
    assert.deepEqual(writes.map(w => w.login), ["joined"]);
    assert.equal(writes[0].proof.from, "record");
    assert.equal(writes[0].admittedAt.from, "record");
    assert.equal(problems.length, 5);
    assert.match(problems[0], /no-kind.*kind must be one of/);
    assert.match(problems[1], /lonely-agent.*not among the members/);
    assert.match(problems[2], /ghost-agent.*not a human member/);
    assert.match(problems[3], /grounded.*no testnet account/);
    assert.match(problems[4], /orphan-agent.*grounded has no writable record/, "an agent whose operator will not be written is a problem, not a clean write");
    // Nothing can prove an entry with no join issue and no commit history.
    const unprovable = planWrites([rosterRecord("mystery")], { commitFor: () => null });
    assert.deepEqual(unprovable.writes, []);
    assert.match(unprovable.problems[0], /mystery.*no join issue.*no commit/);
  });

  test("a dry run prints every write and the commit fallback and writes nothing; a real run writes people before agents", async () => {
    const repo = mkdtempSync(join(tmpdir(), "backfill-"));
    const gitIn = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    // Async on purpose: a synchronous exec would block this process's event
    // loop, and the registry server this test serves would never answer the
    // child's writes.
    const nodeIn = async (args, env) => (await promisify(execFile)("node", ["--no-warnings", ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } })).stdout;
    gitIn("init", "-b", "main");
    gitIn("config", "user.email", "test@example.com");
    gitIn("config", "user.name", "Test");
    gitIn("config", "commit.gpgsign", "false");
    gitIn("config", "tag.gpgsign", "false");
    gitIn("remote", "add", "origin", "git@github.com:MultiAgency/near-agencies.git");
    // Commits dated in the past, so the stamp a fallback takes (%cI) is one
    // this test can tell apart from "now".
    const dated = (...args) => execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: "2026-09-27T23:18:01-04:00", GIT_COMMITTER_DATE: "2026-09-27T23:18:01-04:00" },
    });
    const rosterIn = builders => writeFileSync(join(repo, "roster.json"), `${JSON.stringify({ builders }, null, 2)}\n`);
    rosterIn([rosterRecord("pat")]);
    gitIn("add", ".");
    dated("commit", "-m", "pat joins");
    const rootSha = gitIn("rev-parse", "HEAD").trim();
    rosterIn([
      rosterRecord("pat"),
      rosterRecord("rob-agent", { kind: "agent", operator: "pat", nearAccount: "rob.agent.testnet", proof: "https://github.com/MultiAgency/kanban-sandbox/issues/18" }),
    ]);
    gitIn("add", ".");
    dated("commit", "-m", "rob-agent joins");
    // A member admitted on the board: the store carries its own stamp.
    mkdirSync(join(repo, ".data"), { recursive: true });
    const admitted = join(repo, ".data", `roster-admitted.${network.networkId}.json`);
    writeFileSync(admitted, JSON.stringify({ builders: [rosterRecord("sam", { proof: "https://github.com/MultiAgency/near-agencies/issues/55", admittedAt: "2026-10-01T00:00:00.000Z" })] }));

    const env = { REGISTRY_URL: "https://registry.test/api/rpc/builders", ROSTER_FILE: join(repo, "roster.json"), ADMITTED_FILE: admitted };
    const dry = await nodeIn([fileURLToPath(new URL("../scripts/registry-backfill.mjs", import.meta.url)), "--dry-run"], env);
    assert.match(dry, /3 members to write/);
    assert.deepEqual([...dry.matchAll(/^\d+\. (\S+) —/gm)].map(m => m[1]), ["pat", "sam", "rob-agent"]);
    assert.match(dry, new RegExp(`commit/${rootSha.slice(0, 8)}`), "pat's proof is the commit that added the entry");
    assert.match(dry, /pat: proof from the commit that added the roster entry/);
    assert.match(dry, /Using the commit fallback/);
    assert.ok(!/^\s*sam:/m.test(dry.split("Using the commit fallback")[1] ?? ""), "sam keeps its own proof and stamp");
    assert.match(dry, /dry run: nothing was written/);
    assert.match(dry, /"githubLogin":"pat"/);
    assert.match(dry, /"operatorGithubLogin":"pat"/);
    assert.match(dry, /"githubLogin":"sam"/);

    // The real run writes through a registry this test serves, people first.
    const writes = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        writes.push({ url: request.url, token: request.headers["x-registry-token"], body: JSON.parse(body).json });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ json: { data: { overwritten: [] } } }));
      });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const out = await nodeIn([fileURLToPath(new URL("../scripts/registry-backfill.mjs", import.meta.url))], { ...env, REGISTRY_URL: `http://127.0.0.1:${port}/api/rpc/builders`, REGISTRY_TOKEN: TOKEN });
      assert.match(out, /3\/3 written/);
      assert.deepEqual(writes.map(w => w.body.githubLogin), ["pat", "sam", "rob-agent"]);
      assert.ok(writes.every(w => w.token === TOKEN && w.url === "/api/rpc/builders/putMember"));
      assert.equal(writes[2].body.operatorGithubLogin, "pat");
      assert.equal(writes[1].body.admission.admittedAt, "2026-10-01T00:00:00.000Z", "a record keeps its own stamp");
      assert.match(writes[0].body.admission.admittedAt, /^2026-09-2/, "pat's stamp is the commit's date");
    } finally {
      server.close();
    }
  });
});
