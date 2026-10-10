"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { LogoMark } from "@workhouse/ui";
import Link from "next/link";

/** The Studio's mark (and its name, when the rail is expanded), linking home. */
export function RailBrand({ expanded }: { expanded: boolean }) {
  return (
    <Box
      component={Link}
      href="/notebooks"
      aria-label="Workhouse Studio home"
      sx={{ display: "flex", alignItems: "center", height: 40, minWidth: 0, mb: 0.5, color: "text.primary", textDecoration: "none" }}
    >
      {/* the same 40px column as the icons of the rows below, so the marks line up */}
      <Box sx={{ width: 40, height: 40, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <LogoMark size={28} />
      </Box>
      {expanded && (
        <Typography noWrap sx={{ minWidth: 0, fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em" }}>
          Workhouse
          <Box component="span" sx={{ ml: 0.75, color: "secondary.main", fontSize: 11, fontWeight: 600 }}>
            Studio
          </Box>
        </Typography>
      )}
    </Box>
  );
}
