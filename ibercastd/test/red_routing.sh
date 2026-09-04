#!/usr/bin/env bash
# RED test: HTTP routing security for ibercastd.
# Unknown routes → 404, path traversal in :id rejected.
set -euo pipefail

PORT="${1:-18585}"
BASE="http://127.0.0.1:${PORT}"

PASS=0
FAIL=0

check() {
  local name="$1" expect="$2" actual="$3"
  if [ "$actual" = "$expect" ]; then
    echo "  ✅ $name (HTTP $actual)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $name — expected HTTP $expect, got HTTP $actual"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== RED test: HTTP routing security ==="

# 1. Unknown route → 404
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/nonexistent")
check "Unknown route → 404" "404" "$STATUS"

STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/nonexistent")
check "Unknown API route → 404" "404" "$STATUS"

# 2. Path traversal: server middleware catches raw `..` in request URI.
#    curl normalizes paths by default, so we use a raw TCP request via nc.
STATUS=$(printf 'GET /api/videos/../../../etc/passwd HTTP/1.0\r\nHost: localhost\r\n\r\n' | nc -w2 127.0.0.1 "$PORT" 2>/dev/null | head -1 | awk '{print $2}')
check "Raw path traversal → 400" "400" "$STATUS"

# 3. Health endpoint works
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")
check "Health endpoint → 200" "200" "$STATUS"

# 4. GET /api/videos returns 200 (empty array)
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/videos")
check "GET /api/videos → 200" "200" "$STATUS"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "🎉 RED routing tests PASSED" || echo "💥 RED routing tests FAILED"
exit "$FAIL"
