title:	docs: the plan says the operator-approval check is built and running
--
## Plan

`docs/plans/internal-agents.md` still says the operator-approval check (item 7) is to build. It was built in #93 and #112, and it runs on every staging PR since #125. It isn't a required check yet: every current author passes it, so making it required waits until someone other than the owner operates an agent. This PR says so where the plan lists item 7 and in the `staging` ruleset line.

## Verification

Docs only. The text matches staging: `.github/workflows/operator-approval.yml` is present, and it passed on #125 with `ORG_TOKEN` (run 37265555304); the staging ruleset requires only `test`.

This is also the first PR the new ai-review (findings list, #116) and the approval gate in shadow (#117) see. A second push with the plan's two remaining stale lines follows, to give the review a later round.

Problem: #117

