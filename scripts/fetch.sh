#!/usr/bin/env bash
# fetch.sh — the exact commands that produced data/. Re-running this will pick
# up whatever JPL holds today, which will not be byte-identical to the vendored
# copy: the catalogue grows. scripts/check.mjs compares against data/audit.json,
# so regenerate that (npm run audit) after a refetch and expect the counts to move.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data

FIELDS='spkid,full_name,a,e,i,om,w,ma,epoch,H,class'
API='https://ssd-api.jpl.nasa.gov/sbdb_query.api'

echo "asteroids (about 276 MB)"
curl -s --retry 3 --retry-delay 5 --max-time 1200 \
  -w 'HTTP=%{http_code} BYTES=%{size_download} TIME=%{time_total}\n' \
  -o data/sbdb-asteroids-fullprec.json \
  "${API}?fields=${FIELDS}&sb-kind=a&full-prec=true"

echo "comets"
curl -s --retry 3 --max-time 300 \
  -w 'HTTP=%{http_code} BYTES=%{size_download} TIME=%{time_total}\n' \
  -o data/sbdb-comets-fullprec.json \
  "${API}?fields=${FIELDS}&sb-kind=c&full-prec=true"

echo "planet elements"
curl -s --max-time 60 \
  -w 'HTTP=%{http_code} BYTES=%{size_download}\n' \
  -o data/planets-approx-pos.html \
  'https://ssd.jpl.nasa.gov/planets/approx_pos.html'

echo "done. now: npm run audit && npm run pack"
