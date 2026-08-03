#!/usr/bin/env bash
# Ask DotNS who owns a label, without registering it.
#
# `pad` has no read-only ownership query, and its preflight — which DOES print
# ownership — is followed immediately by the real deploy. So this starts a
# deploy, reads preflight, and kills the process the moment the answer appears.
#
# This exists because a naive "just run pad and read the output" loop will
# happily register every available name it is pointed at. That is how this
# script came to be written.
#
# Usage:  tools/whoowns.sh <label> [--env devnet]

set -uo pipefail

LABEL="${1:?usage: whoowns.sh <label> [--env <id>]}"
shift || true
ENVID="devnet"
[ "${1:-}" = "--env" ] && ENVID="${2:?}"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# An empty directory: nothing to merkleize, nothing to upload. Preflight still
# runs and still reports ownership.
EMPTY="$(mktemp -d)"
trap 'rm -rf "$EMPTY"; rm -f "$TMP"' EXIT

npx @polkadot-community-foundation/polkadot-app-deploy@latest \
    "$EMPTY" "${LABEL}.dot" --env "$ENVID" --js-merkle < /dev/null > "$TMP" 2>&1 &
PAD=$!

# Poll for any line that settles the question, then kill immediately. The
# "Registering" line is the point of no return — killing on sight is the whole
# purpose of this script.
for _ in $(seq 1 120); do
  if grep -qE "already own|requires [A-Za-z]+, but this signer|Registering|owned by|DotNS: " "$TMP" 2>/dev/null; then
    break
  fi
  kill -0 "$PAD" 2>/dev/null || break
  sleep 1
done

kill "$PAD" 2>/dev/null
wait "$PAD" 2>/dev/null

printf '%-16s ' "$LABEL"
if grep -q "already own" "$TMP"; then
  echo "OWNED BY YOU (already registered)"
elif grep -q "requires .*but this signer is" "$TMP"; then
  echo "not registrable — $(grep -oE 'requires [A-Za-z]+, but this signer is [A-Za-z]+' "$TMP" | head -1)"
elif grep -q "Registering" "$TMP"; then
  echo "WAS UNREGISTERED — pad began registering it (killed)"
elif grep -qE "DotNS: .*requires" "$TMP"; then
  echo "available, tier: $(grep -oE 'requires [A-Za-z]+' "$TMP" | head -1)"
else
  echo "inconclusive — see below"
  tail -6 "$TMP" | sed 's/^/    /'
fi
