type ReviewSummaryCardProps = {
  heading: string;
  supportingText: string;
  fileCount: number;
  lastUpdated: string;
  onReview: () => void;
};

function reviewButtonLabel(fileCount: number) {
  return fileCount === 1 ? "Review 1 file" : `Review ${fileCount} files`;
}

export function ReviewSummaryCard({
  heading,
  supportingText,
  fileCount,
  lastUpdated,
  onReview,
}: ReviewSummaryCardProps) {
  return (
    <box
      style={{
        padding: 2,
        border: true,
        borderColor: "#334155",
        backgroundColor: "#0f172a",
        flexDirection: "column",
        gap: 1,
      }}
    >
      <box style={{ flexDirection: "column", gap: 1 }}>
        <text fg="#f8fafc">{heading}</text>
        <text fg="#94a3b8">{supportingText}</text>
      </box>

      <box style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <text fg="#38bdf8">{fileCount} files ready for review</text>
        <text fg="#64748b">Updated {lastUpdated}</text>
      </box>

      <button label={reviewButtonLabel(fileCount)} onPress={onReview} />
    </box>
  );
}
