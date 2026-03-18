#!/usr/bin/env bash
# Average three cold-process runs of the app-startup syntax-highlighting benchmark.
#
# Primary metric:
#   selected_highlight_ms = time from before importing App until the selected file
#   visibly paints highlighted emphasis spans.
#
# Output format stays as METRIC name=value lines so pi autoresearch can parse it.
set -euo pipefail

runs=3
selected_values=()
iterations_values=()
files=""
lines_per_file=""

for _ in $(seq 1 "$runs"); do
  output=$(bun run test/app-syntax-highlight-startup-benchmark.ts)

  selected=$(printf '%s\n' "$output" | awk -F= '/^METRIC selected_highlight_ms=/{print $2}')
  iterations=$(printf '%s\n' "$output" | awk -F= '/^METRIC iterations=/{print $2}')
  files=$(printf '%s\n' "$output" | awk -F= '/^METRIC files=/{print $2}')
  lines_per_file=$(printf '%s\n' "$output" | awk -F= '/^METRIC lines_per_file=/{print $2}')

  selected_values+=("$selected")
  iterations_values+=("$iterations")
done

selected_avg=$(printf '%s\n' "${selected_values[@]}" | awk '{sum += $1} END {printf "%.2f", sum / NR}')
iterations_avg=$(printf '%s\n' "${iterations_values[@]}" | awk '{sum += $1} END {printf "%.2f", sum / NR}')

echo "METRIC selected_highlight_ms=$selected_avg"
echo "METRIC iterations=$iterations_avg"
echo "METRIC samples=$runs"
echo "METRIC files=$files"
echo "METRIC lines_per_file=$lines_per_file"
