type ChangeSummaryCardProps = {
  title: string;
  note: string;
  changes: number;
  lastSynced: string;
  onOpen: () => void;
};

export function ChangeSummaryCard({
  title,
  note,
  changes,
  lastSynced,
  onOpen,
}: ChangeSummaryCardProps) {
  return (
    <box
      style={{
        padding: 2,
        border: true,
        borderColor: "#334155",
        backgroundColor: "#0f172a",
        flexDirection: "column",
      }}
    >
      <box style={{ flexDirection: "column", gap: 0 }}>
        <text fg="#f8fafc">{title}</text>
        <text fg="#94a3b8">{note}</text>
      </box>

      <box style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 1 }}>
        <text fg="#38bdf8">{changes} files changed</text>
        <text fg="#64748b">Synced {lastSynced}</text>
      </box>

      <button label="Open diff" onPress={onOpen} />
    </box>
  );
}
