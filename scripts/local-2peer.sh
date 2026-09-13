#!/usr/bin/env bash
# Automated localhost 2-peer test: share -> download -> integrity diff.
set -euo pipefail
cd "$(dirname "$0")/.."

BIN=./target/debug/swarmshare
cargo build -q -p swarmshare

rm -rf /tmp/swarm-a /tmp/swarm-b /tmp/p2p-in.bin /tmp/p2p-out.bin /tmp/share.log
dd if=/dev/urandom of=/tmp/p2p-in.bin bs=64K count=12 status=none  # 768 KiB -> 3 chunks
echo "input: $(wc -c < /tmp/p2p-in.bin) bytes"

$BIN --data-dir /tmp/swarm-a share /tmp/p2p-in.bin -k e2e -k test --port 40010 > /tmp/share.log 2>&1 &
SHARE_PID=$!
trap "kill $SHARE_PID 2>/dev/null || true" EXIT
sleep 6

FILE_ID=$(grep -oE 'file_id: [0-9a-f]+' /tmp/share.log | head -1 | awk '{print $2}')
PEER_ID=$(grep -oE '12D3Koo[A-Za-z0-9]+' /tmp/share.log | head -1)
if [ -z "${FILE_ID:-}" ] || [ -z "${PEER_ID:-}" ]; then
  echo "could not parse file_id/peer_id:"; cat /tmp/share.log; exit 1
fi
echo "file_id: $FILE_ID"
echo "peer:    $PEER_ID"

timeout 90 $BIN --data-dir /tmp/swarm-b download "$FILE_ID" \
  --peer "/ip4/127.0.0.1/tcp/40010/p2p/$PEER_ID" \
  --port 40011 --out /tmp/p2p-out.bin --parallel 4

cmp /tmp/p2p-in.bin /tmp/p2p-out.bin && echo "✅ IDENTICAL — P2P transfer OK"
ls -la /tmp/p2p-in.bin /tmp/p2p-out.bin
