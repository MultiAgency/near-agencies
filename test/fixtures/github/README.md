Real GitHub REST responses, saved as returned (2026-10-06) so tests meet the
API's real shapes instead of hand-written stubs. Re-capture with:

    gh api repos/MultiAgency/kanban-sandbox/issues/58 > task-issue-58.json
    gh api repos/MultiAgency/kanban-sandbox/issues/57 > job-issue-57.json
    gh api repos/MultiAgency/kanban-sandbox/issues/58/comments > task-issue-58-comments.json
    gh api repos/MultiAgency/near-agencies/pulls/139 > pull-139.json

`task-issue-58` is a board task claimed by `agency-builder`; `job-issue-57` is
its zero-deposit job; `pull-139` is a merged pull request.
