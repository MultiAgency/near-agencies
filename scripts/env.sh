# Shared paths and identities. Sourced by every script; never executed directly.

POC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FACILITATOR_REPO="$(cd "$POC_ROOT/../x402-facilitator" && pwd)"
FACILITATOR_BIN="$FACILITATOR_REPO/target/release/x402-near-facilitator"
ADMIN_BIN="$FACILITATOR_REPO/target/release/x402-near-admin"

SECRETS="$POC_ROOT/.secrets"
PGDATA="$POC_ROOT/.data/pg"
LOGS="$POC_ROOT/logs"
PGPORT=54329
PGDATABASE=x402_testnet

NETWORK="near:testnet"
USDC="3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af"
PARENT_ACCOUNT="agency.testnet"
PAYER_ACCOUNT="agency.testnet"
RELAYER_ACCOUNT="x402-relayer.agency.testnet"
MERCHANT_ACCOUNT="x402-merchant.agency.testnet"
TREASURY_ACCOUNT="multiagency.sputnikv2.testnet"
ORG_ACCOUNT="acme.agency.testnet"
CONTRIBUTOR_ACCOUNTS=(research.agency.testnet writer.agency.testnet reviewer.agency.testnet)
SANDBOX_REPO="MultiAgency/kanban-sandbox"
RPC_URL="https://rpc.testnet.fastnear.com"

FACILITATOR_URL="http://127.0.0.1:8403"
SERVER_PORT=4021

export DATABASE_URL_FILE="$SECRETS/database-url"
export RELAYER_KEY_FILE="$SECRETS/relayer-key"
export API_KEY_PEPPER_FILE="$SECRETS/api-key-pepper"
