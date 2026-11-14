"use client";

import Box from "@mui/material/Box";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";

/** A number with its label, as the Data section's table header shows them. */
export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ minWidth: 64 }}>
      <Typography variant="overline" sx={{ color: "text.disabled", fontSize: 10, lineHeight: 1.6, display: "block" }}>
        {label}
      </Typography>
      <Typography sx={{ fontWeight: 700, fontSize: 18, lineHeight: 1.4 }}>{value}</Typography>
    </Box>
  );
}

/** A small upper-case label over a group of rows (as the workspace's "Notebooks"). */
export function Overline({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 3, pt: 2, pb: 0.5 }}>
      <Typography variant="overline" sx={{ color: "text.disabled", flex: 1, lineHeight: 1.6 }}>
        {children}
      </Typography>
      {action}
    </Box>
  );
}

/**
 * The top of a builder section, laid out like a table in the Data section: icon, title and subtitle,
 * numbers under them, actions on the right, and tabs under a divider.
 */
export function SectionHeader<T extends string>({
  icon,
  title,
  subtitle,
  stats,
  actions,
  tabs,
  tab,
  onTab,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  stats?: { label: string; value: string }[];
  actions?: ReactNode;
  tabs?: { value: T; label: ReactNode }[];
  tab?: T;
  onTab?(next: T): void;
}) {
  return (
    <Box sx={{ flexShrink: 0 }}>
      <Box sx={{ px: 3, pt: 2, pb: 1.5, display: "flex", gap: 2, alignItems: "flex-start", borderBottom: 1, borderColor: "divider" }}>
        <Box sx={{ color: "primary.main", mt: 0.5, display: "flex" }}>{icon}</Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h3" noWrap>
            {title}
          </Typography>
          {subtitle && (
            <Typography variant="body2" sx={{ color: "text.secondary", fontSize: 12.5 }}>
              {subtitle}
            </Typography>
          )}
          {stats && stats.length > 0 && (
            <Box sx={{ display: "flex", gap: 4, mt: 1.5, flexWrap: "wrap" }}>
              {stats.map((s) => (
                <Stat key={s.label} label={s.label} value={s.value} />
              ))}
            </Box>
          )}
        </Box>
        {actions && <Box sx={{ display: "flex", gap: 0.5, alignItems: "center" }}>{actions}</Box>}
      </Box>
      {tabs && tab !== undefined && (
        <Tabs
          value={tab}
          onChange={(_, v: T) => onTab?.(v)}
          sx={{ px: 2, minHeight: 38, borderBottom: 1, borderColor: "divider", "& .MuiTab-root": { minHeight: 38, py: 0, fontSize: 13 } }}
        >
          {tabs.map((x) => (
            <Tab key={x.value} value={x.value} label={x.label} />
          ))}
        </Tabs>
      )}
    </Box>
  );
}

/** A section: its header fixed, its body scrolling under it. */
export function SectionLayout({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {header}
      <Box sx={{ flex: 1, minHeight: 0, overflow: "auto" }}>{children}</Box>
    </Box>
  );
}
