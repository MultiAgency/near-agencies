title:	feat: approve same-repo staging PRs in code, as @multai-builder
--
## Plan

Problem: #117 — the owner is the only merge path. Builds issue #77: approve same-repo staging pull requests in code, as @multai-builder, when every check in the issue holds for the pull request's current head SHA. Nobody's judgment is involved at that step — the AI review advises, and this code decides.

**What this PR adds** (the three files a non-owner may touch; the owner-only files follow under **Owner edits** as exact text):

- `lib/staging-approval.mjs` — the six checks as pure logic, no GitHub calls:
  1. the pull request targets `staging`;
  2. it comes from a branch of this repository, never a fork;
  3. its author is in team `internal`, is @multi-agency, or is a rostered agent whose operator is in team `internal` (#109 — agents are in no team; the roster, resolved by `lib/operator-approval.mjs`'s own combinators, says who they are and who answers for them; an unreadable team `internal` fails closed for every author, and an unreadable roster for every author the team read alone cannot allow);
  4. the `test` check passed (`testVerdict` resolves the check run);
  5. every changed file's last matching CODEOWNERS rule names @multai-builder — rules and gitignore-style matching are parsed from the base branch's `.github/CODEOWNERS` (`codeownersRules`, `codeownersMatches`, `ownersForPath`), so there is no second list and a new file fails closed; a rename counts as both its paths;
  6. the newest ai-review verdict artifact named for this pull request holds a verdict for its head SHA that parses and counts 0 Important findings (`verdictFrom`).
  `stagingApproval` returns approve only when all six hold; any single failure returns a hold whose reason names the check, for the job log. The verdict can only hold an approval back.
- `scripts/staging-approval.mjs` — the runner, in the shape of `scripts/operator-approval.mjs` (#93): it reads GitHub through `lib/github.mjs` as @multai-builder (the workflow maps `REVIEWER_TOKEN` to `GITHUB_TOKEN` and `ORG_TOKEN`), never checks out or runs the pull request's code, and posts an approving review only on approve. It finds candidate pull requests from the triggering run's own association, the commit's, and the verdict artifacts the triggering run just uploaded (`openCandidates`) and judges each on the head SHA the pull request answers with now — never on the triggering run's SHA, which a `pull_request_target` run reports as the base branch's head. Nothing a workflow run reports names the pull request the run reviewed — a `pull_request_target` run answers with the base branch as its head_branch and head_sha — so the deciding run is read through its verdict artifact: the newest artifact still held whose name carries the pull request's number (`ai-review-verdict-<number>`, written by the owner's workflow, whose Verdict step validates the count and writes the head SHA itself), with the run behind it taken from the artifact (`newestVerdictArtifact`). The verdict is downloaded with `gh run download`, never read from a comment, which a pull request could fake; one pull request's artifact can never decide another's; a run still going, failed, cancelled, or without its artifact holds; the SHA inside the artifact's verdict.json must be the head the pull request answers with now; and the run's own commit counts only when the base branch carries it — a check about the run, not the pull request, so a side branch's copy of the workflow can write nothing that decides. The roster is read beside the team as `scripts/operator-approval.mjs` reads it — roster.json at the base branch plus the coordinator's roster API (`ROSTER_URL`), combined by `combineRoster` from `lib/operator-approval.mjs`. A hold logs which check failed and exits 0; only a read that breaks exits non-zero; no "changes requested" is ever posted; a second firing for a SHA the reviewer already approved leaves the approval standing; and the approval posts only after a re-read finds the head SHA unmoved across the reads.
- `test/staging-approval.test.mjs` — one test per check plus the passing case, and tests for the parsing and artifact-selection helpers.

**How the script reads team membership, and the token permissions it needs.** Team reads go through `orgApi` (`lib/github.mjs`) at `GET /orgs/{org}/teams/{slug}/members`, paginated, one retry on a rejected or throttled answer — the same read `scripts/operator-approval.mjs` makes, now for the one team `internal`; the roster read beside it needs no token (roster.json is a contents read, and `ROSTER_URL` answers unauthenticated, like operator-approval's). `REVIEWER_TOKEN` therefore needs **Contents read** (CODEOWNERS and roster.json at the base branch, the pull request, its files and reviews), **Actions read** and **Checks read** (the ai-review runs and their verdict artifacts, and the `test` check runs) — the two reads beyond the issue's own short list, named here as the issue asks — plus **Pull requests write** (the approving review) and org **Members read** (team `internal`). It acts through `orgApi` for the team and `github()` for everything else; both tokens are the same secret.

**What could break.** Nothing reads `REVIEWER_TOKEN` until the owner commits the workflows below; before that the decision script is inert and the repo behaves as today. After: a hold is the expected outcome for every pull request the checks do not fit (forks, outside authors, files off the allowlist) — those keep waiting for a person exactly as now. The approval job's access to the `reviewer` Environment rests on the repository's default branch being `staging` (a `workflow_run` run carries the default branch as its ref, and that is the one branch the Environment allows); if the default branch ever moves, the Environment's deployment branches must move with it — noted in the workflow text.

## Verification

- `npm ci` clean; `npm run check` passes (syntax over all modules including the two new ones); `npm test` passes: **475 tests, 0 failures**, including the 42 in `test/staging-approval.test.mjs` — one per check (wrong base, fork, outside author, unreadable `internal`, a rostered agent judged on their operator, an unreadable roster holding only where it matters, pending/failed/missing test, uncovered file with the log naming it, empty change set, missing/malformed/older-SHA/non-zero-Important verdict), the passing case, a rename judged on both paths, and the parsing and verdict-artifact helpers (the newest artifact named for the pull request decides — including one whose `pull_request_target` run answers with `staging` as its head_branch — and a verdict for an older SHA approves nothing).
- The staging approval depends on owner-committed workflows and secrets, so end-to-end behavior activates only after the owner lands the texts below; the unit suite is the verification this PR can run itself.

## Owner edits

Exact text of each file only the owner can change, to commit after this merges. Nothing here is committed by this PR.

### 1. New: `.github/workflows/staging-approval.yml`

```yaml
name: staging-approval

# The code approval for staging pull requests (issue #77): when every check
# in the issue holds for a pull request's current head SHA, the review posts
# as @multai-builder — nobody's judgment is involved at that step; the AI
# review advises, and this code decides.
#
# The job runs from the base branch's checkout after `ci` and `ai-review`
# finish, and never checks out or runs the pull request's code. Everything
# uncertain holds: the decision script exits 0 on a hold, logging which
# check failed, and a push dismisses the approval (staging ruleset) so the
# next run decides again.
#
# REVIEWER_TOKEN lives only in the `reviewer` Environment, whose deployment
# branches are limited to `staging`. A workflow_run run carries the
# repository's default branch as its ref, and that branch is `staging`, so
# the run may read the Environment; if the default branch ever moves, the
# Environment's deployment branches must move with it.

on:
  workflow_run:
    workflows: [ci, ai-review]
    types: [completed]

jobs:
  approve:
    if: github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    environment: reviewer
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
        with:
          ref: staging
          fetch-depth: 1
      - name: Decide, and approve when every check holds
        run: node scripts/staging-approval.mjs
        env:
          SANDBOX_REPO: ${{ github.repository }}
          GITHUB_TOKEN: ${{ secrets.REVIEWER_TOKEN }}
          ORG_TOKEN: ${{ secrets.REVIEWER_TOKEN }}
```

No concurrency group: a firing is one cheap, fresh decision (the script leaves an existing approval standing), and a group keyed on the triggering run's head SHA would be the base branch's head for every ai-review firing — pending decisions for different pull requests would replace each other, and some pull requests would never be decided.

### 2. `.github/CODEOWNERS`: the allowlist block, appended after the existing rules (after `/.claude/`)

```codeowners
# Approved in code (issue #77): the reviewer account may approve these
# low-risk paths alone. The last matching rule decides, so this block must
# stay after every rule it narrows, and it never covers money or permission
# files, agents/, scripts/, server.mjs, public/skill.md, or the client's
# deposit transfer (public/app.js, public/index.html) — anything else keeps
# needing a person, and every new file fails closed.
/docs/                  @MultiAgency/internal @jlwaugh @multai-builder
/test/                  @MultiAgency/internal @jlwaugh @multai-builder
/README.md              @MultiAgency/internal @jlwaugh @multai-builder
/CONTRIBUTING.md        @MultiAgency/internal @jlwaugh @multai-builder
/public/app.css         @MultiAgency/internal @jlwaugh @multai-builder
```

No `lib/` path is proposed, and none should be: every module there runs inside the server process, which holds the payout keys (`lib/judge.mjs` reads `TYPESAFE_API_KEY`; `lib/brief.mjs` quotes and shapes the client's deposit), so nothing under `/lib/` belongs on a list the reviewer account can approve alone. The five paths above are documentation, tests, and styling — nothing that computes money or decides a permission. The owner decides the final list at commit time.

### 3. `.github/workflows/ai-review.yml` — before/after

The gate already tests `github.event.pull_request` rather than the event's name, so the move changes `on:` only. On `pull_request_target` the run answers with the base branch as its head_branch and head_sha, so nothing the run reports names the pull request it reviewed — the verdict artifact, named for the pull request, is what ties the two together. The Verdict step validates the count as an integer and writes the head SHA itself, so the model never writes the SHA and nothing model-written lands in the JSON unvalidated.

`on:`, after:

```yaml
on:
  pull_request_target:
    types: [opened, synchronize, ready_for_review, reopened]
  issue_comment:
    types: [created]
```

(before: the same block with `pull_request:`).

Header comment, replace the line

```
# Either way the review job checks out the base commit, not the pull request, so
```

and the two lines after it with:

```
# Runs on pull_request_target, so the file always comes from the base branch
# (#77): a same-repo pull request runs its own copy of this workflow under
# `pull_request`, and that copy could write itself a clean verdict. Either
# way the review job checks out the base commit, not the pull request, so
```

In the `review` job, after the `anthropics/claude-code-action` step, add:

```yaml
      # The verdict the staging approval reads (issue #77): this run's own
      # artifact, named for the pull request, so one pull request's verdict
      # can never decide another's. The count must parse as a non-negative
      # integer; the SHA is the workflow's, never the model's.
      - name: Verdict
        if: env.HAS_KEY == 'true' && github.event.pull_request
        env:
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: |
          node -e '
            const { readFileSync, writeFileSync } = require("node:fs");
            const verdict = JSON.parse(readFileSync("verdict.json", "utf8"));
            if (!Number.isInteger(verdict.important) || verdict.important < 0) {
              throw new Error("the review left no count of Important findings");
            }
            writeFileSync("verdict.json", JSON.stringify({ sha: process.env.HEAD_SHA, important: verdict.important }));
          ' || { echo "::warning::the review left no verdict that parses"; exit 0; }
      - name: Upload the verdict
        if: env.HAS_KEY == 'true' && github.event.pull_request
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: ai-review-verdict-${{ github.event.pull_request.number }}
          path: verdict.json
          if-no-files-found: ignore
```

In the Claude prompt, after the line `Then post one summary comment with \`gh pr comment\`: the count of` and its continuation, insert:

```
            Then write your verdict to verdict.json (Write tool), exactly:
            {"sha": "<HEAD_SHA>", "important": <the number of Important findings>}
            where <HEAD_SHA> is the value given below and <important> is the
            count of findings you tagged Important (0 when there are none).
```

and in `claude_args`, change the allowed tools to

```
            --allowedTools "Read,Write,Grep,Glob,mcp__github_inline_comment__create_inline_comment,Bash(gh pr diff:*),Bash(gh pr view:*),Bash(gh pr comment:*)"
```

and append the model pin the issue names:

```
            --model claude-opus-5-5
```

`<HEAD_SHA>` in the prompt interpolates `${{ github.event.pull_request.head.sha }}`; the Verdict step overwrites whatever the model wrote with the event's own SHA, so only the count is the model's.

### 4. `REVIEW.md` — the verdict format, inserted between **Severity** and **Skip**

```markdown
## The code approval's verdict

The `ai-review` run leaves its verdict as the run's own artifact
`ai-review-verdict-<pull request number>`, holding one `verdict.json`:
`{"sha": "<pull request head sha>", "important": <count of Important findings>}`.
The staging approval reads the verdict from the newest such artifact still
held — never from a comment, which a pull request's text could fake — and
holds when it is missing, malformed, for another SHA, or counts any
Important finding.
```

Closes #77.



