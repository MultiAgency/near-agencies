#!/usr/bin/env node
// Records one review round of a real pull request as an eval case: the diff
// from its base, the description as it stood when the round ran, and the
// comments and inline threads left before then. With --prev, also the diff
// since an earlier head, for a round that reviews only the change. The
// case.json it writes has no expectations yet: add them by hand.
//
//   node evals/ai-review/record.mjs <name> --pr N --base SHA --head SHA --at ISO [--prev SHA]
//
// Needs gh (reading MultiAgency/near-agencies) and git history for the SHAs.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "MultiAgency/near-agencies";
const here = new URL(".", import.meta.url).pathname;
const [name, ...rest] = process.argv.slice(2);
const opt = key => {
  const i = rest.indexOf(`--${key}`);
  return i === -1 ? undefined : rest[i + 1];
};
const [pr, base, head, at, prev] = [Number(opt("pr")), opt("base"), opt("head"), opt("at"), rest.includes("--prev") ? opt("prev") : null];
if (!name || !pr || !base || !head || !at) {
  console.error("usage: record.mjs <name> --pr N --base SHA --head SHA --at ISO [--prev SHA]");
  process.exit(2);
}
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 26 });
const gh = (...a) => JSON.parse(execFileSync("gh", a, { encoding: "utf8", maxBuffer: 1 << 26 }));
// A squash-merged pull request's commits aren't on any branch: fetch its head.
execFileSync("git", ["fetch", "-q", "origin", `+refs/pull/${pr}/head:refs/remotes/origin/pr/${pr}`]);
const dir = join(here, "cases", name);
mkdirSync(dir, { recursive: true });

writeFileSync(join(dir, "pr.diff"), git("diff", `${base}...${head}`));
if (prev) writeFileSync(join(dir, "delta.diff"), git("diff", `${prev}...${head}`));

const query = `{repository(owner:"MultiAgency",name:"near-agencies"){pullRequest(number:${pr}){title body userContentEdits(first:100){nodes{editedAt diff}}}}}`;
const p = gh("api", "graphql", "-f", `query=${query}`).data.repository.pullRequest;
const body = p.userContentEdits.nodes.filter(e => e.editedAt <= at).sort((a, b) => a.editedAt.localeCompare(b.editedAt)).at(-1)?.diff ?? p.body;
writeFileSync(join(dir, "pr.md"), `title:\t${p.title}\n--\n${body}\n`);

const before = c => c.created_at < at;
const trim = c => ({ id: c.id, user: { login: c.user.login }, created_at: c.created_at, body: c.body, path: c.path, line: c.line, original_line: c.original_line, in_reply_to_id: c.in_reply_to_id });
writeFileSync(join(dir, "comments.json"), JSON.stringify(gh("api", "--paginate", "--slurp", `repos/${REPO}/issues/${pr}/comments`).flat().filter(before).map(trim), null, 1));
writeFileSync(join(dir, "inline.json"), JSON.stringify(gh("api", "--paginate", "--slurp", `repos/${REPO}/pulls/${pr}/comments`).flat().filter(before).map(trim), null, 1));
writeFileSync(join(dir, "case.json"), JSON.stringify({ what: "", pr, base: git("rev-parse", base).trim(), head: git("rev-parse", head).trim(), expect: {} }, null, 1) + "\n");
console.log(`recorded ${dir}`);
