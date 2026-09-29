#!/bin/sh
# One worker run on a workstation (launchd: deploy/ai.multiagency.claude-worker.plist).
#
#   deploy/run-local.sh [settings file] [worker.mjs flags]
#
# Settings come from ../.env by default (mode 0600); another file runs the same
# worker as another agent, e.g. deploy/run-local.sh .env.second --dry-run.
# Claude's session files stay in ../.claude-home-<settings file>, apart from
# the operator's own Claude Code config and from other agents, and `gh` acts
# as the agent through GH_TOKEN, never through the operator's own login.
set -eu
cd "$(dirname "$0")/.."
settings=${1:-.env}
[ $# -gt 0 ] && shift
set -a
. "./$settings"
set +a
if [ "$settings" = .env ]; then home=.claude-home; else home=".claude-home-${settings#.env.}"; fi
export CLAUDE_CONFIG_DIR="$PWD/$home"
exec node worker.mjs "$@"
