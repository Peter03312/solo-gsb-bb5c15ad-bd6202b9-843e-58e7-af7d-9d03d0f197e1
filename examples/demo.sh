#!/usr/bin/env bash
# End-to-end demo of the stowage approval service.
# Usage:  ./examples/demo.sh [BASE_URL]      (default http://localhost:3000)
# Requires: curl; jq is optional (used for pretty printing when present).
set -euo pipefail

BASE="${1:-http://localhost:3000}"

req() { # req METHOD PATH [JSON]
  local method="$1" path="$2" body="${3:-}"
  echo
  echo "==> $method $path"
  [ -n "$body" ] && echo "    $body"
  local args=(-s -w '\nHTTP %{http_code}\n' -X "$method" "$BASE$path")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' -d "$body")
  if command -v jq >/dev/null 2>&1; then
    curl "${args[@]}" | { IFS= read -r line; printf '%s\n' "$line" | jq . 2>/dev/null || printf '%s\n' "$line"; cat; }
  else
    curl "${args[@]}"
  fi
}

echo "### 1. Register a voyage: 3 bays x 2 rows x 3 tiers (z=0 is the bottom tier)"
req POST /voyages '{"id":"VOY-001","dims":{"x":3,"y":2,"z":3}}'

echo
echo "### 2. Register per-column weight limits"
req PUT /voyages/VOY-001/columns '{"columns":[
  {"x":0,"y":0,"maxWeight":30},
  {"x":0,"y":1,"maxWeight":100},
  {"x":1,"y":0,"maxWeight":100},
  {"x":1,"y":1,"maxWeight":100},
  {"x":2,"y":0,"maxWeight":100},
  {"x":2,"y":1,"maxWeight":100}]}'

echo
echo "### 3. Register containers (number, weight, dangerous-goods class)"
req PUT /voyages/VOY-001/containers '{"containers":[
  {"containerNo":"MSKU001","weight":12,"dgClass":"3"},
  {"containerNo":"MSKU002","weight":12,"dgClass":"5.1"},
  {"containerNo":"MSKU003","weight":10,"dgClass":"3"},
  {"containerNo":"MSKU004","weight":8,"dgClass":"8"}]}'

echo
echo "### 3b. Invalid weight is rejected"
req PUT /voyages/VOY-001/containers '{"containers":[{"containerNo":"BAD","weight":-3,"dgClass":"3"}]}'

echo
echo "### 4. Segregation rule: class 3 and class 5.1 must keep Manhattan distance >= 2"
req PUT /voyages/VOY-001/incompatibilities '{"pairs":[{"classA":"3","classB":"5.1","minDistance":2}]}'

echo
echo "### 5. Batch assignment with a stale revision -> 409"
req POST /voyages/VOY-001/assignments '{"expectedRevision":9,"moves":[{"containerNo":"MSKU001","position":{"x":0,"y":0,"z":0}}]}'

echo
echo "### 5b. Unknown container -> 400"
req POST /voyages/VOY-001/assignments '{"expectedRevision":0,"moves":[{"containerNo":"GHOST","position":{"x":0,"y":0,"z":0}}]}'

echo
echo "### 5c. Invalid coordinates -> 400"
req POST /voyages/VOY-001/assignments '{"expectedRevision":0,"moves":[{"containerNo":"MSKU001","position":{"x":7,"y":0,"z":0}}]}'

echo
echo "### 5d. Final layout violates rules (overweight column + segregation) -> 422, whole batch rejected"
req POST /voyages/VOY-001/assignments '{"expectedRevision":0,"moves":[
  {"containerNo":"MSKU001","position":{"x":0,"y":0,"z":0}},
  {"containerNo":"MSKU002","position":{"x":0,"y":0,"z":1}},
  {"containerNo":"MSKU003","position":{"x":0,"y":0,"z":2}}]}'

echo
echo "### 6. Valid batch: every container placed, revision becomes 1"
req POST /voyages/VOY-001/assignments '{"expectedRevision":0,"moves":[
  {"containerNo":"MSKU001","position":{"x":0,"y":0,"z":0}},
  {"containerNo":"MSKU003","position":{"x":0,"y":0,"z":1}},
  {"containerNo":"MSKU002","position":{"x":2,"y":1,"z":0}},
  {"containerNo":"MSKU004","position":{"x":2,"y":0,"z":0}}]}'

echo
echo "### 7. Issue the load list (freezes the revision-1 layout)"
req POST /voyages/VOY-001/load-list '{}'

echo
echo "### 8. In-batch swap of two slots (legal: only the final layout is validated)"
req POST /voyages/VOY-001/assignments '{"expectedRevision":1,"moves":[
  {"containerNo":"MSKU004","position":{"x":2,"y":1,"z":0}},
  {"containerNo":"MSKU002","position":{"x":2,"y":0,"z":0}}]}'

echo
echo "### 9. Old list is retained; the voyage now has no up-to-date list"
req GET /voyages/VOY-001/load-lists
req GET /voyages/VOY-001/load-lists/1

echo
echo "### 10. Issuing with a stale expectedRevision -> 409; without it freezes the new layout"
req POST /voyages/VOY-001/load-list '{"expectedRevision":1}'
req POST /voyages/VOY-001/load-list '{"expectedRevision":2}'

echo
echo "### 11. Final voyage state"
req GET /voyages/VOY-001
