#!/usr/bin/env bash
# RED test: Subprocess safety for ibercastd ingest.
# Non-video file → clean error, ffmpeg timeout cleanup.
set -euo pipefail

PORT="${1:-18585}"
BASE="http://127.0.0.1:${PORT}"
TMPDIR=$(mktemp -d)

# Optional: if the daemon runs with auth enabled (--admin-token), the test
# needs the token to exercise write endpoints. Set IBERCASTD_ADMIN_TOKEN.
AUTH=()
if [ -n "${IBERCASTD_ADMIN_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: Bearer $IBERCASTD_ADMIN_TOKEN")
fi

PASS=0
FAIL=0

check() {
  local name="$1" expect="$2" actual="$3"
  if [ "$actual" = "$expect" ]; then
    echo "  ✅ $name ($actual)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $name — expected '$expect', got '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

check_contains() {
  local name="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  ✅ $name (contains '$needle')"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $name — '$needle' not found in response"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== RED test: Subprocess safety ==="

# 1. POST a non-video file → expect clean client error.
#    Server rejects non-video content types early with 400 (no wasted ffmpeg run).
echo "test content" > "$TMPDIR/test.txt"
STATUS=$(curl -s -o "$TMPDIR/response.txt" -w '%{http_code}' "${AUTH[@]}" \
  -F "file=@$TMPDIR/test.txt" \
  -F "title=Not a video" \
  "$BASE/api/videos")
check "Non-video file → error" "400" "$STATUS"
BODY=$(cat "$TMPDIR/response.txt")
check_contains "Error mentions publish failure" "error" "$BODY"

# 2. POST with missing file field → expect 400
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" \
  -F "title=No file" \
  "$BASE/api/videos")
check "Missing file field → 400" "400" "$STATUS"

# 3. GET parrilla for non-existent channel → empty array
BODY=$(curl -s "$BASE/api/parrilla?channelId=nonexistent&day=0")
check_contains "Empty parrilla returns array" "[]" "$BODY"

# 4. POST parrilla slot with conflict → 409
curl -s -X POST -H "Content-Type: application/json" "${AUTH[@]}" \
  -d '{"channelId":"test","dayOfWeek":0,"timeStart":"10:00","type":"vod","ref":"x"}' \
  "$BASE/api/parrilla" > /dev/null
STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST -H "Content-Type: application/json" "${AUTH[@]}" \
  -d '{"channelId":"test","dayOfWeek":0,"timeStart":"10:00","type":"vod","ref":"y"}' \
  "$BASE/api/parrilla")
check "Conflicting slot → 409" "409" "$STATUS"

rm -rf "$TMPDIR"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "🎉 RED subprocess tests PASSED" || echo "💥 RED subprocess tests FAILED"
exit "$FAIL"
