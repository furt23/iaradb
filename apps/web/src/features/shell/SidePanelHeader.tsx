import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";

/** The top of a side panel: what it shows, and its actions. */
export function SidePanelHeader({ overline, title, actions }: { overline: string; title: ReactNode; actions?: ReactNode }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", px: 1.5, height: 48, gap: 0.5, borderBottom: 1, borderColor: "divider", flexShrink: 0 }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="overline" sx={{ color: "text.disabled", lineHeight: 1.2, display: "block", fontSize: 10 }}>
          {overline}
        </Typography>
        <Typography noWrap sx={{ fontWeight: 650, fontSize: 14 }}>
          {title}
        </Typography>
      </Box>
      {actions}
    </Box>
  );
}
