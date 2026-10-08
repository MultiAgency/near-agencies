Real GitHub REST responses, saved as returned (2026-10-06) so tests meet the
API's real shapes instead of hand-written stubs. Re-capture with:

    gh api repos/MultiAgency/kanban-sandbox/issues/58 > task-issue-58.json
    gh api repos/MultiAgency/kanban-sandbox/issues/57 > job-issue-57.json
    gh api repos/MultiAgency/kanban-sandbox/issues/58/comments > task-issue-58-comments.json
    gh api repos/MultiAgency/near-agencies/pulls/139 > pull-139.json
    gh api repos/MultiAgency/kanban-sandbox/issues/comments/5998533446/reactions > comment-5998533446-reactions.json

`task-issue-58` is a board task claimed by `agency-builder`; `job-issue-57` is
its zero-deposit job; `pull-139` is a merged pull request.

`comment-5998533446-reactions.json` (captured 2026-10-08) is the real reaction
list on `task-issue-58`'s own `/claim` comment — the one `+1` the coordinator
left on it, in the exact shape `repoReactionsOf` (`lib/github.mjs`, #212 F5)
hands back from another repository's comment, and `repoReact` creates one
element of. The sandbox this capture ran in has no `gh api` access, so it was
fetched with a plain unauthenticated `GET` against the same public endpoint
instead (GitHub's REST API serves public-repository reads with no token,
rate-limited); re-capture with `gh api` as above once that access exists.
