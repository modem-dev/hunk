#!/usr/bin/env bash
set -e

echo "Resetting Nix dependency hash..."
echo "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" >.nix/nix-deps-hash.txt

echo "Running Nix build to calculate new hash (this will intentionally fail)..."
OUTPUT=$(nix build 2>&1 || true)
NEW_HASH=$(echo "$OUTPUT" | grep -oE 'got:[[:space:]]+sha256-[a-zA-Z0-9+/=]+' | sed 's/got:[[:space:]]*//')

if [ -n "$NEW_HASH" ]; then
  echo "$NEW_HASH" >.nix/nix-deps-hash.txt
  echo "✅ Successfully updated .nix/nix-deps-hash.txt to: $NEW_HASH"
else
  echo "❌ Failed to extract hash. Did the build succeed unexpectedly?"
  echo "Nix output:"
  echo "$OUTPUT"
  exit 1
fi
