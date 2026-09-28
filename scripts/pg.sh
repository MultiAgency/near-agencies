#!/usr/bin/env bash
# Start or stop the PoC's private PostgreSQL cluster (loopback only).
set -euo pipefail
source "$(dirname "$0")/env.sh"

mkdir -p "$LOGS"
case "${1:-}" in
  start)
    pg_ctl -D "$PGDATA" status >/dev/null 2>&1 \
      || pg_ctl -D "$PGDATA" -l "$LOGS/postgres.log" -w \
           -o "-p $PGPORT -k '' -c listen_addresses=127.0.0.1" start >/dev/null
    ;;
  stop)
    pg_ctl -D "$PGDATA" status >/dev/null 2>&1 && pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null || true
    ;;
  *) echo "usage: $0 start|stop" >&2; exit 64 ;;
esac
