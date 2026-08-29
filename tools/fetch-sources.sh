#!/usr/bin/env bash
# Download the source corpora that `npm run data` compiles into public/data.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data
echo "ENABLE word list (public domain)…"
curl -sfL -o data/enable1.txt \
  https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt
echo "WordNet 3.1 (Princeton, permissive licence)…"
curl -sfL -o data/wn31dict.tar.gz https://wordnetcode.princeton.edu/wn3.1.dict.tar.gz
tar xzf data/wn31dict.tar.gz -C data
echo "Done. Now run: pip install wordfreq && npm run data"
