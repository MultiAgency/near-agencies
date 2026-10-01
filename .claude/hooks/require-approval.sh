#!/bin/bash
# PreToolUse hook: a `gh pr merge` goes ahead only on a pull request with an
# approving review. The main ruleset lets an owner's merge bypass its rules, so
# the review is checked here. If the check itself fails, the merge is held.
cmd=$(jq -r '.tool_input.command // empty')
[[ "$cmd" =~ gh[[:space:]]+pr[[:space:]]+merge ]] || exit 0

# The merge's own arguments: up to the next command in a chain.
rest=${cmd#*pr merge}
rest=${rest%%&&*}; rest=${rest%%;*}; rest=${rest%%|*}
pr=$(grep -oE '(^|[[:space:]/])[0-9]+([[:space:]]|$)' <<<"$rest" | head -1 | tr -dc 0-9)
repo=$(grep -oE '(-R|--repo)[[:space:]=]+[^[:space:]]+' <<<"$rest" | head -1 | sed -E 's/^(-R|--repo)[[:space:]=]+//')
if [ -n "$pr" ]; then what="PR #$pr"; else what="the current branch's PR"; fi

if ! decision=$(gh pr view $pr ${repo:+-R "$repo"} --json reviewDecision -q .reviewDecision 2>&1); then
  echo "Merge held: couldn't read the reviews on $what ($decision)." >&2
  exit 2
fi
[ "$decision" = APPROVED ] && exit 0
echo "Merge held: $what has no approving review (reviewDecision: ${decision:-none}). A MultiAgency owner reviews and approves it first (gh pr review <n> --approve), then merges." >&2
exit 2
