# Review instructions

Every pull request gets these three passes. `AGENTS.md` defines the contracts and conventions they check against. Tag each finding with its pass and a severity.

## Passes

- **Bugs:** logic errors, broken edge cases, regressions, races between a coordinator cycle and the board (a read that is stale by the time of the write), and failures swallowed silently.
- **Security:** anything that decides who is paid, who may claim, or who is an owner. The `CODEOWNERS` paths are high-risk: read every changed line there. Also check:
  - authorship checks on board blocks (a stranger's block must count for nothing);
  - secrets reaching logs, comments or the client;
  - untrusted input (issue and comment bodies, briefs, deliverables) flowing into commands, prompts or HTML without escaping;
  - a model's judgment deciding money or permissions where code should.
- **Compliance:**
  - the diff does what the PR body's **Plan** says, and its **Verification** is credible;
  - a bug fix comes with a test that fails without the fix;
  - a change to a board format changes its parser and tests with it;
  - a change to an entry point that talks to an external system (GitHub, the registry, NEAR RPC, Railway) shows, under **Verification**, the output of a read-only run against the real system, and its tests stub that system with captured responses (`test/fixtures/github/`), not hand-written ones (#130);
  - text people read uses the agency vocabulary from `AGENTS.md`.

## Severity

- **Important:** would break behavior, pay the wrong account, let the wrong person claim or approve, leak a secret, or breach a contract in `AGENTS.md`.
- **Nit:** naming, style and wording. Report at most five, and summarize the rest as a count.

## The code approval's verdict

The `ai-review` run leaves its verdict as the run's own artifact
`ai-review-verdict-<pull request number>`, holding one `verdict.json`:
`{"sha": "<pull request head sha>", "important": <count of Important findings still open>}`,
counted over the findings list every round carries forward (#116).
The staging approval reads the verdict from the newest such artifact still
held — never from a comment, which a pull request's text could fake — and
holds when it is missing, malformed, for another SHA, or counts any
Important finding.

## Skip

`package-lock.json`, anything `npm run check` and `npm test` already enforce, and formatting.
