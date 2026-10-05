# ai-review evals

ai-review, exactly as `.github/workflows/ai-review.yml` configures it, run on recorded pull requests and checked. This is the AI-native SDLC plan's phase 4 (`docs/plans/ai-native-sdlc.md`), applied to the review (#116).

```
node evals/ai-review/run.mjs [case ...] [--keep]
```

Each run costs about $2 and needs `claude` on PATH, plus git history back to each case's base.

- **What runs.** The prompt, the `claude_args` (tools, turns, model) and the "Earlier rounds" step are read from the workflow file itself (`workflow.mjs`). This checkout's `REVIEW.md`, `AGENTS.md`, `CLAUDE.md` and `docs/decisions.md` are laid over each case's base tree. `gh` is a stub (`gh-stub.mjs`) that serves the case's fixtures and records the summary. The one change: the inline-comment tool exists only inside the GitHub action, so the eval asks for those comments in a file.
- **Contract checks** (`checks.mjs`) must hold on every case. The review ran, and none of its own writes was refused. The verdict counts Important findings. A summary was posted, ending with a findings list for the head under review. Exploration the workflow withholds, such as reading the head's files, is reported but not failed.
- **Behavior checks** come from each case's `expect`: Important counts, a range that must be flagged, a word that must not be raised again, a finding's status. They are scored, since answers vary between runs. The run fails below 75%.

## Cases

| Case | Round | Expects |
| --- | --- | --- |
| `gate-artifacts-shape` | #108 at e10a756, round 1 | The `.artifacts` bug at `scripts/staging-approval.mjs:72` flagged Important. The live reviews missed it, and so did both eval runs on 2026-10-05: a known gap |
| `docs-clean` | #126, round 1 | Nothing Important (false-positive guard) |
| `declined-not-reraised` | #112 at 2b122e4, a later round | The self-declared `kind` finding, accepted by the owner, comes back neither as a comment nor as open |
| `fixed-finding` | #126 at 24ec161, round 3 | The earlier Nit marked fixed, nothing Important |

`declined-not-reraised` and `fixed-finding` carry one synthetic summary comment holding the earlier round's findings list, because those live rounds predate the list. It's marked as synthetic in its text.

## Adding a case

Each production defect the review should have caught becomes a case:

```
node evals/ai-review/record.mjs <name> --pr N --base SHA --head SHA --at <when the round ran> [--prev SHA]
```

Then write its `what` and `expect` in `case.json`.
