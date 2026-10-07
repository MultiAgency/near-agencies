// A fetch stub for the staging-approval smoke entry: loaded only in the
// spawned process, through NODE_OPTIONS=--import, it answers just enough of
// GitHub's API — and the coordinator's roster endpoint — for
// scripts/staging-approval.mjs to run decide() offline on one open pull
// request that changes no file. That is the path whose log line crashed
// production with a describe-before-initialization (#130): the entry reaches
// it, so a regression there fails the suite instead of staging's next live
// run. A hold decides nothing and posts nothing. Any read the stub does not
// answer answers 404, so an unexpected read fails loudly rather than
// reaching the network.
const PULL_REQUEST = {
  number: 1,
  state: "open",
  user: { login: "jlwaugh" },
  base: { ref: "staging" },
  head: { sha: "0".repeat(40), repo: { full_name: "MultiAgency/near-agencies" } },
  changed_files: 0,
  commits: 0,
  body: "",
};

const base64 = value => Buffer.from(value, "utf8").toString("base64");
const reply = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const routes = [
  [/\/commits\/[0-9a-f]{40}\/pulls/, []],
  [/\/pulls\/1\/files/, []],
  [/\/pulls\/1\/commits/, []],
  [/\/pulls\/1$/, PULL_REQUEST],
  [/\/orgs\/[^/]+\/teams\/internal\/members/, [{ login: "jlwaugh" }]],
  [/\/commits\/[0-9a-f]{40}\/check-runs/, { check_runs: [{ name: "test", id: 1, status: "completed", conclusion: "success" }], total_count: 1 }],
  [/\/contents\/\.github\/CODEOWNERS/, { content: base64("* @jlwaugh\n") }],
  [/\/contents\/roster\.json/, { content: base64('{"builders":[]}') }],
  [/\/actions\/artifacts/, { artifacts: [] }],
  // The reviewer's approval standing at the head, for the edited-body entry
  // (#168): the hold that follows an edit dismisses it.
  [/\/pulls\/1\/reviews\?/, [{ id: 99, user: { login: "multai-builder" }, state: "APPROVED", commit_id: "0".repeat(40) }]],
  [/\/pulls\/1\/reviews\/99\/dismissals/, { id: 99, state: "DISMISSED" }],
];

globalThis.fetch = (url, init) => {
  const { host, href } = new URL(url);
  // The coordinator's roster read (ROSTER_URL points at this loopback host so
  // it lands here): not a member, which the verdict judges by roster.json.
  if (host.startsWith("127.0.0.1")) return reply({ stage: "none" });
  if (host !== "api.github.com") throw new Error(`the stub answers only GitHub and the roster URL, not ${href}`);
  for (const [pattern, body] of routes) {
    if (pattern.test(href)) return reply(body);
  }
  return new Response("not stubbed", { status: 404 });
};
