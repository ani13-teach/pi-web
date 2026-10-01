import type { CSSProperties } from "react";
import { formatModelLabel } from "@/lib/model-label";

/** A model's display name and channel, without changing its stored identity. */
export function ModelLabel({ name, provider, style }: {
  name: string;
  provider?: string | null;
  style?: CSSProperties;
}) {
  return (
    <span
      title={formatModelLabel(name, provider)}
      style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...style }}
    >
      {name}
      {provider && <span style={{ marginLeft: 8, color: "var(--text-dim)", fontSize: 10, fontWeight: 400 }}>({provider})</span>}
    </span>
  );
}
