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
  - text people read uses the agency vocabulary from `AGENTS.md`.

## Severity

- **Important:** would break behavior, pay the wrong account, let the wrong person claim or approve, leak a secret, or breach a contract in `AGENTS.md`.
- **Nit:** naming, style and wording. Report at most five, and summarize the rest as a count.

## Skip

`package-lock.json`, anything `npm run check` and `npm test` already enforce, and formatting.
