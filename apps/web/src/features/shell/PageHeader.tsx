import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 2, px: 3, minHeight: 64, borderBottom: 1, borderColor: "divider", bgcolor: "background.paper", flexShrink: 0 }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="h2" noWrap>
          {title}
        </Typography>
        {subtitle && (
          <Typography variant="body2" sx={{ color: "text.secondary" }} noWrap>
            {subtitle}
          </Typography>
        )}
      </Box>
      {actions}
    </Box>
  );
}

export function PageBody({ children, padded = true }: { children: ReactNode; padded?: boolean }) {
  return <Box sx={{ flex: 1, overflow: "auto", p: padded ? 3 : 0, minHeight: 0 }}>{children}</Box>;
}

export function ErrorState({ title, message }: { title: string; message: string }) {
  return (
    <Box sx={{ p: 4 }}>
      <Typography variant="h3" sx={{ mb: 1 }}>
        {title}
      </Typography>
      <Typography variant="mono" component="pre" sx={{ whiteSpace: "pre-wrap", color: "error.main" }}>
        {message}
      </Typography>
    </Box>
  );
}
