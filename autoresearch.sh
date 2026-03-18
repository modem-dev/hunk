#!/usr/bin/env bash
set -euo pipefail

runs=3
selected_values=()
all_values=()
files=""
lines_per_file=""

for _ in $(seq 1 "$runs"); do
  output=$(bun run test/syntax-highlight-startup-benchmark.ts)

  selected=$(printf '%s\n' "$output" | awk -F= '/^METRIC selected_highlight_ms=/{print $2}')
  all=$(printf '%s\n' "$output" | awk -F= '/^METRIC all_highlights_ms=/{print $2}')
  files=$(printf '%s\n' "$output" | awk -F= '/^METRIC files=/{print $2}')
  lines_per_file=$(printf '%s\n' "$output" | awk -F= '/^METRIC lines_per_file=/{print $2}')

  selected_values+=("$selected")
  all_values+=("$all")
done

selected_avg=$(printf '%s\n' "${selected_values[@]}" | awk '{sum += $1} END {printf "%.2f", sum / NR}')
all_avg=$(printf '%s\n' "${all_values[@]}" | awk '{sum += $1} END {printf "%.2f", sum / NR}')

echo "METRIC selected_highlight_ms=$selected_avg"
echo "METRIC all_highlights_ms=$all_avg"
echo "METRIC samples=$runs"
echo "METRIC files=$files"
echo "METRIC lines_per_file=$lines_per_file"
