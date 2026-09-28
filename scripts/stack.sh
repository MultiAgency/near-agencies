#!/usr/bin/env bash
# Run the local stack: PostgreSQL, the facilitator, and the paid resource server.
#
#   scripts/stack.sh up     start everything in the background and wait for readiness
#                           (the agent connector too, when .secrets/multi-agency-github-token exists)
#   scripts/stack.sh down   stop everything
#   scripts/stack.sh pay    run the paying agent against the running stack
#   scripts/stack.sh engage "<title>" "<brief>"   the organization opens a paid engagement
set -euo pipefail
source "$(dirname "$0")/env.sh"

PIDS="$POC_ROOT/.data/pids"
mkdir -p "$PIDS" "$LOGS"

# Network-specific values (USDC, RPC, treasury) come from lib/network.mjs via NEAR_NETWORK.
export NEAR_NETWORK="${NEAR_NETWORK:-testnet}"
export FACILITATOR_URL PAY_TO="$MERCHANT_ACCOUNT" RELAYER_ACCOUNT PAYER_ACCOUNT ORG_ACCOUNT SANDBOX_REPO
export FACILITATOR_API_KEY_FILE="$SECRETS/resource-server-api-key" PORT="$SERVER_PORT"

# Poll until the URL answers with the expected HTTP status.
wait_for() {
  local name=$1 url=$2 expected=$3
  for _ in $(seq 1 60); do
    [[ $(curl -s -o /dev/null -w '%{http_code}' "$url") == "$expected" ]] && { echo "$name: ready"; return; }
    sleep 1
  done
  echo "$name: no $expected from $url after 60s; see $LOGS/$name.log" >&2
  curl -s "$url" >&2 || true
  exit 1
}

start() {
  local name=$1; shift
  if [[ -f "$PIDS/$name" ]] && kill -0 "$(cat "$PIDS/$name")" 2>/dev/null; then
    echo "$name: already running"
    return
  fi
  "$@" >>"$LOGS/$name.log" 2>&1 &
  echo $! > "$PIDS/$name"
}

stop() {
  local name=$1
  [[ -f "$PIDS/$name" ]] || return 0
  kill "$(cat "$PIDS/$name")" 2>/dev/null || true
  rm -f "$PIDS/$name"
}

case "${1:-}" in
  up)
    "$(dirname "$0")/pg.sh" start
    start facilitator "$FACILITATOR_BIN" --config "$POC_ROOT/config/testnet.json"
    wait_for facilitator "$FACILITATOR_URL/readyz" 200
    start server node --no-warnings "$POC_ROOT/server.mjs"
    wait_for server "http://127.0.0.1:$SERVER_PORT/brief?account=$PAYER_ACCOUNT" 402
    if [[ -f "$SECRETS/multi-agency-github-token" ]]; then
      GITHUB_TOKEN_FILE="$SECRETS/multi-agency-github-token" start connector node --no-warnings "$POC_ROOT/connector.mjs"
      echo "connector: started"
    fi
    ;;
  down)
    stop connector
    stop server
    stop facilitator
    "$(dirname "$0")/pg.sh" stop
    ;;
  pay)
    node --no-warnings "$POC_ROOT/agent.mjs"
    ;;
  engage)
    shift
    node --no-warnings "$POC_ROOT/org.mjs" "$@"
    ;;
  *) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 64 ;;
esac
