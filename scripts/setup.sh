#!/usr/bin/env bash
# One-time provisioning. Each step is idempotent and can be run on its own:
#
#   scripts/setup.sh db        local PostgreSQL cluster, database, pepper, migrations
#   scripts/setup.sh relayer   relayer key + on-chain account funded by the parent
#   scripts/setup.sh merchant  merchant account + USDC storage for merchant and payer
#   scripts/setup.sh client    facilitator API client scoped to the merchant payee
#   scripts/setup.sh team      org + contributor accounts, USDC storage, treasury payee
#   scripts/setup.sh all       every step above, in order
#
# On-chain steps spend testnet NEAR from $PARENT_ACCOUNT.
set -euo pipefail
source "$(dirname "$0")/env.sh"

RELAYER_FUNDING="1.5 NEAR" # above the 1 NEAR balance-warning threshold in config/testnet.json
MERCHANT_FUNDING="0.1 NEAR"
TEAM_FUNDING="0.02 NEAR"   # org and contributors never sign NEAR transactions
ORG_USDC="5000000"         # 5 USDC seeded from the payer for engagement deposits
USDC_STORAGE_DEPOSIT="0.00125 NEAR"

umask 077
mkdir -p "$SECRETS" "$LOGS"

account_exists() {
  curl -sf "$RPC_URL" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" \
    | grep -q '"amount"'
}

usdc_registered() {
  local args
  args=$(printf '{"account_id":"%s"}' "$1" | base64)
  curl -sf "$RPC_URL" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$USDC\",\"method_name\":\"storage_balance_of\",\"args_base64\":\"$args\"}}" \
    | python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]["result"]; sys.exit(0 if bytes(r).decode()!="null" else 1)'
}

step_db() {
  if [[ ! -d "$PGDATA" ]]; then
    initdb --auth=trust --username=x402 --encoding=UTF8 -D "$PGDATA" >/dev/null
  fi
  "$(dirname "$0")/pg.sh" start
  psql -h 127.0.0.1 -p "$PGPORT" -U x402 -d postgres -tAc "select 1 from pg_database where datname='$PGDATABASE'" | grep -q 1 \
    || createdb -h 127.0.0.1 -p "$PGPORT" -U x402 "$PGDATABASE"
  [[ -f "$DATABASE_URL_FILE" ]] || echo "postgres://x402@127.0.0.1:$PGPORT/$PGDATABASE" > "$DATABASE_URL_FILE"
  [[ -f "$API_KEY_PEPPER_FILE" ]] || openssl rand -hex 32 > "$API_KEY_PEPPER_FILE"
  "$ADMIN_BIN" migrate --database-url-file "$DATABASE_URL_FILE"
  echo "db: ready ($PGDATABASE on 127.0.0.1:$PGPORT)"
}

step_relayer() {
  if [[ ! -f "$RELAYER_KEY_FILE" ]]; then
    "$ADMIN_BIN" key generate-relayer --output "$RELAYER_KEY_FILE" > "$SECRETS/relayer-public-key"
  fi
  if account_exists "$RELAYER_ACCOUNT"; then
    echo "relayer: $RELAYER_ACCOUNT already exists"
    return
  fi
  near account create-account fund-myself "$RELAYER_ACCOUNT" "$RELAYER_FUNDING" \
    use-manually-provided-public-key "$(cat "$SECRETS/relayer-public-key")" \
    sign-as "$PARENT_ACCOUNT" network-config testnet sign-with-legacy-keychain send
}

# Create a sub-account of the parent (key saved to the legacy keychain) unless it exists.
create_account() {
  local account=$1 funding=$2
  if account_exists "$account"; then
    echo "account: $account already exists"
    return
  fi
  near account create-account fund-myself "$account" "$funding" \
    autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$PARENT_ACCOUNT" network-config testnet sign-with-legacy-keychain send
}

register_usdc() {
  local account
  for account in "$@"; do
    if usdc_registered "$account"; then
      echo "usdc storage: $account already registered"
      continue
    fi
    near contract call-function as-transaction "$USDC" storage_deposit \
      json-args "{\"account_id\":\"$account\",\"registration_only\":true}" \
      prepaid-gas '30 Tgas' attached-deposit "$USDC_STORAGE_DEPOSIT" \
      sign-as "$PARENT_ACCOUNT" network-config testnet sign-with-legacy-keychain send
  done
}

step_merchant() {
  create_account "$MERCHANT_ACCOUNT" "$MERCHANT_FUNDING"
  register_usdc "$MERCHANT_ACCOUNT" "$PAYER_ACCOUNT"
}

step_client() {
  if [[ -f "$SECRETS/client-id" ]]; then
    echo "client: $(cat "$SECRETS/client-id") already provisioned"
    return
  fi
  local output
  output=$("$ADMIN_BIN" client create --database-url-file "$DATABASE_URL_FILE" \
    --pepper-file "$API_KEY_PEPPER_FILE" --environment testnet --name x402-poc-resource-server)
  sed -n 's/^client_id=//p' <<<"$output" > "$SECRETS/client-id"
  sed -n 's/^api_key=//p' <<<"$output" > "$SECRETS/resource-server-api-key"
  "$ADMIN_BIN" client allow-payee --database-url-file "$DATABASE_URL_FILE" \
    --client-id "$(cat "$SECRETS/client-id")" --network "$NETWORK" --asset "$USDC" --pay-to "$MERCHANT_ACCOUNT"
  echo "client: $(cat "$SECRETS/client-id") may settle $NETWORK USDC to $MERCHANT_ACCOUNT"
}

step_team() {
  local account
  for account in "$ORG_ACCOUNT" "${CONTRIBUTOR_ACCOUNTS[@]}"; do
    create_account "$account" "$TEAM_FUNDING"
  done
  register_usdc "$TREASURY_ACCOUNT" "$ORG_ACCOUNT" "${CONTRIBUTOR_ACCOUNTS[@]}"
  if [[ ! -f "$SECRETS/treasury-payee" ]]; then
    "$ADMIN_BIN" client allow-payee --database-url-file "$DATABASE_URL_FILE" \
      --client-id "$(cat "$SECRETS/client-id")" --network "$NETWORK" --asset "$USDC" --pay-to "$TREASURY_ACCOUNT"
    touch "$SECRETS/treasury-payee"
  fi
  if [[ ! -f "$SECRETS/org-seeded" ]]; then
    near contract call-function as-transaction "$USDC" ft_transfer \
      json-args "{\"receiver_id\":\"$ORG_ACCOUNT\",\"amount\":\"$ORG_USDC\"}" \
      prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' \
      sign-as "$PAYER_ACCOUNT" network-config testnet sign-with-legacy-keychain send
    touch "$SECRETS/org-seeded"
  fi
  echo "team: $ORG_ACCOUNT pays deposits to $TREASURY_ACCOUNT; contributors ${CONTRIBUTOR_ACCOUNTS[*]}"
}

case "${1:-}" in
  db) step_db ;;
  relayer) step_relayer ;;
  merchant) step_merchant ;;
  client) step_client ;;
  team) step_team ;;
  all) step_db; step_relayer; step_merchant; step_client; step_team ;;
  *) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 64 ;;
esac
