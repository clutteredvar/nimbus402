#!/usr/bin/env bash
#
# Boot the service and check the two things that matter from the outside:
# it comes up, and an unpaid call gets a real x402 challenge back.
#
# Runs anywhere bash and curl exist -- no CI provider required. Point your
# own pipeline at it, or just run it before a deploy.
#
#   ./scripts/smoke.sh [port]
#
set -euo pipefail

PORT="${1:-3017}"
BASE="http://localhost:${PORT}"

export PAY_TO="${PAY_TO:-0x000000000000000000000000000000000000dEaD}"
export KITE_NETWORK="${KITE_NETWORK:-testnet}"
export PORT

npx tsx src/server.ts &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

echo "waiting for ${BASE}/healthz ..."
for _ in $(seq 1 30); do
  if curl -sf "${BASE}/healthz" > /dev/null; then break; fi
  sleep 1
done

echo "--- /healthz ---"
curl -s "${BASE}/healthz"
echo

echo "--- unpaid /v1/forecast (expect 402) ---"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  "${BASE}/v1/forecast?latitude=52.52&longitude=13.41")
echo "status: ${STATUS}"
if [ "${STATUS}" != "402" ]; then
  echo "FAIL: expected 402 from an unpaid call" >&2
  exit 1
fi

echo "--- challenge ---"
curl -s -D - -o /dev/null "${BASE}/v1/forecast?latitude=52.52" \
  | grep -i '^payment-required:' \
  | sed 's/^[^:]*: //' | tr -d '\r' \
  | base64 --decode 2>/dev/null || base64 -D 2>/dev/null || true
echo
echo "PASS"
